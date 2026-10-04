const { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');
const { scanProjectFolder, writeExportDirectory } = require('./project-files.cjs');

const configPath = () => path.join(app.getPath('userData'), 'desktop-config.json');
const tokenPath = () => path.join(app.getPath('userData'), 'auth-token.bin');
const defaultConfigPath = () => path.join(__dirname, 'setup', 'default-config.json');
let mainWindow = null;
let trustedOrigin = null;
let projectWatcher = null;
let watcherTimer = null;
let updateCheckInProgress = false;
let updateAvailable = false;
let setupConnectionError = null;

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function parseServerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a complete AURA service URL, such as https://app.example.com.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol !== 'https:' && !isLoopback(url.hostname))) {
    throw new Error('AURA service URLs must use HTTPS. HTTP is permitted only for localhost development.');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('The service URL cannot contain credentials, a query, or a fragment.');
  return url.origin;
}

async function verifyAuraService(serverUrl) {
  let response;
  try {
    response = await fetch(`${serverUrl}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
  } catch {
    throw new Error(`Cannot reach the AURA API at ${serverUrl}. Confirm the service is running and use its API server port.`);
  }
  if (!response.ok) throw new Error(`AURA API health check failed at ${serverUrl} (${response.status}).`);
  let health;
  try {
    health = await response.json();
  } catch {
    throw new Error(`The address ${serverUrl} served a web page, not the AURA API. Enter the API server address, not a static website port.`);
  }
  if (!health.ok || health.service !== 'AURA SILICON API') {
    throw new Error(`The service at ${serverUrl} did not identify itself as the AURA SILICON API.`);
  }
}

async function readConfig() {
  try {
    const config = JSON.parse(await fs.readFile(configPath(), 'utf8'));
    return { serverUrl: parseServerUrl(config.serverUrl), updateFeedUrl: config.updateFeedUrl ? parseServerUrl(config.updateFeedUrl) : null };
  } catch (error) {
    if (error.code === 'ENOENT') return { serverUrl: null, updateFeedUrl: null };
    throw new Error('The saved desktop connection settings could not be read. Reconfigure the AURA service address.');
  }
}

async function readDefaultServerUrl() {
  try {
    const config = JSON.parse(await fs.readFile(defaultConfigPath(), 'utf8'));
    return config.serverUrl ? parseServerUrl(config.serverUrl) : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('The desktop default server configuration could not be read.');
  }
}

async function writeConfig(config) {
  const safeConfig = {
    serverUrl: config.serverUrl ? parseServerUrl(config.serverUrl) : null,
    updateFeedUrl: config.updateFeedUrl ? parseServerUrl(config.updateFeedUrl) : null
  };
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const temporaryPath = `${configPath()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(safeConfig), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, configPath());
}

function trustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Untrusted desktop request was rejected.');
  const frameUrl = event.senderFrame?.url;
  if (!frameUrl) throw new Error('Desktop request has no trusted frame.');
  if (trustedOrigin) {
    if (new URL(frameUrl).origin !== trustedOrigin) throw new Error('Desktop request origin is not trusted.');
  } else if (frameUrl !== pathToFileURL(path.join(__dirname, 'setup', 'index.html')).href) {
    throw new Error('Desktop setup request origin is not trusted.');
  }
}

function registerIpcHandlers() {
  ipcMain.handle('aura:setup-server', async (event, { url, updateFeedUrl }) => {
    trustedSender(event);
    const serverUrl = parseServerUrl(url);
    const updateFeed = updateFeedUrl ? parseServerUrl(updateFeedUrl) : null;
    await verifyAuraService(serverUrl);
    await writeConfig({ serverUrl, updateFeedUrl: updateFeed });
    trustedOrigin = serverUrl;
    setupConnectionError = null;
    await mainWindow.loadURL(`${serverUrl}/login`);
    return { connected: true, serverUrl };
  });

  ipcMain.handle('aura:setup:current-url', async (event) => {
    trustedSender(event);
    const config = await readConfig();
    return {
      serverUrl: process.env.AURA_WEB_URL
        ? parseServerUrl(process.env.AURA_WEB_URL)
        : config.serverUrl || await readDefaultServerUrl(),
      updateFeedUrl: config.updateFeedUrl,
      connectionError: setupConnectionError
    };
  });

  ipcMain.handle('aura:auth-token:get', async (event) => {
    trustedSender(event);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure token storage is unavailable on this device. Check that the operating-system keychain or secret service is available.');
    try {
      const encrypted = await fs.readFile(tokenPath());
      return safeStorage.decryptString(encrypted);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('The saved sign-in token could not be read securely. Sign in again.');
    }
  });

  ipcMain.handle('aura:auth-token:set', async (event, token) => {
    trustedSender(event);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure token storage is unavailable on this device. Check that the operating-system keychain or secret service is available.');
    if (typeof token !== 'string' || token.length < 20 || token.length > 8192) throw new Error('Invalid session token.');
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    const temporaryPath = `${tokenPath()}.tmp`;
    await fs.writeFile(temporaryPath, safeStorage.encryptString(token), { mode: 0o600 });
    await fs.rename(temporaryPath, tokenPath());
  });

  ipcMain.handle('aura:auth-token:clear', async (event) => {
    trustedSender(event);
    await fs.rm(tokenPath(), { force: true });
  });

  ipcMain.handle('aura:project:select', async (event) => {
    trustedSender(event);
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: 'Open hardware project folder',
      properties: ['openDirectory']
    });
    if (choice.canceled || !choice.filePaths[0]) return { cancelled: true };
    const selected = await scanProjectFolder(choice.filePaths[0]);
    if (projectWatcher) projectWatcher.close();
    if (watcherTimer) clearTimeout(watcherTimer);
    let watchAvailable = true;
    try {
      projectWatcher = require('node:fs').watch(choice.filePaths[0], { recursive: true }, (_eventType, fileName) => {
        if (!fileName || ['node_modules', '.git', 'build', 'dist', 'out'].some((part) => String(fileName).split(/[\\/]/).includes(part))) return;
        if (watcherTimer) clearTimeout(watcherTimer);
        watcherTimer = setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('aura:project:changed', String(fileName));
        }, 300);
      });
    } catch {
      watchAvailable = false;
      projectWatcher = null;
    }
    return { ...selected, cancelled: false, watchAvailable };
  });

  ipcMain.handle('aura:project:export-copy', async (event, { projectName, files }) => {
    trustedSender(event);
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an export destination',
      properties: ['openDirectory', 'createDirectory']
    });
    if (choice.canceled || !choice.filePaths[0]) return { cancelled: true };
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Export AURA copy', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Create a new exported copy of this AURA project?',
      detail: `A new folder will be created in:\n${choice.filePaths[0]}\n\nThe original project folder will not be modified.`
    });
    if (confirmation.response !== 0) return { cancelled: true };
    const exportPath = await writeExportDirectory(choice.filePaths[0], projectName, files);
    return { cancelled: false, path: exportPath };
  });

  ipcMain.handle('aura:updates:check', async (event) => {
    trustedSender(event);
    if (!app.isPackaged) return { available: false, message: 'Automatic updates are available only in a packaged desktop release.' };
    const config = await readConfig();
    if (!config.updateFeedUrl) return { available: false, message: 'Automatic updates are not configured for this release.' };
    if (updateCheckInProgress) return { available: false, message: 'An update check is already running.' };
    try {
      updateCheckInProgress = true;
      autoUpdater.setFeedURL({ provider: 'generic', url: `${config.updateFeedUrl.replace(/\/+$/, '')}/` });
      autoUpdater.autoDownload = false;
      const result = await autoUpdater.checkForUpdates();
      updateAvailable = Boolean(result?.updateInfo);
      return { available: updateAvailable, version: result?.updateInfo?.version || null };
    } catch {
      throw new Error('Could not check for desktop updates. The release feed may be temporarily unavailable.');
    } finally {
      updateCheckInProgress = false;
    }
  });

  ipcMain.handle('aura:updates:download', async (event) => {
    trustedSender(event);
    if (!app.isPackaged || !updateAvailable) throw new Error('Check for an available packaged update before downloading.');
    try {
      await autoUpdater.downloadUpdate();
      return { downloaded: true, verified: true };
    } catch {
      throw new Error('The update download or integrity verification failed. The installed version was not replaced.');
    }
  });

  ipcMain.handle('aura:updates:install', async (event) => {
    trustedSender(event);
    if (!app.isPackaged || !updateAvailable) throw new Error('No verified update is ready to install.');
    autoUpdater.quitAndInstall();
  });

  ipcMain.handle('aura:notification', async (event, { title, body }) => {
    trustedSender(event);
    if (!Notification.isSupported()) return { shown: false };
    if (typeof title !== 'string' || typeof body !== 'string') throw new Error('Notification title and message are required.');
    new Notification({ title: title.slice(0, 120), body: body.slice(0, 500) }).show();
    return { shown: true };
  });
}

async function openServiceOrSetupWindow() {
  const savedConfig = await readConfig();
  const serverUrl = process.env.AURA_WEB_URL
    ? parseServerUrl(process.env.AURA_WEB_URL)
    : savedConfig.serverUrl || await readDefaultServerUrl();
  trustedOrigin = null;
  if (serverUrl) {
    try {
      await verifyAuraService(serverUrl);
      trustedOrigin = serverUrl;
      let hasSession = false;
      if (safeStorage.isEncryptionAvailable()) {
        try {
          const encryptedToken = await fs.readFile(tokenPath());
          safeStorage.decryptString(encryptedToken);
          hasSession = true;
        } catch (error) {
          if (error.code !== 'ENOENT') await fs.rm(tokenPath(), { force: true });
        }
      }
      await mainWindow.loadURL(`${serverUrl}/${hasSession ? 'workspace' : 'login'}`);
      return;
    } catch (error) {
      setupConnectionError = error.message;
    }
  }
  await mainWindow.loadFile(path.join(__dirname, 'setup', 'index.html'));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#070a0f',
    title: 'AURA SILICON',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    const isSetup = target === pathToFileURL(path.join(__dirname, 'setup', 'index.html')).href;
    let sameOrigin = false;
    try { sameOrigin = trustedOrigin && new URL(target).origin === trustedOrigin; } catch {}
    if (!isSetup && !sameOrigin) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    if (projectWatcher) projectWatcher.close();
    projectWatcher = null;
    if (watcherTimer) clearTimeout(watcherTimer);
    mainWindow = null;
  });
  openServiceOrSetupWindow().catch((error) => {
    dialog.showErrorBox('AURA SILICON could not start', error.message);
    app.quit();
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.aurasilicon.desktop');
  nativeTheme.themeSource = 'dark';
  const permissionSession = require('electron').session.defaultSession;
  permissionSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  registerIpcHandlers();
  if (app.isPackaged) {
    autoUpdater.autoDownload = false;
    autoUpdater.on('update-available', () => { updateAvailable = true; });
    autoUpdater.on('update-not-available', () => { updateAvailable = false; });
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

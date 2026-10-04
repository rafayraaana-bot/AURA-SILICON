const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('auraDesktop', Object.freeze({
  version: process.env.AURA_DESKTOP_VERSION || '0.1.0',
  setupServer: (settings) => ipcRenderer.invoke('aura:setup-server', settings),
  getConfiguredServerUrl: () => ipcRenderer.invoke('aura:setup:current-url'),
  getAuthToken: () => ipcRenderer.invoke('aura:auth-token:get'),
  setAuthToken: (token) => ipcRenderer.invoke('aura:auth-token:set', token),
  clearAuthToken: () => ipcRenderer.invoke('aura:auth-token:clear'),
  selectProjectFolder: () => ipcRenderer.invoke('aura:project:select'),
  exportProjectCopy: (project) => ipcRenderer.invoke('aura:project:export-copy', project),
  checkForUpdates: () => ipcRenderer.invoke('aura:updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('aura:updates:download'),
  installUpdate: () => ipcRenderer.invoke('aura:updates:install'),
  showNotification: (notification) => ipcRenderer.invoke('aura:notification', notification),
  onProjectChanged: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('A project-change callback is required.');
    const listener = (_event, fileName) => callback(fileName);
    ipcRenderer.on('aura:project:changed', listener);
    return () => ipcRenderer.removeListener('aura:project:changed', listener);
  }
}));

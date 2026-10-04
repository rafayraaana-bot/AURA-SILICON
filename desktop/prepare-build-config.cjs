const fs = require('node:fs');
const path = require('node:path');

function readDotEnvValue(filePath, key) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const line = contents.split(/\r?\n/).find((entry) => {
    const match = entry.match(/^\s*(?:export\s+)?([^=]+)\s*=/);
    return match?.[1]?.trim() === key;
  });
  if (!line) return null;

  let value = line.slice(line.indexOf('=') + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, '').trim();
  }
  return value || null;
}

function normalizeServerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Configure AURA_DESKTOP_DEFAULT_SERVER_URL or AURA_PUBLIC_URL before building the desktop app.');
  }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) ||
      url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('The desktop default server URL must be HTTPS (HTTP is allowed only for localhost) and contain no path, credentials, query, or fragment.');
  }
  return url.origin;
}

const envPath = path.resolve(__dirname, '..', '.env');
const configuredUrl = process.env.AURA_DESKTOP_DEFAULT_SERVER_URL ||
  process.env.AURA_PUBLIC_URL ||
  readDotEnvValue(envPath, 'AURA_DESKTOP_DEFAULT_SERVER_URL') ||
  readDotEnvValue(envPath, 'AURA_PUBLIC_URL');

if (!configuredUrl) {
  throw new Error('Configure AURA_DESKTOP_DEFAULT_SERVER_URL or AURA_PUBLIC_URL before building the desktop app.');
}

const outputPath = path.join(__dirname, 'setup', 'default-config.json');
fs.writeFileSync(outputPath, JSON.stringify({ serverUrl: normalizeServerUrl(configuredUrl) }, null, 2));

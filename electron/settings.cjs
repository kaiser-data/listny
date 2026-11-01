const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  hotkey: 'Alt+Space',
  language: '',
  stt: {
    provider: 'openai',
    models: {
      openai: 'gpt-4o-mini-transcribe',
      groq: 'whisper-large-v3-turbo',
      elevenlabs: 'scribe_v1',
    },
  },
  cleanup: {
    enabled: false,
    provider: 'openai',
    models: {
      openai: 'gpt-4.1-mini',
      groq: 'llama-3.3-70b-versatile',
    },
  },
  pasteIntoActiveApp: true,
  restoreClipboard: true,
  muteWhileDictating: true,
  launchAtLogin: false,
};

const PROVIDERS = ['openai', 'groq', 'elevenlabs'];

const file = () => path.join(app.getPath('userData'), 'settings.json');
const historyFile = () => path.join(app.getPath('userData'), 'history.json');

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// Listny is the only writer of these files, so keep them in memory instead of
// re-reading from disk on every hotkey press and tray refresh.
const cache = new Map();
function read(p, fallback) {
  if (!cache.has(p)) cache.set(p, readJson(p, fallback));
  return cache.get(p);
}
function write(p, data) {
  writeJson(p, data);
  cache.set(p, data);
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v;
  }
  return out;
}

function load() {
  const raw = read(file(), {});
  return { ...merge(DEFAULTS, raw), keys: raw.keys || {} };
}

// API keys are encrypted with the OS keychain via safeStorage and never sent to a renderer.
function getKey(provider) {
  const enc = load().keys[provider];
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return '';
  }
}

function setKey(provider, value) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider: ${provider}`);
  const raw = read(file(), {});
  const keys = { ...raw.keys };
  if (value) keys[provider] = safeStorage.encryptString(value).toString('base64');
  else delete keys[provider];
  write(file(), { ...raw, keys });
}

// The shape a renderer sees: settings without key material, plus which keys are usable.
// A key counts only if it decrypts, so one saved by another build (different keychain
// entry) shows as missing instead of failing later with a confusing auth error.
function publicSettings() {
  const { keys, ...rest } = load();
  return { ...rest, hasKey: Object.fromEntries(PROVIDERS.map((p) => [p, Boolean(getKey(p))])) };
}

function save(patch) {
  const raw = read(file(), {});
  const { keys, hasKey, hotkeyError, canLaunchAtLogin, ...clean } = patch;
  write(file(), { ...merge(raw, clean), keys: raw.keys || {} });
}

function history() {
  return read(historyFile(), []);
}

function addHistory(entry) {
  write(historyFile(), [entry, ...history()].slice(0, 200));
}

function clearHistory() {
  write(historyFile(), []);
}

module.exports = { load, save, getKey, setKey, publicSettings, history, addHistory, clearHistory, PROVIDERS };

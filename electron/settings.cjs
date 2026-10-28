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

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v;
  }
  return out;
}

function load() {
  const raw = readJson(file(), {});
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
  const raw = readJson(file(), {});
  raw.keys = raw.keys || {};
  if (value) raw.keys[provider] = safeStorage.encryptString(value).toString('base64');
  else delete raw.keys[provider];
  writeJson(file(), raw);
}

// The shape a renderer sees: settings without key material, plus which keys are set.
function publicSettings() {
  const { keys, ...rest } = load();
  return { ...rest, hasKey: Object.fromEntries(PROVIDERS.map((p) => [p, Boolean(keys[p])])) };
}

function save(patch) {
  const raw = readJson(file(), {});
  const { keys, hasKey, ...clean } = patch;
  writeJson(file(), { ...merge(raw, clean), keys: raw.keys || {} });
}

function history() {
  return readJson(historyFile(), []);
}

function addHistory(entry) {
  writeJson(historyFile(), [entry, ...history()].slice(0, 200));
}

function clearHistory() {
  writeJson(historyFile(), []);
}

module.exports = { load, save, getKey, setKey, publicSettings, history, addHistory, clearHistory, PROVIDERS };

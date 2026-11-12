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
    // Live word-by-word model, used with ElevenLabs while Rests is on.
    liveModel: 'scribe_v3_live',
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
  // Rests & Lyrics: transcribe at the speaker's pauses while they talk and show the words live.
  rests: true,
  // Type each piece into the focused field as soon as it is transcribed (off while AI cleanup is on).
  livePaste: true,
  launchAtLogin: false,
};

const PROVIDERS = ['openai', 'groq', 'elevenlabs'];
// Each provider has a main key and an optional backup key (e.g. a second account),
// used when the main one is out of credits or rejected.
const backupSlot = (provider) => `${provider}:backup`;
const KEY_SLOTS = PROVIDERS.flatMap((p) => [p, backupSlot(p)]);

const file = () => path.join(app.getPath('userData'), 'settings.json');
const historyFile = () => path.join(app.getPath('userData'), 'history.json');
const recordingsDir = () => path.join(app.getPath('userData'), 'recordings');

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
// Decrypted keys, kept in memory. The first keychain access after launch can take 10 s or more,
// and the synchronous call blocks the whole main process (no pill, dead hotkey) for that long,
// so keys are decrypted asynchronously at startup (loadKeys) and read from here afterwards.
const plain = new Map();

let loading = null;
const loadKeys = () => (loading ||= decryptAll());
async function decryptAll() {
  for (const [slot, enc] of Object.entries(load().keys)) {
    if (plain.has(slot)) continue;
    try {
      plain.set(slot, (await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'))).result);
    } catch {
      plain.set(slot, '');
    }
  }
}

const hasStoredKey = () => Object.keys(load().keys).length > 0;

function readSlot(slot) {
  if (plain.has(slot)) return plain.get(slot);
  const enc = load().keys[slot];
  if (!enc) return '';
  try {
    plain.set(slot, safeStorage.decryptString(Buffer.from(enc, 'base64'))); // only before loadKeys is done
  } catch {
    plain.set(slot, '');
  }
  return plain.get(slot);
}

// All usable keys for a provider as { slot, key }. The slot that worked last comes first and is
// remembered in settings.json, so a restart doesn't go back to an account that is out of credits.
function getKeys(provider) {
  const preferred = load().preferredKey?.[provider];
  return [provider, backupSlot(provider)]
    .sort((a, b) => (b === preferred) - (a === preferred))
    .map((slot) => ({ slot, key: readSlot(slot) }))
    .filter((k) => k.key);
}
const getKey = (provider) => getKeys(provider)[0]?.key || '';

function preferKey(provider, slot) {
  if (load().preferredKey?.[provider] === slot) return;
  const raw = read(file(), {});
  write(file(), { ...raw, preferredKey: { ...raw.preferredKey, [provider]: slot } });
}

function setKey(slot, value) {
  if (!KEY_SLOTS.includes(slot)) throw new Error(`Unknown key slot: ${slot}`);
  const raw = read(file(), {});
  const keys = { ...raw.keys };
  if (value) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The macOS keychain is not available, so the key could not be saved.');
    try {
      keys[slot] = safeStorage.encryptString(value).toString('base64');
    } catch (err) {
      throw new Error(`The key could not be saved to the macOS keychain: ${err.message}`);
    }
  } else delete keys[slot];
  write(file(), { ...raw, keys });
  plain.set(slot, value || '');
}

// The shape a renderer sees: settings without key material, plus which keys are usable.
// A key counts only if it decrypts, so one saved by another build (different keychain
// entry) shows as missing instead of failing later with a confusing auth error.
function publicSettings() {
  const { keys, ...rest } = load();
  return {
    ...rest,
    hasKey: Object.fromEntries(PROVIDERS.map((p) => [p, Boolean(getKey(p))])),
    keySlots: Object.fromEntries(KEY_SLOTS.map((s) => [s, Boolean(readSlot(s))])),
  };
}

function save(patch) {
  const raw = read(file(), {});
  const { keys, hasKey, keySlots, preferredKey, hotkeyError, canLaunchAtLogin, ...clean } = patch;
  write(file(), { ...merge(raw, clean), keys: raw.keys || {} });
}

function history() {
  return read(historyFile(), []);
}

function addHistory(entry) {
  const all = [entry, ...history()];
  for (const old of all.slice(200)) if (old.audioFile) deleteRecording(old.audioFile);
  write(historyFile(), all.slice(0, 200));
}

function updateHistory(id, patch) {
  write(historyFile(), history().map((h) => (h.id === id ? { ...h, ...patch } : h)));
}

function clearHistory() {
  write(historyFile(), []);
  fs.rmSync(recordingsDir(), { recursive: true, force: true });
}

// Audio of failed dictations, kept so they can be retried instead of lost.
function saveRecording(id, audio, mimeType) {
  const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  const name = `${id}.${ext}`;
  fs.mkdirSync(recordingsDir(), { recursive: true });
  fs.writeFileSync(path.join(recordingsDir(), name), audio, { mode: 0o600 });
  return name;
}

const readRecording = (name) => fs.readFileSync(path.join(recordingsDir(), path.basename(name)));
const deleteRecording = (name) => fs.rmSync(path.join(recordingsDir(), path.basename(name)), { force: true });

module.exports = {
  load,
  loadKeys,
  hasStoredKey,
  save,
  getKey,
  getKeys,
  preferKey,
  setKey,
  publicSettings,
  history,
  addHistory,
  updateHistory,
  clearHistory,
  saveRecording,
  readRecording,
  deleteRecording,
  PROVIDERS,
  KEY_SLOTS,
};

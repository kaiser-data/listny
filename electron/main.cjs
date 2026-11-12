const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  systemPreferences,
  clipboard,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const settings = require('./settings.cjs');
const { transcribeWithKeys, cleanup } = require('./transcribe.cjs');
const { insertText, pasteChunk, canPaste } = require('./paste.cjs');
const { separator, ending, joinPieces } = require('./pieces.cjs');
const { muteSystemAudio, restoreSystemAudio, restoreSystemAudioSync } = require('./audio.cjs');

const DIST = path.join(__dirname, '..', 'dist');
// Room above the pill for the live words (Lyrics); the window is transparent and ignores the mouse.
const PILL_SIZE = { width: 560, height: 150 };

// One line per event in ~/Library/Logs/Listny/main.log, so a failed or stuck dictation can be traced afterwards.
// Never logs dictated text or key material.
let logFile = '';
function log(...parts) {
  try {
    if (!logFile) {
      logFile = path.join(app.getPath('logs'), 'main.log');
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1_000_000) fs.renameSync(logFile, `${logFile}.old`);
    }
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${parts.join(' ')}\n`);
  } catch {
    // logging must never break dictation
  }
}
process.on('uncaughtException', (err) => log('uncaughtException', err.stack || err.message));
process.on('unhandledRejection', (err) => log('unhandledRejection', err?.stack || String(err)));

let pill = null;
let hub = null;
let tray = null;
let state = 'idle'; // idle | recording | processing
let hotkeyError = '';
let hotkeyPaused = false; // while the hub captures a new shortcut, the old one must not fire

// True once the pill page has attached its listeners. A 'rec:start' sent earlier would be lost
// and leave Listny stuck in "recording" with an empty pill.
let pillReady = false;

function createPill() {
  pillReady = false;
  pill = new BrowserWindow({
    ...PILL_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    // A non-activating panel so the app you're dictating into keeps keyboard focus.
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    // The pill is hidden most of the time; it must still load and react at full speed.
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  pill.setAlwaysOnTop(true, 'screen-saver');
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pill.setIgnoreMouseEvents(true);
  pill.loadFile(path.join(DIST, 'pill.html'));
  pill.webContents.on('did-finish-load', () => log('pill loaded'));
  pill.webContents.on('did-fail-load', (_e, code, desc) => log('pill failed to load', code, desc));
  pill.webContents.on('render-process-gone', (_e, details) => {
    log('pill renderer gone', details.reason);
    setState('idle');
    pill.destroy();
    createPill();
  });
  pill.webContents.on('console-message', (e) => e.level === 'error' && log('pill console error', e.message));
}

function showPill() {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  pill.setPosition(
    Math.round(workArea.x + (workArea.width - PILL_SIZE.width) / 2),
    Math.round(workArea.y + workArea.height - PILL_SIZE.height - 24)
  );
  pill.showInactive();
}

function openHub() {
  if (hub && !hub.isDestroyed()) return hub.show(), hub.focus();
  hub = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 560,
    minHeight: 480,
    title: 'Listny',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1012',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  hub.loadFile(path.join(DIST, 'hub.html'));
  hub.on('closed', () => {
    if (!hotkeyPaused) return;
    hotkeyPaused = false; // window closed mid-capture: bring the shortcut back
    registerHotkey();
  });
  app.focus({ steal: true });
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: 'Listny', body }).show();
}

// A dictation that never finishes (recorder never started, renderer hung) would leave the hotkey dead,
// so any non-idle state is forced back to idle after a generous deadline.
const STUCK_AFTER_MS = { recording: 30 * 60_000, processing: 4 * 60_000 };
let stuckTimer = null;

function setState(next) {
  if (state !== next) log('state', state, '->', next);
  clearTimeout(stuckTimer);
  if (next !== 'idle') {
    stuckTimer = setTimeout(() => {
      log('stuck in', next, '- resetting');
      if (next === 'recording') pill.webContents.send('rec:cancel');
      setState('idle');
      pill.hide();
      notify('Listny got stuck and was reset. Try the dictation again.');
    }, STUCK_AFTER_MS[next]);
  }
  state = next;
  updateTray();
  // Music and videos go quiet while you talk and come back the moment you stop (or cancel).
  if (next === 'recording') {
    if (settings.load().muteWhileDictating) muteSystemAudio();
  } else restoreSystemAudio();
  // Esc cancels only while a dictation is active, so it isn't swallowed system-wide.
  if (next === 'recording') globalShortcut.register('Escape', cancelRecording);
  else if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape');
}

function toggleRecording() {
  log('hotkey pressed, state', state, pillReady ? '' : '(pill not ready yet)');
  if (state === 'idle') {
    live = startLive();
    setState('recording');
    showPill();
    // If the pill page is still loading, 'pill:ready' starts the recording as soon as it can listen.
    if (pillReady) pill.webContents.send('rec:start');
  } else if (state === 'recording') {
    setState('processing');
    pill.webContents.send('rec:stop');
  }
}

function cancelRecording() {
  if (state !== 'recording') return;
  if (live) {
    live.stopped = true; // pieces still in flight are not typed; what is already typed stays
    const session = live;
    pieceQueue.then(() => restoreLiveClipboard(session));
  }
  pill.webContents.send('rec:cancel');
  setState('idle');
  pill.hide();
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  if (hotkeyPaused) return;
  const { hotkey } = settings.load();
  hotkeyError = '';
  try {
    if (!globalShortcut.register(hotkey, toggleRecording)) {
      hotkeyError = `"${hotkey}" is already used by another app. Pick a different shortcut.`;
    }
  } catch {
    hotkeyError = `"${hotkey}" is not a valid shortcut.`;
  }
  log('hotkey', hotkey, hotkeyError ? `NOT registered: ${hotkeyError}` : 'registered');
  if (hotkeyError) notify(hotkeyError);
  updateTray();
}

// Speech-to-text with the provider's keys, shared by whole recordings, Rests pieces and retries.
async function speechToText(audio, mimeType) {
  const cfg = settings.load();
  const provider = cfg.stt.provider;
  return transcribeWithKeys(
    settings.getKeys(provider), // the key that worked last comes first
    { provider, model: cfg.stt.models[provider], audio, mimeType, language: cfg.language },
    {
      onKeyFailed: (slot, err) => log('transcription failed with key', slot, 'status', err.status || '-', err.message.slice(0, 200)),
      onKeyWorked: (slot) => {
        settings.preferKey(provider, slot); // persisted, so the next session starts on this key
        log('transcribed with key', slot);
      },
    }
  );
}

// Speech-to-text plus optional cleanup. `transcript` is passed when Rests already transcribed the
// pieces during the dictation; otherwise the whole recording is sent.
async function toText(audio, mimeType, transcript) {
  const cfg = settings.load();
  const provider = cfg.stt.provider;
  const raw = transcript || (await speechToText(audio, mimeType));
  if (!raw || !cfg.cleanup.enabled) return { provider, raw, text: raw };
  const cp = cfg.cleanup.provider;
  const text = await cleanup({ provider: cp, model: cfg.cleanup.models[cp], apiKey: settings.getKey(cp), text: raw });
  return { provider, raw, text };
}

// Live typing: each Rests piece is pasted into the focused field as soon as it is transcribed.
// Only when the text is final as transcribed: AI cleanup needs the whole text, so it turns this off.
let live = null;
function startLive() {
  const cfg = settings.load();
  if (!cfg.rests || !cfg.livePaste || !cfg.pasteIntoActiveApp || cfg.cleanup.enabled || !canPaste()) return null;
  return { clipboard: clipboard.readText(), typed: [], last: '', stopped: false, failed: false };
}

async function typePiece(session, text) {
  if (!text) return;
  const chunk = separator(session.last, text) + text;
  try {
    await pasteChunk(chunk);
    session.typed.push(text);
    session.last = text;
    session.lastChunk = chunk;
  } catch (err) {
    session.failed = true;
    log('live paste failed:', err.message.slice(0, 200));
  }
}

// Ends live typing: closes the last sentence and gives the user their clipboard back.
async function endLive(session) {
  const end = ending(session.last);
  if (end) {
    try {
      await pasteChunk(end);
      session.lastChunk = end;
    } catch {}
  }
  restoreLiveClipboard(session);
}

// Puts the user's clipboard back once live typing is over (also after Esc or a failure),
// unless they copied something new in the meantime.
function restoreLiveClipboard(session) {
  if (!session?.lastChunk) return;
  const { lastChunk } = session;
  setTimeout(() => {
    if (clipboard.readText() === lastChunk) clipboard.writeText(session.clipboard);
  }, 1500);
}

// Rests: one piece of a running dictation, transcribed while the speaker goes on talking.
// Pieces go one at a time, so a free account's concurrency limit is never hit, and they are typed in order.
let pieceQueue = Promise.resolve();
function transcribePiece(_event, audio) {
  const session = live; // taken when the piece arrives, so a late piece never lands in the next dictation
  const run = async () => {
    const started = Date.now();
    try {
      const text = await speechToText(Buffer.from(audio), 'audio/wav');
      log('piece', `${Math.round(audio.byteLength / 32)}ms audio, ${Date.now() - started}ms to text`);
      if (session && !session.stopped && !session.failed) await typePiece(session, text.trim());
      return { text };
    } catch (err) {
      log('piece failed:', err.message.slice(0, 300));
      if (session) session.failed = true;
      return { error: err.message };
    }
  };
  pieceQueue = pieceQueue.then(run);
  return pieceQueue;
}

async function processAudio(_event, { audio, mimeType, durationMs, texts, waitedMs = 0 }) {
  const session = live;
  live = null;
  const transcript = texts ? joinPieces(texts) : '';
  const pieces = texts?.length;
  const cfg = settings.load();
  // The wait you notice starts when you stop talking: include the time the pill spent on the last piece.
  const started = Date.now() - waitedMs;
  const id = started.toString(36);
  const buf = Buffer.from(audio);
  try {
    const { provider, raw, text } = await toText(buf, mimeType, transcript);
    if (!raw) return { status: 'empty' };

    let result;
    const spoken = texts?.filter((t) => t.trim()).length;
    if (session?.typed.length && transcript && !session.failed && session.typed.length === spoken) {
      // Everything was already typed while you talked.
      await endLive(session);
      result = 'pasted';
    } else if (session?.typed.length) {
      // Part of it was typed before a piece failed; typing the rest could duplicate or garble it,
      // so the complete text goes to the clipboard instead.
      clipboard.writeText(text);
      notify('Part of the dictation could not be typed live. The complete text is on your clipboard.');
      result = 'copied';
    } else {
      result = await insertText(text, { paste: cfg.pasteIntoActiveApp, restoreClipboard: cfg.restoreClipboard, log });
    }
    const how = transcript ? `${pieces} pieces (Rests${session?.typed.length ? ', typed live' : ''})` : 'whole recording';
    log('dictation', id, result, `${durationMs}ms audio, ${Date.now() - started}ms to text, ${how}`);
    if (result === 'copied' && cfg.pasteIntoActiveApp && !session?.typed.length) {
      notify('Copied to clipboard. Allow Listny under Privacy & Security → Accessibility to paste automatically.');
    }
    settings.addHistory({
      id,
      at: new Date(started).toISOString(),
      raw,
      text,
      provider,
      result,
      durationMs,
      latencyMs: Date.now() - started,
    });
    hub?.webContents.send('history:changed');
    return { status: result, text };
  } catch (err) {
    settings.addHistory({
      id,
      at: new Date(started).toISOString(),
      raw: '',
      text: '',
      provider: cfg.stt.provider,
      result: 'failed',
      error: err.message,
      audioFile: settings.saveRecording(id, buf, mimeType),
      mimeType,
      durationMs,
    });
    hub?.webContents.send('history:changed');
    restoreLiveClipboard(session);
    log('dictation', id, 'failed:', err.message.slice(0, 300));
    notify(`${err.message}\nRecording saved — retry it from the Listny history.`);
    return { status: 'error', error: err.message };
  } finally {
    setState('idle');
    setTimeout(() => state === 'idle' && pill.hide(), 900);
  }
}

// Re-transcribes a saved recording with the current settings and copies the result.
async function retryRecording(_event, id) {
  const entry = settings.history().find((h) => h.id === id);
  if (!entry?.audioFile) return;
  try {
    const { provider, raw, text } = await toText(settings.readRecording(entry.audioFile), entry.mimeType);
    if (!raw) throw new Error('No speech found in this recording.');
    clipboard.writeText(text);
    settings.updateHistory(id, { provider, raw, text, result: 'copied', error: undefined, audioFile: undefined });
    settings.deleteRecording(entry.audioFile);
  } catch (err) {
    settings.updateHistory(id, { error: err.message });
  }
  updateTray();
  hub?.webContents.send('history:changed');
}

function applyLoginItem() {
  // Only a packaged app can register itself; in dev it would register the bare Electron binary.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: Boolean(settings.load().launchAtLogin) });
}

function saveSettings(patch) {
  settings.save(patch);
  registerHotkey();
  applyLoginItem();
  hub?.webContents.send('settings:changed');
}

const hubSettings = () => ({ ...settings.publicSettings(), hotkeyError, canLaunchAtLogin: app.isPackaged });

function trayIcon() {
  // 16x16 template microphone glyph, so the menu bar tints it for light/dark mode.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" fill="black"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" stroke="black" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>`;
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  img.setTemplateImage(true);
  return img;
}

function updateTray() {
  if (!tray) return;
  const { hotkey, muteWhileDictating } = settings.load();
  const last = settings.history()[0];
  tray.setToolTip(state === 'recording' ? 'Listny — listening' : 'Listny');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: hotkeyError || `Press ${hotkey} to dictate`, enabled: false },
      { label: state === 'recording' ? 'Stop dictation' : 'Start dictation', click: toggleRecording, enabled: state !== 'processing' },
      { label: 'Copy last transcript', enabled: Boolean(last?.text), click: () => last?.text && clipboard.writeText(last.text) },
      {
        label: 'Mute audio while dictating',
        type: 'checkbox',
        checked: muteWhileDictating,
        click: (item) => saveSettings({ muteWhileDictating: item.checked }),
      },
      { type: 'separator' },
      { label: 'Open Listny…', click: openHub },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ])
  );
}

ipcMain.handle('audio:process', processAudio);
ipcMain.handle('audio:piece', transcribePiece);
ipcMain.handle('pill:settings', () => ({ rests: settings.load().rests }));
ipcMain.on('pill:ready', () => {
  log('pill ready');
  pillReady = true;
  if (state === 'recording') pill.webContents.send('rec:start'); // hotkey was pressed while the pill was loading
});
ipcMain.on('rec:failed', (_e, message) => {
  log('microphone error:', message);
  notify(`Microphone error: ${message}`);
  setState('idle');
  pill.hide();
});
ipcMain.on('rec:discard', () => {
  log('recording discarded (too short or empty)');
  setState('idle');
  pill.hide();
});
ipcMain.handle('settings:get', hubSettings);
ipcMain.handle('settings:save', (_e, patch) => {
  saveSettings(patch);
  return hubSettings();
});
ipcMain.on('hotkey:capture', (_e, capturing) => {
  hotkeyPaused = Boolean(capturing);
  registerHotkey();
});
ipcMain.handle('key:set', (_e, { provider, value }) => {
  settings.setKey(provider, value.trim());
  return hubSettings();
});
ipcMain.handle('history:get', () => settings.history());
ipcMain.handle('history:retry', retryRecording);
ipcMain.handle('history:clear', () => {
  settings.clearHistory();
  updateTray();
});
ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(text));

// One Listny at a time: a second launch (e.g. the .app while `npm start` runs) just opens settings.
// Setup without the settings window: launching with LISTNY_KEY_<SLOT> set (e.g. LISTNY_KEY_ELEVENLABS,
// LISTNY_KEY_ELEVENLABS_BACKUP) stores those keys in the keychain-encrypted settings and exits.
function importKeysFromEnv() {
  let imported = 0;
  for (const slot of settings.KEY_SLOTS) {
    const value = (process.env[`LISTNY_KEY_${slot.replace(':', '_').toUpperCase()}`] || '').trim();
    if (!value) continue;
    settings.setKey(slot, value);
    imported += 1;
  }
  return imported;
}

const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) app.quit();
app.on('second-instance', () => openHub());

app.whenReady().then(async () => {
  if (!isPrimary) return;
  // Menu-bar only: no Dock icon, so dictating never activates the app or pops a window.
  if (process.platform === 'darwin') app.dock.hide();
  if (importKeysFromEnv()) return app.quit();
  log('starting', app.getVersion(), 'mic', systemPreferences.getMediaAccessStatus?.('microphone'), 'accessibility', systemPreferences.isTrustedAccessibilityClient?.(false));
  if (process.platform === 'darwin') {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    log('microphone access', granted ? 'granted' : 'DENIED');
  }
  createPill();
  tray = new Tray(trayIcon());
  registerHotkey();
  applyLoginItem();
  const firstRun = !Object.values(settings.publicSettings().hasKey).some(Boolean);
  if (firstRun) openHub();
});

app.on('window-all-closed', () => {}); // stay alive in the menu bar
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  restoreSystemAudioSync(); // never leave the Mac muted
});

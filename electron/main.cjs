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
const settings = require('./settings.cjs');
const { transcribe, cleanup } = require('./transcribe.cjs');
const { insertText } = require('./paste.cjs');

const DIST = path.join(__dirname, '..', 'dist');
const PILL_SIZE = { width: 240, height: 64 };

let pill = null;
let hub = null;
let tray = null;
let state = 'idle'; // idle | recording | processing
let hotkeyError = '';

function createPill() {
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
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  pill.setAlwaysOnTop(true, 'screen-saver');
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pill.setIgnoreMouseEvents(true);
  pill.loadFile(path.join(DIST, 'pill.html'));
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
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: 'Listny', body }).show();
}

function setState(next) {
  state = next;
  updateTray();
  // Esc cancels only while a dictation is active, so it isn't swallowed system-wide.
  if (next === 'recording') globalShortcut.register('Escape', cancelRecording);
  else if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape');
}

function toggleRecording() {
  if (state === 'idle') {
    setState('recording');
    showPill();
    pill.webContents.send('rec:start');
  } else if (state === 'recording') {
    setState('processing');
    pill.webContents.send('rec:stop');
  }
}

function cancelRecording() {
  if (state !== 'recording') return;
  pill.webContents.send('rec:cancel');
  setState('idle');
  pill.hide();
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const { hotkey } = settings.load();
  hotkeyError = '';
  try {
    if (!globalShortcut.register(hotkey, toggleRecording)) {
      hotkeyError = `"${hotkey}" is already used by another app. Pick a different shortcut.`;
    }
  } catch {
    hotkeyError = `"${hotkey}" is not a valid shortcut.`;
  }
  if (hotkeyError) notify(hotkeyError);
  updateTray();
}

async function processAudio(_event, { audio, mimeType, durationMs }) {
  const cfg = settings.load();
  const started = Date.now();
  try {
    const provider = cfg.stt.provider;
    const raw = await transcribe({
      provider,
      model: cfg.stt.models[provider],
      apiKey: settings.getKey(provider),
      audio: Buffer.from(audio),
      mimeType,
      language: cfg.language,
    });
    if (!raw) return { status: 'empty' };

    let text = raw;
    if (cfg.cleanup.enabled) {
      const cp = cfg.cleanup.provider;
      text = await cleanup({ provider: cp, model: cfg.cleanup.models[cp], apiKey: settings.getKey(cp), text: raw });
    }

    const result = await insertText(text, { paste: cfg.pasteIntoActiveApp, restoreClipboard: cfg.restoreClipboard });
    if (result === 'copied' && cfg.pasteIntoActiveApp) {
      notify('Copied to clipboard. Allow Listny under Privacy & Security → Accessibility to paste automatically.');
    }
    settings.addHistory({
      id: started.toString(36),
      at: new Date(started).toISOString(),
      raw,
      text,
      provider,
      durationMs,
      latencyMs: Date.now() - started,
    });
    hub?.webContents.send('history:changed');
    return { status: result, text };
  } catch (err) {
    notify(err.message);
    return { status: 'error', error: err.message };
  } finally {
    setState('idle');
    setTimeout(() => state === 'idle' && pill.hide(), 900);
  }
}

function trayIcon() {
  // 16x16 template microphone glyph, so the menu bar tints it for light/dark mode.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" fill="black"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" stroke="black" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>`;
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  img.setTemplateImage(true);
  return img;
}

function updateTray() {
  if (!tray) return;
  const { hotkey } = settings.load();
  const last = settings.history()[0];
  tray.setToolTip(state === 'recording' ? 'Listny — listening' : 'Listny');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: hotkeyError || `Press ${hotkey} to dictate`, enabled: false },
      { label: state === 'recording' ? 'Stop dictation' : 'Start dictation', click: toggleRecording, enabled: state !== 'processing' },
      { label: 'Copy last transcript', enabled: Boolean(last), click: () => last && clipboard.writeText(last.text) },
      { type: 'separator' },
      { label: 'Open Listny…', click: openHub },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ])
  );
}

ipcMain.handle('audio:process', processAudio);
ipcMain.on('rec:failed', (_e, message) => {
  notify(`Microphone error: ${message}`);
  setState('idle');
  pill.hide();
});
ipcMain.on('rec:discard', () => {
  setState('idle');
  pill.hide();
});
ipcMain.handle('settings:get', () => ({ ...settings.publicSettings(), hotkeyError }));
ipcMain.handle('settings:save', (_e, patch) => {
  settings.save(patch);
  registerHotkey();
  return { ...settings.publicSettings(), hotkeyError };
});
ipcMain.handle('key:set', (_e, { provider, value }) => {
  settings.setKey(provider, value.trim());
  return settings.publicSettings();
});
ipcMain.handle('history:get', () => settings.history());
ipcMain.handle('history:clear', () => {
  settings.clearHistory();
  updateTray();
});
ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(text));

app.whenReady().then(async () => {
  if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone');
  createPill();
  tray = new Tray(trayIcon());
  registerHotkey();
  const firstRun = !Object.values(settings.publicSettings().hasKey).some(Boolean);
  if (firstRun) openHub();
});

app.on('activate', openHub);
app.on('window-all-closed', () => {}); // stay alive in the menu bar
app.on('will-quit', () => globalShortcut.unregisterAll());

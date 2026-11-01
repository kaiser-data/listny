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
const { muteSystemAudio, restoreSystemAudio, restoreSystemAudioSync } = require('./audio.cjs');

const DIST = path.join(__dirname, '..', 'dist');
const PILL_SIZE = { width: 260, height: 64 };

let pill = null;
let hub = null;
let tray = null;
let state = 'idle'; // idle | recording | processing
let hotkeyError = '';
let hotkeyPaused = false; // while the hub captures a new shortcut, the old one must not fire

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

function setState(next) {
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
      result,
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
      { label: 'Copy last transcript', enabled: Boolean(last), click: () => last && clipboard.writeText(last.text) },
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
ipcMain.on('rec:failed', (_e, message) => {
  notify(`Microphone error: ${message}`);
  setState('idle');
  pill.hide();
});
ipcMain.on('rec:discard', () => {
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
ipcMain.handle('history:clear', () => {
  settings.clearHistory();
  updateTray();
});
ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(text));

// One Listny at a time: a second launch (e.g. the .app while `npm start` runs) just opens settings.
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) app.quit();
app.on('second-instance', () => openHub());

app.whenReady().then(async () => {
  if (!isPrimary) return;
  // Menu-bar only: no Dock icon, so dictating never activates the app or pops a window.
  if (process.platform === 'darwin') app.dock.hide();
  if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone');
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

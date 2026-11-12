const { clipboard, systemPreferences } = require('electron');
const { execFile } = require('node:child_process');

const run = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim()))));

// Posts Cmd+V straight into the system event stream. Going through System Events instead is unreliable:
// macOS quits it when idle, and a keystroke sent while it relaunches (about a second) can be lost,
// which is what happens after a long dictation.
const MAC_PASTE = `
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');
(() => {
  if (!$.AXIsProcessTrusted()) return 'denied';
  const V = 9;
  const src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
  for (const down of [true, false]) {
    const e = $.CGEventCreateKeyboardEvent(src, V, down);
    $.CGEventSetFlags(e, $.kCGEventFlagMaskCommand);
    $.CGEventPost($.kCGHIDEventTap, e);
  }
  return 'posted';
})();`;

// Resolves with the method used, for the log.
async function sendPasteKeystroke() {
  if (process.platform === 'darwin') {
    const direct = await run('osascript', ['-l', 'JavaScript', '-e', MAC_PASTE]).catch(() => 'failed');
    if (direct === 'posted') return 'direct key event';
    await run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
    return `System Events (direct key event ${direct})`;
  }
  if (process.platform === 'win32') {
    const ps = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')";
    return new Promise((resolve, reject) =>
      execFile('powershell', ['-NoProfile', '-Command', ps], (err) => (err ? reject(err) : resolve()))
    );
  }
  return new Promise((resolve, reject) =>
    execFile('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], (err) => (err ? reject(err) : resolve()))
  );
}

function canPaste() {
  return process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false);
}

// Puts text on the clipboard and pastes it into whatever app has focus.
// Returns 'pasted' or 'copied' (when paste permission is missing or the keystroke fails).
async function insertText(text, { paste = true, restoreClipboard = true, log = () => {} } = {}) {
  const previous = clipboard.readText();
  clipboard.writeText(text);
  if (!paste) return 'copied';
  if (!canPaste()) {
    systemPreferences.isTrustedAccessibilityClient(true); // prompts the user once
    return 'copied';
  }
  try {
    const t = Date.now();
    const method = await sendPasteKeystroke();
    log('paste sent via', method || 'keystroke', `in ${Date.now() - t}ms`);
  } catch (err) {
    log('paste keystroke failed:', err.message.slice(0, 200));
    return 'copied';
  }
  if (restoreClipboard) {
    // Give the target app time to read the clipboard, but don't hold up the result for it.
    setTimeout(() => {
      if (clipboard.readText() === text) clipboard.writeText(previous);
    }, 1500);
  }
  return 'pasted';
}

// Live typing (Rests): pastes one piece into the focused field during a dictation. The caller saves
// the user's clipboard once before the first piece and restores it after the last.
async function pasteChunk(text) {
  clipboard.writeText(text);
  const method = await sendPasteKeystroke();
  await new Promise((r) => setTimeout(r, 150)); // let the target app read the clipboard before it changes again
  return method;
}

module.exports = { insertText, pasteChunk, canPaste };

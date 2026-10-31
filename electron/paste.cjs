const { clipboard, systemPreferences } = require('electron');
const { execFile } = require('node:child_process');

function sendPasteKeystroke() {
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) =>
      execFile(
        'osascript',
        ['-e', 'tell application "System Events" to keystroke "v" using command down'],
        (err) => (err ? reject(err) : resolve())
      )
    );
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
async function insertText(text, { paste = true, restoreClipboard = true } = {}) {
  const previous = clipboard.readText();
  clipboard.writeText(text);
  if (!paste) return 'copied';
  if (!canPaste()) {
    systemPreferences.isTrustedAccessibilityClient(true); // prompts the user once
    return 'copied';
  }
  try {
    await sendPasteKeystroke();
  } catch {
    return 'copied';
  }
  if (restoreClipboard) {
    // Give the target app time to read the clipboard, but don't hold up the result for it.
    setTimeout(() => {
      if (clipboard.readText() === text) clipboard.writeText(previous);
    }, 500);
  }
  return 'pasted';
}

module.exports = { insertText };

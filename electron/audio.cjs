const { execFile, execFileSync } = require('node:child_process');

// Silences system audio (music, videos) while you dictate and brings it back afterwards.
// Only un-mutes what Listny muted: if sound was already off, it stays off.

const run = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, (err, out) => (err ? reject(err) : resolve(String(out).trim()))));

const platform = {
  darwin: {
    // Returns the previous mute state; "missing value" means the output device can't be muted.
    mute: () =>
      run('osascript', [
        '-e', 'set wasMuted to output muted of (get volume settings)',
        '-e', 'if wasMuted is false then set volume with output muted',
        '-e', 'return wasMuted',
      ]).then((was) => was === 'false'),
    unmute: () => run('osascript', ['-e', 'set volume without output muted']),
    unmuteSync: () => execFileSync('osascript', ['-e', 'set volume without output muted']),
  },
  linux: {
    mute: async () => {
      const was = await run('pactl', ['get-sink-mute', '@DEFAULT_SINK@']);
      if (/yes/i.test(was)) return false;
      await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', '1']);
      return true;
    },
    unmute: () => run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', '0']),
    unmuteSync: () => execFileSync('pactl', ['set-sink-mute', '@DEFAULT_SINK@', '0']),
  },
}[process.platform];

let mutedByUs = false;
let queue = Promise.resolve(); // serialises mute/unmute so a quick stop can't overtake a slow mute

function enqueue(fn) {
  queue = queue.then(fn).catch(() => {}); // a missing tool or odd audio device must never break dictation
  return queue;
}

function muteSystemAudio() {
  if (!platform) return queue;
  return enqueue(async () => {
    if (!mutedByUs) mutedByUs = await platform.mute();
  });
}

function restoreSystemAudio() {
  if (!platform) return queue;
  return enqueue(async () => {
    if (!mutedByUs) return;
    mutedByUs = false;
    await platform.unmute();
  });
}

// For app quit, where async work may not finish.
function restoreSystemAudioSync() {
  if (!platform || !mutedByUs) return;
  mutedByUs = false;
  try {
    platform.unmuteSync();
  } catch {}
}

module.exports = { muteSystemAudio, restoreSystemAudio, restoreSystemAudioSync };

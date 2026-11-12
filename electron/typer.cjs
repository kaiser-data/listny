const { spawn } = require('node:child_process');

// Types text into the focused app as keyboard input, character by character, so dictated words
// flow into the text field instead of landing as one pasted block, and the clipboard is never touched.
// One long-lived JXA process per dictation reads JSON lines from stdin and answers each with a line on
// stdout once typed; starting osascript per word would cost about half a second each time.
// macOS only. Needs the Accessibility permission, like paste.
const TYPER = `
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');
ObjC.import('Foundation');
function run(argv) {
  const out = $.NSFileHandle.fileHandleWithStandardOutput;
  const say = (s) => out.writeData($.NSString.alloc.initWithUTF8String(s + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
  if (!$.AXIsProcessTrusted()) { say('denied'); return; }
  const pid = Number(argv[0] || 0); // tests type into one app instead of the focused one
  const src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
  const ch = Ref('S');
  const key = (code) => {
    ch[0] = code;
    for (const down of [true, false]) {
      const e = $.CGEventCreateKeyboardEvent(src, 0, down);
      $.CGEventSetFlags(e, 0); // a modifier still held from the hotkey must not turn letters into shortcuts
      $.CGEventKeyboardSetUnicodeString(e, 1, ch);
      if (pid) $.CGEventPostToPid(pid, e); else $.CGEventPost($.kCGHIDEventTap, e);
    }
    delay(0.004); // faster than this, apps drop characters
  };
  say('ready');
  const stdin = $.NSFileHandle.fileHandleWithStandardInput;
  let buf = '';
  for (;;) {
    const data = stdin.availableData;
    if (Number(data.length) === 0) return;
    buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const text = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      for (let j = 0; j < text.length; j++) key(text.charCodeAt(j));
      say('done');
    }
  }
}`;

function createTyper({ pid = 0, log = () => {} } = {}) {
  const proc = spawn('osascript', ['-l', 'JavaScript', '-e', TYPER, String(pid)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = []; // resolvers, one per line sent, answered in order
  let failed = null;
  let out = '';
  let resolveReady;
  let rejectReady;
  const ready = new Promise((res, rej) => ((resolveReady = res), (rejectReady = rej)));
  ready.catch(() => {});

  const fail = (err) => {
    if (failed) return;
    failed = err;
    rejectReady(err);
    waiting.splice(0).forEach((w) => w.reject(err));
  };
  proc.stdout.on('data', (d) => {
    out += d;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
      if (line === 'ready') resolveReady();
      else if (line === 'denied') fail(new Error('Accessibility permission missing'));
      else if (line === 'done') waiting.shift()?.resolve();
    }
  });
  proc.stderr.on('data', (d) => log('typer:', String(d).trim().slice(0, 200)));
  proc.on('error', fail);
  proc.on('exit', (code) => fail(new Error(`typer exited (${code})`)));

  return {
    ready,
    // Resolves once the text has been typed.
    async type(text) {
      if (!text) return;
      await ready;
      if (failed) throw failed;
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
        proc.stdin.write(JSON.stringify(text) + '\n');
      });
    },
    close() {
      proc.stdin.end();
      setTimeout(() => proc.kill(), 5000).unref();
    },
  };
}

module.exports = { createTyper };

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/rests.mjs');
const RATE = 16_000;

// Synthetic audio: "speech" is 200 ms syllables of a 200 Hz tone with 60 ms gaps, "silence" is faint noise.
let seed = 1;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.002;
const syllable = (i) => (i % (0.26 * RATE) < 0.2 * RATE ? 0.3 * Math.sin((2 * Math.PI * 200 * i) / RATE) : 0);
const speech = (sec) => Float32Array.from({ length: sec * RATE }, (_, i) => syllable(i) + noise());
const silence = (sec) => Float32Array.from({ length: sec * RATE }, noise);
const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
};

function run(audio, chunk = 4096) {
  return load().then(({ createSegmenter }) => {
    const pieces = [];
    const seg = createSegmenter((p) => pieces.push(p.length / RATE));
    for (let i = 0; i < audio.length; i += chunk) seg.push(audio.subarray(i, i + chunk));
    seg.flush();
    return pieces;
  });
}

test('one sentence without pauses is one piece, with leading silence trimmed', async () => {
  const pieces = await run(concat(silence(3), speech(5), silence(0.2)));
  assert.equal(pieces.length, 1);
  assert.ok(pieces[0] > 5 && pieces[0] < 5.6, `piece is ${pieces[0]}s`);
});

test('a pause after a long enough piece starts a new piece', async () => {
  const pieces = await run(concat(speech(4), silence(1), speech(4)));
  assert.equal(pieces.length, 2);
});

test('a short pause inside a short piece does not cut it', async () => {
  const pieces = await run(concat(speech(1), silence(0.8), speech(1)));
  assert.equal(pieces.length, 1);
});

test('long pauses are not uploaded', async () => {
  const pieces = await run(concat(speech(2), silence(20), speech(2), silence(30)));
  assert.equal(pieces.length, 2);
  const total = pieces.reduce((a, b) => a + b, 0);
  assert.ok(total < 6, `uploaded ${total}s of 56s`);
});

test('silence alone produces nothing', async () => {
  assert.deepEqual(await run(silence(10)), []);
});

test('a very long run without pauses is still cut', async () => {
  const pieces = await run(speech(130));
  assert.equal(pieces.length, 2);
  assert.ok(pieces[0] <= 120);
});

test('resampling 48 kHz to 16 kHz keeps the length and joins chunks seamlessly', async () => {
  const { createResampler } = await load();
  const r = createResampler(48_000);
  let n = 0;
  for (let i = 0; i < 10; i++) n += r(new Float32Array(4096).fill(0.5)).length;
  assert.ok(Math.abs(n - (10 * 4096) / 3) <= 1, `got ${n}`);
  const r2 = createResampler(44_100);
  let m = 0;
  for (let i = 0; i < 100; i++) m += r2(new Float32Array(441).fill(0.5)).length;
  assert.ok(Math.abs(m - 16_000) <= 1, `got ${m}`);
});

test('WAV header describes 16 kHz mono 16-bit audio', async () => {
  const { encodeWav } = await load();
  const v = new DataView(encodeWav(new Float32Array(16_000)));
  assert.equal(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)), 'RIFF');
  assert.equal(v.getUint32(24, true), 16_000);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(40, true), 32_000);
});

test('pieces join into one text', () => {
  const { joinPieces, separator, ending } = require('../electron/pieces.cjs');
  assert.equal(joinPieces([' Hallo, ', '', 'wie geht es?']), 'Hallo, wie geht es?');
  // A piece without a period gets one when the next starts a sentence, and so does the last piece.
  assert.equal(joinPieces(['This is the difference', 'Can you fix it']), 'This is the difference. Can you fix it.');
  assert.equal(joinPieces(['ich habe', 'heute keine Zeit']), 'ich habe heute keine Zeit.');
  // Typed one piece at a time, the result is the same text.
  const parts = ['This is the difference', 'Can you fix it', 'and then', 'Done!'];
  let typed = '';
  parts.forEach((t, i) => (typed += separator(parts[i - 1], t) + t));
  typed += ending(parts.at(-1));
  assert.equal(typed, joinPieces(parts));
});

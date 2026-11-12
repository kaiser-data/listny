// Rests: cuts a dictation into pieces at the speaker's pauses, so each piece can be transcribed while
// the next one is still being spoken. Long silences are dropped before upload, so pauses cost nothing.
// Pure code (no DOM, no Electron), so it runs in the pill and in the unit tests alike.

export const RATE = 16_000; // what the speech-to-text providers work at internally; 32 KB/s as 16-bit WAV
const FRAME = RATE / 50; // 20 ms analysis frames
const ms = (n) => Math.round(n / 20); // milliseconds -> frames

export const TUNING = {
  preroll: ms(300), // silence kept before speech starts, so the first syllable is never clipped
  keepSilence: ms(500), // longest pause kept inside a piece; anything longer is not uploaded
  cutAfter: ms(700), // a pause this long ends a piece once the piece is long enough...
  minPiece: ms(3000), // ...which is this long (short pieces lose context and transcribe worse)
  cutAnyAfter: ms(1500), // a pause this long ends a piece of any length
  minSpeech: ms(200), // pieces with less speech than this are noise and are dropped
  softMax: ms(90_000), // past this, cut at the next short pause
  softMaxPause: ms(200),
  hardMax: ms(120_000), // and past this, cut regardless
};

// Speech detector: a frame is speech when it is clearly louder than the background noise,
// which is tracked continuously: it falls quickly, adapts within about a second during pauses,
// and barely moves while someone speaks, so a long sentence never turns into "background".
function createDetector() {
  // Starts at a quiet room's level rather than the first frame, which may already be speech
  // when someone talks the moment they press the hotkey.
  let floor = 0.001;
  return (frame) => {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const speech = rms > Math.max(floor * 3.5, 0.008);
    const rate = rms < floor ? 0.2 : speech ? 0.0002 : 0.02;
    floor += (rms - floor) * rate;
    return speech;
  };
}

// Feed it 16 kHz mono samples with push(); it calls onPiece(Float32Array) for every finished piece.
// flush() ends the dictation and emits whatever speech is left.
export function createSegmenter(onPiece, tuning = TUNING) {
  const isSpeech = createDetector();
  const t = tuning;
  let pending = new Float32Array(0); // samples not yet filling a whole frame
  let frames = []; // frames of the current piece
  let speechFrames = 0;
  let silence = 0; // consecutive silent frames at the end of the piece (only some of them are kept)
  let kept = 0; // how many of those silent frames are in `frames`

  function emit() {
    // Keep at most the preroll's worth of trailing silence.
    const drop = Math.max(0, kept - t.preroll);
    const used = frames.slice(0, frames.length - drop);
    if (speechFrames >= t.minSpeech) {
      const out = new Float32Array(used.length * FRAME);
      used.forEach((f, i) => out.set(f, i * FRAME));
      onPiece(out);
    }
    frames = [];
    speechFrames = 0;
    silence = 0;
    kept = 0;
  }

  function frame(f) {
    const speech = isSpeech(f);
    if (!speechFrames) {
      // Nothing said yet: keep only a short rolling preroll of silence.
      if (speech) speechFrames = 1;
      frames.push(f);
      if (!speech && frames.length > t.preroll) frames.shift();
      return;
    }
    if (speech) {
      speechFrames++;
      silence = 0;
      kept = 0;
      frames.push(f);
    } else {
      silence++;
      if (kept < t.keepSilence) {
        frames.push(f);
        kept++;
      }
    }
    const length = frames.length;
    if (
      (silence >= t.cutAfter && length >= t.minPiece) ||
      silence >= t.cutAnyAfter ||
      (length >= t.softMax && silence >= t.softMaxPause) ||
      length >= t.hardMax
    ) {
      emit();
    }
  }

  return {
    push(samples) {
      const all = new Float32Array(pending.length + samples.length);
      all.set(pending);
      all.set(samples, pending.length);
      let i = 0;
      for (; i + FRAME <= all.length; i += FRAME) frame(all.slice(i, i + FRAME));
      pending = all.slice(i);
    },
    flush() {
      if (speechFrames) emit();
      frames = [];
      pending = new Float32Array(0);
    },
  };
}

// Converts microphone audio (usually 48 kHz) to 16 kHz by averaging, which also filters out
// frequencies the lower rate can't hold. Keeps its position across calls, so chunks join seamlessly.
export function createResampler(fromRate, toRate = RATE) {
  const step = fromRate / toRate;
  let carry = new Float32Array(0);
  let pos = 0; // position of the next output sample within carry + input
  return (input) => {
    const src = new Float32Array(carry.length + input.length);
    src.set(carry);
    src.set(input, carry.length);
    const out = [];
    while (pos + step <= src.length) {
      const start = Math.floor(pos);
      const end = Math.floor(pos + step);
      let sum = 0;
      for (let i = start; i < end; i++) sum += src[i];
      out.push(end > start ? sum / (end - start) : src[start]);
      pos += step;
    }
    const keepFrom = Math.floor(pos);
    carry = src.slice(keepFrom);
    pos -= keepFrom;
    return Float32Array.from(out);
  };
}

// 16-bit PCM WAV, which every provider accepts.
export function encodeWav(samples, rate = RATE) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// Joins the pieces' transcripts for the live view. The final text is joined in the main process (electron/pieces.cjs).
export const joinPieces = (texts) => texts.map((t) => (t || '').trim()).filter(Boolean).join(' ');

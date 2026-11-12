import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { createResampler, createSegmenter, encodeWav, joinPieces } from './rests.mjs';

const BARS = 14;
const MIN_DURATION_MS = 300;
const MIME = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
const LYRICS_CHARS = 140; // about two lines of the live text

// The end of the live text, cut at a word so it never starts mid-word.
function tail(text) {
  if (text.length <= LYRICS_CHARS) return text;
  const cut = text.slice(-LYRICS_CHARS);
  return '… ' + cut.slice(cut.indexOf(' ') + 1);
}

function Pill() {
  const [phase, setPhase] = useState('idle'); // idle | recording | processing | done | error
  const [message, setMessage] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [lyrics, setLyrics] = useState('');
  const session = useRef(null);
  // The level meter is written straight to the DOM: re-rendering React 60×/s just to move bars is wasted work.
  const bars = useRef([]);

  useEffect(() => {
    async function start() {
      const s = { chunks: [], pieces: [], texts: [], cancelled: false, stopRequested: false, startedAt: Date.now() };
      session.current = s;
      setPhase('recording');
      setMessage('');
      setLyrics('');
      setSeconds(0);
      const { rests } = await window.listny.getPillSettings();
      s.timer = setInterval(() => setSeconds(Math.floor((Date.now() - s.startedAt) / 1000)), 1000);
      try {
        s.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        clearInterval(s.timer);
        setPhase('idle');
        window.listny.recordingFailed(err.message);
        return;
      }
      s.audioCtx = new AudioContext();
      const analyser = s.audioCtx.createAnalyser();
      analyser.fftSize = 64;
      s.audioCtx.createMediaStreamSource(s.stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(buf);
        bars.current.forEach((el, i) => {
          if (el) el.style.transform = `scaleY(${0.12 + (buf[i + 1] / 255) * 0.88})`;
        });
        s.raf = requestAnimationFrame(tick);
      };
      tick();
      if (rests) startRests(s, analyser.context);

      s.recorder = new MediaRecorder(s.stream, { mimeType: MIME });
      s.recorder.ondataavailable = (e) => e.data.size && s.chunks.push(e.data);
      s.recorder.onstop = () => finish(s);
      s.recorder.start(250);
      if (s.stopRequested || s.cancelled) s.recorder.stop();
    }

    // Rests: the same microphone audio, cut at pauses; each piece is transcribed while you keep talking
    // and its text appears in the pill (Lyrics). The whole recording is still kept as a fallback.
    function startRests(s, ctx) {
      const resample = createResampler(ctx.sampleRate);
      s.segmenter = createSegmenter((samples) => {
        const index = s.pieces.length;
        const piece = window.listny.transcribePiece(encodeWav(samples)).then((res) => {
          if (res.error) return Promise.reject(new Error(res.error));
          s.texts[index] = res.text;
          if (!s.cancelled) setLyrics(tail(joinPieces(s.texts.filter((t) => t !== undefined))));
          return res.text;
        });
        piece.catch(() => {}); // a failed piece only means the whole recording is sent at the end
        s.pieces.push(piece);
      });
      // ScriptProcessorNode is deprecated but needs no separate module file, which the pill's CSP would block.
      s.tap = ctx.createScriptProcessor(4096, 1, 1);
      s.tap.onaudioprocess = (e) => s.segmenter.push(resample(e.inputBuffer.getChannelData(0)));
      ctx.createMediaStreamSource(s.stream).connect(s.tap);
      s.tap.connect(ctx.destination); // a processor only runs while connected; its output stays silent
    }

    // The pieces' texts, or null when Rests was off or any piece failed (then the whole recording is sent).
    async function restsTranscript(s) {
      if (!s.segmenter) return null;
      s.tap.onaudioprocess = null;
      s.segmenter.flush();
      try {
        return { texts: await Promise.all(s.pieces) };
      } catch {
        return null;
      }
    }

    function release(s) {
      cancelAnimationFrame(s.raf);
      clearInterval(s.timer);
      s.stream?.getTracks().forEach((t) => t.stop());
      s.audioCtx?.close();
    }

    async function finish(s) {
      const stoppedAt = Date.now();
      const durationMs = stoppedAt - s.startedAt;
      // Takes the last audio still in the processor before the microphone is released.
      const rests = s.cancelled ? null : restsTranscript(s);
      release(s);
      if (s.cancelled) return setPhase('idle');
      if (durationMs < MIN_DURATION_MS || !s.chunks.length) {
        window.listny.discardRecording();
        return setPhase('idle');
      }
      setPhase('processing');
      const audio = await new Blob(s.chunks, { type: MIME }).arrayBuffer();
      const restsResult = await rests;
      // Nothing heard by the pause detector (very quiet speech?) also falls back to the whole recording.
      const fromPieces = restsResult && joinPieces(restsResult.texts) ? restsResult : {};
      const res = await window.listny.processAudio({ audio, mimeType: MIME, durationMs, waitedMs: Date.now() - stoppedAt, ...fromPieces });
      if (res.status === 'error') {
        setPhase('error');
        setMessage('Failed — see notification');
      } else if (res.status === 'empty') {
        setPhase('done');
        setMessage('Heard nothing');
      } else {
        setPhase('done');
        setMessage(res.status === 'pasted' ? 'Pasted' : 'Copied');
      }
    }

    function stop(cancel) {
      const s = session.current;
      if (!s) return;
      s.cancelled = cancel;
      s.stopRequested = true;
      if (s.recorder?.state === 'recording') s.recorder.stop();
      else if (cancel) {
        clearInterval(s.timer);
        setPhase('idle');
      }
    }

    const offs = [window.listny.onStart(start), window.listny.onStop(() => stop(false)), window.listny.onCancel(() => stop(true))];
    window.listny.pillReady(); // listeners are attached: the main process may send 'rec:start' now
    return () => offs.forEach((off) => off());
  }, []);

  const showLyrics = lyrics && (phase === 'recording' || phase === 'processing');
  return (
    <>
    {showLyrics && <div className="lyrics">{lyrics}</div>}
    <div className={`pill pill--${phase}`}>
      {phase === 'recording' && (
        <>
          <div className="bars" aria-label="Listening">
            {Array.from({ length: BARS }, (_, i) => (
              <span key={i} ref={(el) => (bars.current[i] = el)} />
            ))}
          </div>
          <div className="pill-meta">
            <span className="rec-dot" />
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
            <kbd>esc</kbd>
          </div>
        </>
      )}
      {phase === 'processing' && (
        <div className="dots" aria-label="Transcribing">
          <span />
          <span />
          <span />
        </div>
      )}
      {(phase === 'done' || phase === 'error') && <div className="pill-msg">{message}</div>}
    </div>
    </>
  );
}

createRoot(document.getElementById('root')).render(<Pill />);

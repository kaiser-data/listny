import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const BARS = 18;
const MIN_DURATION_MS = 300;
const MIME = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';

function Pill() {
  const [phase, setPhase] = useState('idle'); // idle | recording | processing | done | error
  const [levels, setLevels] = useState(() => Array(BARS).fill(0));
  const [message, setMessage] = useState('');
  const session = useRef(null);

  useEffect(() => {
    async function start() {
      const s = { chunks: [], cancelled: false, stopRequested: false, startedAt: Date.now() };
      session.current = s;
      setPhase('recording');
      setMessage('');
      try {
        s.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
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
        setLevels(Array.from({ length: BARS }, (_, i) => buf[i + 1] / 255));
        s.raf = requestAnimationFrame(tick);
      };
      tick();

      s.recorder = new MediaRecorder(s.stream, { mimeType: MIME });
      s.recorder.ondataavailable = (e) => e.data.size && s.chunks.push(e.data);
      s.recorder.onstop = () => finish(s);
      s.recorder.start(250);
      if (s.stopRequested || s.cancelled) s.recorder.stop();
    }

    function release(s) {
      cancelAnimationFrame(s.raf);
      s.stream?.getTracks().forEach((t) => t.stop());
      s.audioCtx?.close();
      setLevels(Array(BARS).fill(0));
    }

    async function finish(s) {
      release(s);
      const durationMs = Date.now() - s.startedAt;
      if (s.cancelled) return setPhase('idle');
      if (durationMs < MIN_DURATION_MS || !s.chunks.length) {
        window.listny.discardRecording();
        return setPhase('idle');
      }
      setPhase('processing');
      const audio = await new Blob(s.chunks, { type: MIME }).arrayBuffer();
      const res = await window.listny.processAudio({ audio, mimeType: MIME, durationMs });
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
      else if (cancel) setPhase('idle');
    }

    const offs = [window.listny.onStart(start), window.listny.onStop(() => stop(false)), window.listny.onCancel(() => stop(true))];
    return () => offs.forEach((off) => off());
  }, []);

  return (
    <div className={`pill pill--${phase}`}>
      {phase === 'recording' && (
        <div className="bars" aria-label="Listening">
          {levels.map((l, i) => (
            <span key={i} style={{ transform: `scaleY(${0.12 + l * 0.88})` }} />
          ))}
        </div>
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
  );
}

createRoot(document.getElementById('root')).render(<Pill />);

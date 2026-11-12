// Live word-by-word transcription with ElevenLabs Scribe realtime over a WebSocket.
// The server sends running guesses ("partial") and, at each pause it detects, the final text
// for that stretch ("committed"). Partials are only previewed; committed text is what gets typed.
// Docs: https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies

const TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe';
const WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const RATE = 16_000;
const KEY_FAILURES = new Set([401, 402, 403, 429]);

// A single-use token, so the key itself never goes into a URL. Tries each key like batch transcription.
async function fetchToken(keys, { onKeyFailed = () => {}, onKeyWorked = () => {} } = {}) {
  let firstError;
  for (const { slot, key } of keys) {
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      onKeyWorked(slot);
      return (await res.json()).token;
    }
    const err = new Error(`elevenlabs live token failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
    err.status = res.status;
    firstError ||= err;
    onKeyFailed(slot, err);
    if (!KEY_FAILURES.has(res.status)) break;
  }
  throw firstError || new Error('No API key set for elevenlabs. Open Listny settings to add one.');
}

function streamUrl({ token, model, language }) {
  const q = new URLSearchParams({
    model_id: model,
    audio_format: 'pcm_16000',
    commit_strategy: 'vad',
    vad_silence_threshold_secs: '0.8', // a pause this long finalizes the words so far
    token,
  });
  if (/^[a-z]{2,3}$/i.test(language || '')) q.set('language_code', language);
  return `${WS_URL}?${q}`;
}

// Opens a stream right away and buffers audio until the connection is up, so no word is lost
// while the token and the handshake are under way.
function openStream({ keys, model, language, onPartial, onCommitted, onError, log = () => {}, keyHooks }) {
  const queue = []; // audio chunks waiting for the connection
  const committed = [];
  let ws = null;
  let failed = null;
  let closing = null; // resolver of finish()

  const fail = (err) => {
    if (failed) return;
    failed = err;
    log('stream failed:', err.message.slice(0, 300));
    onError?.(err);
    closing?.();
    try {
      ws?.close();
    } catch {}
  };

  const sendChunk = (pcm, commit = false) =>
    ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: pcm ? Buffer.from(pcm).toString('base64') : '', commit, sample_rate: RATE }));

  (async () => {
    const started = Date.now();
    const token = await fetchToken(await keys, keyHooks); // keys may still be decrypting
    ws = new WebSocket(streamUrl({ token, model, language }));
    ws.onopen = () => {
      log('stream open in', `${Date.now() - started}ms`);
      while (queue.length) sendChunk(queue.shift());
    };
    ws.onmessage = (m) => {
      let msg;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      if (msg.message_type === 'partial_transcript') onPartial?.(msg.text || '');
      else if (msg.message_type === 'committed_transcript') {
        const text = (msg.text || '').trim();
        if (text) {
          committed.push(text);
          onCommitted?.(text);
        }
        if (closing) closing();
      } else if (msg.error) fail(new Error(`elevenlabs live ${msg.message_type}: ${msg.error}`));
    };
    ws.onerror = (e) => log('stream socket error:', e?.message || e?.error?.message || 'unknown');
    // The close code and reason say why (e.g. too little audio, quota); onerror alone carries no detail.
    ws.onclose = (e) => {
      const why = `${e.code}${e.reason ? `: ${e.reason}` : ''}`;
      if (closing) closing();
      else fail(new Error(`elevenlabs live connection closed (${why})`));
    };
  })().catch(fail);

  return {
    get failed() {
      return failed;
    },
    committed,
    // 16-bit mono PCM at 16 kHz.
    send(pcm) {
      if (failed) return;
      if (ws?.readyState === WebSocket.OPEN) sendChunk(pcm);
      else queue.push(pcm);
    },
    // Asks for the last words to be finalized, waits for them (or gives up after a few seconds),
    // and closes. Resolves with every committed text, or rejects if the stream failed.
    async finish(timeoutMs = 5000) {
      if (!failed) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => fail(new Error('elevenlabs live: no final text in time')), timeoutMs);
          closing = () => {
            clearTimeout(timer);
            // A pause-commit already in flight can answer before ours: allow a moment for stragglers.
            setTimeout(resolve, 200);
            closing = () => {};
          };
          const commit = () => {
            if (failed) return closing();
            if (ws?.readyState !== WebSocket.OPEN) return setTimeout(commit, 50);
            while (queue.length) sendChunk(queue.shift());
            sendChunk(null, true);
          };
          commit();
        });
      }
      try {
        ws?.close();
      } catch {}
      if (failed) throw failed;
      return committed;
    },
    cancel() {
      closing = () => {};
      try {
        ws?.close();
      } catch {}
    },
  };
}

module.exports = { openStream, streamUrl };

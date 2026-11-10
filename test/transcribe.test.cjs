const test = require('node:test');
const assert = require('node:assert/strict');
const { transcribe, transcribeWithKeys, cleanup } = require('../electron/transcribe.cjs');

const audio = Buffer.from('fake-audio');
const request = { provider: 'elevenlabs', model: 'scribe_v1', audio, mimeType: 'audio/webm;codecs=opus', language: '' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Replaces global fetch for one test and records every call.
function mockFetch(t, handler) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  });
  return calls;
}

test('transcribe sends the ElevenLabs request shape and trims the text', async (t) => {
  const calls = mockFetch(t, () => json(200, { text: '  Hello there.  ' }));
  const text = await transcribe({ ...request, apiKey: 'k1', language: 'de' });
  assert.equal(text, 'Hello there.');
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(calls[0].init.headers['xi-api-key'], 'k1');
  assert.equal(calls[0].init.body.get('model_id'), 'scribe_v1');
  assert.equal(calls[0].init.body.get('language_code'), 'de');
});

test('transcribe uses the OpenAI-style request for OpenAI and Groq', async (t) => {
  const calls = mockFetch(t, () => json(200, { text: 'ok' }));
  await transcribe({ ...request, provider: 'groq', model: 'whisper-large-v3-turbo', apiKey: 'g1', language: 'en' });
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer g1');
  assert.equal(calls[0].init.body.get('model'), 'whisper-large-v3-turbo');
  assert.equal(calls[0].init.body.get('language'), 'en');
});

test('anything that is not a language code means auto-detect', async (t) => {
  const calls = mockFetch(t, () => json(200, { text: 'ok' }));
  await transcribe({ ...request, apiKey: 'k1', language: 'Auto-Detect' });
  assert.equal(calls[0].init.body.has('language_code'), false);
});

test('transcribe fails clearly without a key or with an unknown provider', async () => {
  await assert.rejects(transcribe({ ...request, apiKey: '' }), /No API key set for elevenlabs/);
  await assert.rejects(transcribe({ ...request, provider: 'nope', apiKey: 'k' }), /Unknown STT provider/);
});

test('provider errors carry the HTTP status', async (t) => {
  mockFetch(t, () => json(401, { detail: { code: 'quota_exceeded' } }));
  await assert.rejects(transcribe({ ...request, apiKey: 'k1' }), (err) => err.status === 401 && /quota_exceeded/.test(err.message));
});

test('falls back to the backup key when the main account is out of credits', async (t) => {
  const calls = mockFetch(t, (_url, init) => (init.headers['xi-api-key'] === 'main' ? json(401, { detail: 'quota_exceeded' }) : json(200, { text: 'from backup' })));
  const failed = [];
  const worked = [];
  const keys = [
    { slot: 'elevenlabs', key: 'main' },
    { slot: 'elevenlabs:backup', key: 'backup' },
  ];
  const text = await transcribeWithKeys(keys, request, { onKeyFailed: (slot) => failed.push(slot), onKeyWorked: (slot) => worked.push(slot) });
  assert.equal(text, 'from backup');
  assert.equal(calls.length, 2);
  assert.deepEqual(failed, ['elevenlabs']);
  assert.deepEqual(worked, ['elevenlabs:backup']);
});

test('does not try the backup key for errors another account cannot fix', async (t) => {
  const calls = mockFetch(t, () => json(400, { detail: 'invalid audio' }));
  const keys = [
    { slot: 'elevenlabs', key: 'main' },
    { slot: 'elevenlabs:backup', key: 'backup' },
  ];
  await assert.rejects(transcribeWithKeys(keys, request), /\(400\)/);
  assert.equal(calls.length, 1);
});

test('reports when both keys are rejected', async (t) => {
  mockFetch(t, () => json(429, { detail: 'rate limited' }));
  const keys = [
    { slot: 'elevenlabs', key: 'main' },
    { slot: 'elevenlabs:backup', key: 'backup' },
  ];
  await assert.rejects(transcribeWithKeys(keys, request), /Both elevenlabs keys failed/);
});

test('with no keys the user is told to add one', async () => {
  await assert.rejects(transcribeWithKeys([], request), /No API key set for elevenlabs/);
});

test('cleanup returns the model text and falls back to the transcript', async (t) => {
  let reply = { choices: [{ message: { content: ' Cleaned. ' } }] };
  const calls = mockFetch(t, () => json(200, reply));
  assert.equal(await cleanup({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k', text: 'um cleaned' }), 'Cleaned.');
  assert.equal(JSON.parse(calls[0].init.body).messages[1].content, 'um cleaned');
  reply = { choices: [] };
  assert.equal(await cleanup({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k', text: 'kept' }), 'kept');
});

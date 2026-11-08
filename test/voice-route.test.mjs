import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchHandlers } from '../src/http.mjs';
import { actor, fixtureStore, orderId } from './order-fixture.mjs';

const provider = 'http://gnani.test';
const dispatch = 'http://dispatch.test';
const audioChunk = 'event: chunk\ndata: {"audio":"AQIDBA==","is_final":false}\n\n';

test('voice routes keep the selected language through transcription and playback', async (context) => {
  const calls = [];
  let audioSignal;
  let behavior;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new Request(url, options);
    const target = new URL(request.url);
    assert.equal(target.origin, provider);
    const key = request.headers.get('x-api-key-id');
    if (target.pathname === '/stt/v3') {
      const form = await request.formData();
      calls.push({
        path: target.pathname, key, language: form.get('language_code'),
        audio: Buffer.from(await form.get('audio_file').arrayBuffer()),
      });
      return Response.json({ success: true, transcript: 'तांदूळ दहा करा', detected_language_code: 'hi-IN' });
    }
    assert.equal(target.pathname, '/api/v1/tts/sse');
    const payload = await request.json();
    calls.push({ path: target.pathname, key, text: payload.text, language: payload.language, voice: payload.voice, model: payload.model });
    if (behavior === 'rate') return new Response(null, { status: 429 });
    const headers = { 'Content-Type': 'text/event-stream' };
    if (behavior === 'interrupt') {
      audioSignal = request.signal;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(audioChunk));
          request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true });
        },
      });
      return new Response(body, { headers });
    }
    return new Response('event: start\ndata: {}\n\n' + audioChunk + 'event: complete\ndata: {"is_final":true}\n\n', { headers });
  });

  const handlers = createDispatchHandlers({ store: await fixtureStore(context), identify: () => actor });
  const open = async () => (await handlers.session(new Request(dispatch + '/api/session?orderId=' + orderId + '&language=mr-IN'))).json();
  const original = {
    GNANI_API_KEY: process.env.GNANI_API_KEY,
    GNANI_BASE_URL: process.env.GNANI_BASE_URL,
    GNANI_STT_MODEL: process.env.GNANI_STT_MODEL,
    GNANI_TTS_MODEL: process.env.GNANI_TTS_MODEL,
    GNANI_TTS_VOICE: process.env.GNANI_TTS_VOICE,
  };
  context.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env.GNANI_API_KEY;
  const initial = await open();
  assert.equal(initial.voiceEnabled, false);
  assert.equal(initial.messages[0].language, 'mr-IN');
  assert.match(initial.messages[0].text, /तुम्हाला/);
  const sessionHeaders = { 'X-Session-Id': initial.sessionId };
  const speak = (text) => handlers.speak(new Request(dispatch + '/api/voice/speak', {
    method: 'POST', headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language: 'mr-IN' }),
  }));
  assert.equal((await speak('नमस्कार')).status, 503);

  process.env.GNANI_API_KEY = 'test-credential';
  process.env.GNANI_BASE_URL = provider;
  process.env.GNANI_STT_MODEL = 'prisma-v3.0';
  delete process.env.GNANI_TTS_MODEL;
  delete process.env.GNANI_TTS_VOICE;
  assert.equal((await open()).voiceEnabled, true);

  const wav = Buffer.alloc(46);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(38, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(2, 40);
  const transcribe = (audio) => handlers.transcribe(new Request(dispatch + '/api/voice/transcribe', {
    method: 'POST',
    headers: { ...sessionHeaders, 'Content-Type': 'audio/wav', 'X-Language': 'mr-IN' },
    body: audio,
  }));
  assert.equal((await transcribe(new Uint8Array(44))).status, 400);
  const transcribed = await transcribe(wav);
  assert.equal(transcribed.status, 200);
  assert.deepEqual(await transcribed.json(), { text: 'तांदूळ दहा करा', language: 'mr-IN' });

  const turn = await handlers.turn(new Request(dispatch + '/api/turn', {
    method: 'POST', headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'तांदूळ दहा करा', language: 'mr-IN' }),
  })).then(r => r.json());
  assert.equal((await speak('An unrelated phrase')).status, 409);
  const spoken = await speak(turn.reply);
  assert.equal(spoken.status, 200);
  assert.equal(spoken.headers.get('content-type'), 'audio/pcm');
  assert.equal(spoken.headers.get('x-sample-rate'), '24000');
  assert.deepEqual(Buffer.from(await spoken.arrayBuffer()), Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(calls, [
    { path: '/stt/v3', key: 'test-credential', language: 'mr-IN', audio: wav },
    { path: '/api/v1/tts/sse', key: 'test-credential', language: 'mr-IN', text: turn.reply, voice: 'Yashraj', model: 'timbre-v3.0' },
  ]);
  behavior = 'rate';
  assert.equal((await speak(turn.reply)).status, 429);

  behavior = 'interrupt';
  const playing = await speak(turn.reply);
  const reader = playing.body.getReader();
  const first = await reader.read();
  assert.deepEqual(Buffer.from(first.value), Buffer.from([1, 2, 3, 4]));
  await reader.cancel();
  assert.ok(audioSignal.aborted, 'interrupting playback cancels the upstream provider request');
});

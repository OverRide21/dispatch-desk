import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createDispatchServer } from '../server.mjs';

async function serve(server, context) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('voice routes forward audio, preserve detected language and stream PCM', async (context) => {
  const calls = [];
  const provider = await serve(createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const { url, headers } = request;
    if (url === '/stt/v3') {
      const envelope = new Request('http://localhost/mock', { method: 'POST', headers, body });
      const form = await envelope.formData();
      calls.push({
        path: url, key: headers['x-api-key-id'], language: form.get('language_code'),
        audio: Buffer.from(await form.get('audio_file').arrayBuffer()),
      });
      response.setHeader('Content-Type', 'application/json');
      return response.end(JSON.stringify({ success: true, transcript: 'तांदूळ दहा करा', detected_language_code: 'mr-IN' }));
    }
    const payload = JSON.parse(body);
    calls.push({ path: url, key: headers['x-api-key-id'], text: payload.text, language: payload.language });
    if (payload.text === 'Rate limit') {
      response.writeHead(429);
      return response.end();
    }
    response.setHeader('Content-Type', 'text/event-stream');
    response.write('event: start\ndata: {}\n\n');
    response.write('event: chunk\ndata: {"audio":"AQIDBA==","is_final":false}\n\n');
    response.end('event: complete\ndata: {"is_final":true}\n\n');
  }), context);

  const dispatch = await serve(createDispatchServer(), context);
  const open = () => fetch(dispatch + '/api/session').then((response) => response.json());
  const original = {
    GNANI_API_KEY: process.env.GNANI_API_KEY,
    GNANI_BASE_URL: process.env.GNANI_BASE_URL,
    GNANI_STT_MODEL: process.env.GNANI_STT_MODEL,
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
  const sessionHeaders = { 'X-Session-Id': initial.sessionId };
  const speak = (text) => fetch(dispatch + '/api/voice/speak', {
    method: 'POST', headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language: 'mr-IN' }),
  });
  assert.equal((await speak('नमस्कार')).status, 503);

  process.env.GNANI_API_KEY = 'test-credential';
  process.env.GNANI_BASE_URL = provider;
  process.env.GNANI_STT_MODEL = 'prisma-v3.0';
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
  const transcribed = await fetch(dispatch + '/api/voice/transcribe', {
    method: 'POST',
    headers: { ...sessionHeaders, 'Content-Type': 'audio/wav', 'X-Language': 'indic-auto' },
    body: wav,
  });
  assert.equal(transcribed.status, 200);
  assert.deepEqual(await transcribed.json(), { text: 'तांदूळ दहा करा', language: 'mr-IN' });

  const spoken = await speak('दहा पिशव्या करू का?');
  assert.equal(spoken.status, 200);
  assert.equal(spoken.headers.get('content-type'), 'audio/pcm');
  assert.equal(spoken.headers.get('x-sample-rate'), '24000');
  assert.deepEqual(Buffer.from(await spoken.arrayBuffer()), Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(calls, [
    { path: '/stt/v3', key: 'test-credential', language: 'indic-auto', audio: wav },
    { path: '/api/v1/tts/sse', key: 'test-credential', language: 'mr-IN', text: 'दहा पिशव्या करू का?' },
  ]);
  assert.equal((await speak('Rate limit')).status, 429);
});

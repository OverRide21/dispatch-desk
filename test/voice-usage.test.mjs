import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchHandlers } from '../src/http.mjs';
import { openLocalSqlite } from '../src/sqlite.mjs';
import { createVoiceUsage, setupVoiceUsage, wavDurationMilliseconds } from '../src/voice-usage.mjs';
import { actor, fixtureStore, orderId } from './order-fixture.mjs';

function pcmWav(samples) {
  const bytes = samples * 2;
  const result = Buffer.alloc(44 + bytes);
  result.write('RIFF', 0);
  result.writeUInt32LE(36 + bytes, 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16_000, 24);
  result.writeUInt32LE(32_000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36);
  result.writeUInt32LE(bytes, 40);
  return result;
}

test('WAV usage comes from validated PCM sample data and rounds up to milliseconds', () => {
  const wav = pcmWav(20_001);
  assert.equal(wavDurationMilliseconds(wav), 1251);
  assert.equal(wavDurationMilliseconds(pcmWav(1)), 1);
  assert.throws(() => wavDurationMilliseconds(wav.subarray(0, -1)), { code: 'voice-invalid-wav' });
  wav.writeUInt32LE(100_000_000, 28);
  assert.throws(() => wavDurationMilliseconds(wav), { code: 'voice-invalid-wav' });
  assert.throws(() => wavDurationMilliseconds(pcmWav(0)), { code: 'voice-invalid-wav' });
});

test('voice reservations share a daily workspace budget and remain atomic across simultaneous calls', async t => {
  const db = openLocalSqlite(':memory:');
  t.after(() => db.close());
  await setupVoiceUsage(db);
  let clock = new Date('2026-11-08T23:59:30Z');
  const usage = createVoiceUsage(db, () => clock);
  await usage.setLimits('alpha', { transcriptionSeconds: 1, synthesisCharacters: 12 });
  const results = await Promise.allSettled([
    usage.reserve('alpha', 'first', { transcriptionMilliseconds: 600 }),
    usage.reserve('alpha', 'second', { transcriptionMilliseconds: 600 }),
  ]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected')?.reason.code, 'voice-budget-exhausted');
  await usage.reserve('alpha', 'first', { synthesisCharacters: 12 });
  await assert.rejects(usage.reserve('alpha', 'first', { synthesisCharacters: 1 }), { code: 'voice-budget-exhausted' });
  await usage.reserve('other', 'first', { transcriptionMilliseconds: 2000 });
  assert.deepEqual(await usage.summary('alpha', 'first'), {
    day: '2026-11-08',
    limits: { transcriptionSeconds: 1, synthesisCharacters: 12 },
    today: { transcriptionSeconds: 0.6, synthesisCharacters: 12 },
    call: { transcriptionSeconds: 0.6, synthesisCharacters: 12 },
  });
  assert.deepEqual((await usage.summary('other', 'first')).today, { transcriptionSeconds: 2, synthesisCharacters: 0 });
  clock = new Date('2026-11-09T00:01:00Z');
  await usage.reserve('alpha', 'first', { transcriptionMilliseconds: 1000 });
  assert.deepEqual(await usage.summary('alpha', 'first'), {
    day: '2026-11-09',
    limits: { transcriptionSeconds: 1, synthesisCharacters: 12 },
    today: { transcriptionSeconds: 1, synthesisCharacters: 0 },
    call: { transcriptionSeconds: 1.6, synthesisCharacters: 12 },
  });
});

test('voice limits accept blank and zero values and leave the other operation available', async t => {
  const db = openLocalSqlite(':memory:');
  t.after(() => db.close());
  await setupVoiceUsage(db);
  await setupVoiceUsage(db);
  const usage = createVoiceUsage(db);
  await assert.rejects(usage.setLimits('desk', { transcriptionSeconds: 1.5, synthesisCharacters: null }), { code: 'voice-budget-invalid' });
  await usage.setLimits('desk', { transcriptionSeconds: 0, synthesisCharacters: null });
  await assert.rejects(usage.reserve('desk', 'first', { transcriptionMilliseconds: 1 }), { code: 'voice-budget-exhausted' });
  await usage.reserve('desk', 'first', { synthesisCharacters: 100 });
  assert.deepEqual((await usage.summary('desk')).today, { transcriptionSeconds: 0, synthesisCharacters: 100 });
});

test('authenticated usage endpoints enforce admin edits and stop requests before Gnani', async t => {
  const previousKey = process.env.GNANI_API_KEY;
  process.env.GNANI_API_KEY = 'test-credential';
  t.after(() => {
    if (previousKey === undefined) delete process.env.GNANI_API_KEY;
    else process.env.GNANI_API_KEY = previousKey;
  });
  const provider = t.mock.method(globalThis, 'fetch', async () => Response.json({
    success: true, transcript: 'तांदूळ दहा करा', detected_language_code: 'mr-IN',
  }));
  const store = await fixtureStore(t);
  const handlers = createDispatchHandlers({
    store,
    identify: request => request.headers.get('x-operator') ? { ...actor, role: 'operator' } : actor,
  });
  const base = 'http://dispatch.test';
  const request = (path, init) => new Request(base + path, init);
  const edit = (limits, headers) => handlers.saveVoiceUsage(request('/api/voice/usage', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(limits),
  }));
  assert.equal((await edit({ transcriptionSeconds: 1, synthesisCharacters: 0 }, { 'x-operator': '1' })).status, 403);
  assert.equal((await edit({ transcriptionSeconds: 1, synthesisCharacters: 0 })).status, 200);
  const session = await (await handlers.session(request('/api/session?orderId=' + orderId + '&language=mr-IN'))).json();
  const callHeaders = { 'x-session-id': session.sessionId };
  const transcribe = () => handlers.transcribe(request('/api/voice/transcribe', {
    method: 'POST', headers: { ...callHeaders, 'Content-Type': 'audio/wav', 'X-Language': 'mr-IN' }, body: pcmWav(16_000),
  }));
  assert.equal((await transcribe()).status, 200);
  const rejected = await transcribe();
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).code, 'voice-budget-exhausted');
  const speech = await handlers.speak(request('/api/voice/speak', {
    method: 'POST', headers: { ...callHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: session.messages.at(-1).text, language: 'mr-IN' }),
  }));
  assert.equal(speech.status, 429);
  assert.equal((await speech.json()).code, 'voice-budget-exhausted');
  assert.equal(provider.mock.callCount(), 1);
  const summary = await handlers.voiceUsage(request('/api/voice/usage', { headers: callHeaders }));
  assert.equal(summary.status, 200);
  assert.deepEqual((await summary.json()).call, { transcriptionSeconds: 1, synthesisCharacters: 0 });
});

test('a Fast voice turn transcribes and proposes a change in one request under the speech budget', async t => {
  const previousKey = process.env.GNANI_API_KEY;
  process.env.GNANI_API_KEY = 'test-credential';
  t.after(() => {
    if (previousKey === undefined) delete process.env.GNANI_API_KEY;
    else process.env.GNANI_API_KEY = previousKey;
  });
  const provider = t.mock.method(globalThis, 'fetch', async () => Response.json({
    success: true, transcript: 'तांदूळ दहा करा', detected_language_code: 'mr-IN',
  }));
  const store = await fixtureStore(t);
  await store.voiceUsage.setLimits(actor.workspaceId, { transcriptionSeconds: 1, synthesisCharacters: null });
  const handlers = createDispatchHandlers({ store, identify: () => actor });
  const url = 'http://dispatch.test';
  const session = await handlers.session(new Request(url + '/api/session?orderId=' + orderId)).then(r => r.json());
  const speak = revision => handlers.turn(new Request(url + '/api/turn', {
    method: 'POST',
    headers: { 'X-Session-Id': session.sessionId, 'X-Session-Revision': revision, 'Content-Type': 'audio/wav', 'X-Language': 'mr-IN' },
    body: pcmWav(16_000),
  }));
  const response = await speak(session.revision);
  assert.equal(response.status, 200);
  const turn = await response.json();
  assert.equal(turn.replySource, 'rules');
  assert.equal(turn.language, 'mr-IN');
  assert.equal(turn.pending.to, 10);
  assert.equal((await speak(turn.revision)).status, 429);
  assert.equal(provider.mock.callCount(), 1);
});

test('automatic voice turns route the Gnani transcript to order data or Sarvam', async t => {
  for (const key of ['GNANI_API_KEY', 'SARVAM_API_KEY']) {
    const previous = process.env[key];
    process.env[key] = 'test-credential';
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  let transcript = 'साखर रवाना झाली आहे का?';
  const models = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    if (url === 'https://api.sarvam.ai/v1/chat/completions') {
      models.push(JSON.parse(JSON.parse(request.body).messages[1].content).request);
      const action = { type: 'set', line: 1, quantity: 10, unit: 'bags', name: null };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(action) } }] });
    }
    return Response.json({ success: true, transcript, detected_language_code: 'mr-IN' });
  });
  const store = await fixtureStore(t);
  const handlers = createDispatchHandlers({ store, identify: () => actor });
  const url = 'http://dispatch.test';
  const session = await handlers.session(new Request(url + '/api/session?orderId=' + orderId)).then(r => r.json());
  const speak = async revision => {
    const response = await handlers.turn(new Request(url + '/api/turn', {
      method: 'POST',
      headers: { 'X-Session-Id': session.sessionId, 'X-Session-Revision': revision, 'Content-Type': 'audio/wav',
        'X-Language': 'mr-IN', 'X-Reply-Provider': 'auto' },
      body: pcmWav(16_000),
    }));
    assert.equal(response.status, 200);
    return response.json();
  };
  const lookup = await speak(session.revision);
  assert.equal(lookup.interpretationSource, 'order-data');
  assert.deepEqual(models, []);
  transcript = 'तांदूळ दहा करा';
  const edit = await speak(lookup.revision);
  assert.equal(edit.interpretationSource, 'sarvam');
  assert.equal(edit.language, 'mr-IN');
  assert.equal(edit.pending.to, 10);
  assert.deepEqual(models, [transcript]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { ollamaEnabled, personalizeReply, warmOllama } from '../src/ollama.mjs';

const hindi = {
  text: 'बारह नहीं, दस कर दो',
  reply: 'चावल की दस बोरियाँ कर सकता हूँ। क्या यह बदलाव कर दूँ?',
  language: 'hi-IN',
};
const marathi = {
  text: 'बारा नाही, दहा करा',
  reply: 'तांदळाच्या दहा पिशव्या करता येतील. हा बदल करू का?',
  language: 'mr-IN',
};
const rules = ({ reply }) => ({ reply, source: 'rules' });
const response = (content) => Response.json({ message: { content } });

function configure(t, model = 'qwen3.5:4b') {
  const previous = { enabled: process.env.OLLAMA_ENABLED, model: process.env.OLLAMA_MODEL };
  process.env.OLLAMA_ENABLED = '1';
  process.env.OLLAMA_MODEL = model;
  t.after(() => {
    if (previous.enabled === undefined) delete process.env.OLLAMA_ENABLED;
    else process.env.OLLAMA_ENABLED = previous.enabled;
    if (previous.model === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = previous.model;
  });
}

test('Qwen selects short language-specific openers and leaves the order reply intact', async (t) => {
  configure(t);
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(options.redirect, 'error');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'qwen3.5:4b');
    assert.equal(payload.think, false);
    assert.equal(payload.stream, false);
    assert.deepEqual(payload.format.properties.opener.enum, ['none', 'noted', 'understood']);
    return response('{"opener":"understood"}');
  });
  assert.deepEqual(await personalizeReply(hindi), { reply: `समझ गया। ${hindi.reply}`, source: 'ollama' });
  assert.deepEqual(await personalizeReply(marathi), { reply: `समजलं. ${marathi.reply}`, source: 'ollama' });
  assert.equal(fetch.mock.callCount(), 2);
});

test('acknowledgments, an already introduced reply, and unavailable configurations skip Qwen', async (t) => {
  configure(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => response('{"opener":"noted"}'));
  const confirmation = { ...hindi, text: 'हाँ, कर दीजिए।', reply: 'हो गया। ऑर्डर में अब दस बोरियाँ हैं।' };
  assert.deepEqual(await personalizeReply(confirmation), rules(confirmation));
  const acknowledged = { ...marathi, reply: 'ठीक आहे, ऑर्डर जशी होती तशीच ठेवली आहे.' };
  assert.deepEqual(await personalizeReply(acknowledged), rules(acknowledged));
  const shipped = { ...marathi, text: 'साखर काढा', reply: 'साखर आधीच पाठवली आहे. त्यात आता बदल करता येणार नाही.' };
  assert.deepEqual(await personalizeReply(shipped), rules(shipped));
  assert.deepEqual(await personalizeReply({ ...hindi, signal: AbortSignal.abort() }), rules(hindi));

  process.env.OLLAMA_MODEL = 'qwen3.5:cloud';
  assert.equal(ollamaEnabled(), false);
  assert.deepEqual(await personalizeReply(marathi), rules(marathi));
  process.env.OLLAMA_MODEL = 'qwen3.5:4b';
  process.env.OLLAMA_ENABLED = '0';
  assert.equal(ollamaEnabled(), false);
  assert.deepEqual(await personalizeReply(marathi), rules(marathi));
  assert.equal(fetch.mock.callCount(), 0);
});

test('the prior opener is excluded, and choosing none keeps the rule reply intact', async (t) => {
  configure(t);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { format } = JSON.parse(options.body);
    assert.deepEqual(format.properties.opener.enum, ['none', 'noted']);
    return response('{"opener":"none"}');
  });
  const input = { ...marathi, previousReply: 'समजलं. साखर पाठवली आहे.' };
  assert.deepEqual(await personalizeReply(input), { reply: marathi.reply, source: 'ollama' });
});

test('wrong selectors, generated facts, transport failures, and aborted requests fall back', async (t) => {
  configure(t);
  const results = [
    () => response('{"opener":"समजलं. साखर आता काढली आहे."}'),
    () => response('{"opener":"noted","reply":"Added sugar."}'),
    () => response('{"opener":"__proto__"}'),
    () => response('{"opener":false}'),
    () => response('model returned plain text'),
    () => new Response(null, { status: 503 }),
    () => { throw new Error('connection failed'); },
  ];
  t.mock.method(globalThis, 'fetch', async () => results.shift()());
  while (results.length) assert.deepEqual(await personalizeReply(marathi), rules(marathi));

  const caller = new AbortController();
  globalThis.fetch.mock.mockImplementation(async (_url, { signal }) => {
    caller.abort();
    assert.equal(signal.aborted, true);
    return response('{"opener":"noted"}');
  });
  assert.deepEqual(await personalizeReply({ ...marathi, signal: caller.signal }), rules(marathi));
});

test('warmup is shared, renews loaded models without generation, and recovers from eviction', async (t) => {
  configure(t);
  const preload = Promise.withResolvers();
  let resident = true;
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/api/ps')) return Response.json({ models: resident ? [{ name: 'qwen3.5:4b' }] : [] });
    const payload = JSON.parse(options.body);
    assert.equal(payload.keep_alive, '10m');
    if (!payload.messages) {
      assert.equal(payload.model, 'qwen3.5:4b');
      assert.equal(payload.options.num_ctx, 2048);
      return Response.json({ done: true, done_reason: 'load' });
    }
    assert.equal(payload.messages.length, 2);
    const { language } = JSON.parse(payload.messages[1].content);
    return language === 'en-IN' ? (await preload.promise).clone() : response('{"opener":"noted"}');
  });

  const first = warmOllama();
  try {
    assert.strictEqual(warmOllama(), first);
    assert.deepEqual(await personalizeReply(marathi), rules(marathi));
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    preload.resolve(response('{"opener":"none"}'));
  }
  assert.equal(await first, true);
  assert.equal(await warmOllama(), true);
  assert.equal(fetch.mock.callCount(), 3);
  resident = false;
  assert.equal(await warmOllama(), true);
  assert.equal(fetch.mock.callCount(), 5);
  assert.deepEqual(await personalizeReply(marathi), { reply: `ठीक आहे. ${marathi.reply}`, source: 'ollama' });
  assert.equal(fetch.mock.callCount(), 6);
});

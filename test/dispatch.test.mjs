import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchHandlers } from '../src/http.mjs';
import { createSession, handleTurn, snapshot } from '../src/orders.mjs';
import { createStore } from '../src/store.mjs';
import { dialogueCases } from './dialogue-cases.mjs';
import { actor, fixtureOrder, fixtureStore, orderId, workspaceId } from './order-fixture.mjs';

const base = 'http://dispatch.test';

async function call(handlers, route, { headers, body, signal } = {}) {
  const method = route === 'session' ? 'GET' : 'POST';
  return handlers[route](new Request(base + '/api/' + route + (route === 'session' ? '?orderId=' + orderId : ''), {
    method,
    headers,
    body: body && JSON.stringify(body),
    signal,
  }));
}

function quantities(view) {
  const quantitiesById = Object.fromEntries(view.order.items.map(({ id, quantity }) => [id, quantity]));
  const pending = view.pending ? { itemId: view.pending.itemId, to: view.pending.to } : null;
  return { ...quantitiesById, changes: view.history.length, pending };
}

test('public sample calls keep confirmed edits isolated from other visitors and the workspace', async context => {
  const store = await fixtureStore(context);
  const handlers = createDispatchHandlers({ store, identify: () => null });
  const open = (id, language = 'en-IN') => call(handlers, 'guestSession', {
    headers: { 'Content-Type': 'application/json', ...(id ? { 'X-Session-Id': id } : {}) },
    body: { language, orderId },
  });
  const first = await open().then(r => r.json());
  const second = await open().then(r => r.json());
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(first.order.id, 'SAMPLE-1048');
  assert.equal(first.order.items[0].quantity, 24);
  const send = (sessionId, text) => call(handlers, 'turn', {
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
    body: { text, language: 'en-IN', replyProvider: 'rules' },
  });
  const proposal = await send(first.sessionId, 'Set rice to 12 bags.').then(r => r.json());
  assert.equal(proposal.pending.to, 12);
  assert.equal(proposal.order.items[0].quantity, 24);
  const updated = await send(first.sessionId, 'Confirm').then(r => r.json());
  assert.equal(updated.order.items[0].quantity, 12);
  assert.equal(updated.history.length, 1);
  assert.equal((await open(first.sessionId).then(r => r.json())).order.items[0].quantity, 12);
  assert.equal((await open(second.sessionId).then(r => r.json())).order.items[0].quantity, 24);
  assert.equal((await store.getOrder(actor.workspaceId, orderId)).items[0].quantity, 20);
  for (const route of ['orders', 'catalog', 'session']) {
    assert.equal((await handlers[route](new Request(base + '/api/' + route, {
      headers: { 'X-Session-Id': first.sessionId },
    }))).status, 401);
  }
  assert.equal((await open(undefined, 'invalid')).status, 400);
});

test('Hindi and Marathi fixtures cover 200 unique call paths', async (context) => {
  assert.equal(dialogueCases.length, 200);
  assert.equal(new Set(dialogueCases.map((scenario) => scenario.id)).size, 200);
  for (const scenario of dialogueCases) {
    await context.test(scenario.id, () => {
      const session = createSession(fixtureOrder());
      const run = (text) => {
        const turn = handleTurn(session, { text, language: scenario.language });
        assert.ok(turn.reply.trim(), text);
        assert.equal(turn.language, scenario.language);
      };
      scenario.before.forEach(run);
      run(scenario.utterance);
      if (scenario.mid) assert.deepEqual(quantities(snapshot(session)), scenario.mid, scenario.utterance);
      scenario.after.forEach(run);
      assert.deepEqual(quantities(snapshot(session)), scenario.expected, scenario.utterance);
    });
  }
});

test('both Marathi possessive forms match sugar and respect its dispatch status', () => {
  const requests = [
    'साखरेच्या 8 पिशव्यांच्या ऐवजी 2 पिशव्या करा।',
    'साखरच्या 8 पिशव्यांच्या ऐवजी 2 पिशव्या करा।',
    'साखरच्या 8 पिशव्यांच्या ऐवजी 2 पिशव्या द्या।',
    'साखरच्या दोन पिशव्या।',
  ];
  const shipped = createSession(fixtureOrder(), 'mr-IN');
  const editableOrder = fixtureOrder();
  editableOrder.items.find(item => item.id === 'sugar').status = 'pending';
  const editable = createSession(editableOrder, 'mr-IN');
  for (const text of requests) {
    const blocked = handleTurn(shipped, { text, language: 'mr-IN' });
    assert.match(blocked.reply, /साखर.*रवाना.*आता बदल करता येणार नाही/u);
    assert.deepEqual(quantities(shipped), { rice: 20, sugar: 8, oil: 6, changes: 0, pending: null });

    const proposed = handleTurn(editable, { text, language: 'mr-IN' });
    assert.match(proposed.reply, /साखरेच्या दोन पिशव्या/u);
    assert.deepEqual(quantities(editable), { rice: 20, sugar: 8, oil: 6, changes: 0, pending: { itemId: 'sugar', to: 2 } });
  }
  const status = handleTurn(shipped, { text: 'साखर।', language: 'mr-IN' });
  assert.match(status.reply, /साखरेच्या आठ पिशव्या.*रवाना/u);
});

test('unreasonable order changes explain the failed rule and clear stale proposals', () => {
  const session = createSession(fixtureOrder(), 'mr-IN');
  const turn = text => handleTurn(session, { text, language: 'mr-IN' });
  const cases = [
    ['तांदूळ उणे दोन पिशव्या करा.', /शून्यापेक्षा कमी/u],
    ['तांदूळ 2.5 पिशव्या करा.', /पूर्ण संख्येत/u],
    ['तांदूळ 1000001 पिशव्या करा.', /जास्तीत जास्त 1000000 पिशव्या/u],
    ['तांदूळ दोन बाटल्या करा.', /एकक पिशव्या/u],
    ['साखर काढा.', /रवाना.*काढताही येणार नाही/u],
  ];
  for (const [text, reason] of cases) {
    assert.equal(turn('तांदूळ बारा पिशव्या करा.').rejectedChange, undefined);
    assert.equal(session.pending?.to, 12);
    const rejected = turn(text);
    assert.equal(rejected.rejectedChange, true);
    assert.match(rejected.reply, reason);
    assert.equal(session.pending, null);
    turn('हो, बदल करा.');
    assert.deepEqual(quantities(session), { rice: 20, sugar: 8, oil: 6, changes: 0, pending: null });
  }
});

test('off-topic questions redirect politely without reading the order or replacing a draft', () => {
  const session = createSession(fixtureOrder(), 'en-IN');
  const turn = (text, language = 'en-IN') => handleTurn(session, { text, language });
  turn('Set rice to 12 bags.');
  const requests = [
    ['What is 2 + 2?', 'en-IN', /only help with the order/u],
    ['How do I cook rice?', 'en-IN', /outside what I can help with/u],
    ['How do I make rice with two bags?', 'en-IN', /only help with the order/u],
    ['I sent my friend a message. Can you read it?', 'en-IN', /outside what I can help with/u],
    ['उद्या पाऊस पडेल का?', 'mr-IN', /फक्त तुमच्या उघड्या ऑर्डरबद्दल/u],
    ['दिल्ली की आबादी कितनी है?', 'hi-IN', /सिर्फ़ आपके खुले ऑर्डर/u],
  ];
  for (const [text, language, scope] of requests) {
    assert.match(turn(text, language).reply, scope);
    assert.deepEqual(quantities(session), { rice: 20, sugar: 8, oil: 6, changes: 0, pending: { itemId: 'rice', to: 12 } });
  }
  assert.match(turn('What is the order status?').reply, /Sugar.*already shipped/u);
  assert.match(turn('साखर पाठवली आहे का?', 'mr-IN').reply, /साखरेच्या आठ पिशव्या.*रवाना/u);
});

test('production call saves only after confirmation and isolates users', async (context) => {
  const store = await fixtureStore(context);
  const handlers = createDispatchHandlers({
    store,
    identify: (request) => request.headers.get('X-Other-User') ? { ...actor, sessionId: 'other-login' } : actor,
    styleReply: async ({ reply }) => ({ reply, source: 'rules' }),
  });
  const first = await call(handlers, 'session').then(r => r.json());
  const turn = (text, language, revision, extra) => call(handlers, 'turn', {
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': first.sessionId, 'X-Session-Revision': String(revision), ...extra },
    body: { text, language },
  });
  const proposed = await turn('तांदूळ 12 करा आणि साखर काढा', 'mr-IN', 0).then(r => r.json());
  assert.equal(proposed.pending.to, 12);
  assert.equal((await store.getOrder(workspaceId, orderId)).items.find(item => item.id === 'rice').quantity, 20);
  const corrected = await turn('बारह नहीं, दस कर दो', 'hi-IN', proposed.revision).then(r => r.json());
  assert.equal(corrected.pending.to, 10);
  assert.equal((await turn('Confirm', 'en-IN', proposed.revision)).status, 409);
  assert.equal((await turn('Confirm', 'en-IN', corrected.revision, { 'X-Other-User': '1' })).status, 409);
  const saved = await turn('हाँ, कर दीजिए', 'hi-IN', corrected.revision).then(r => r.json());
  assert.deepEqual(quantities(saved), { rice: 10, sugar: 8, oil: 6, changes: 1, pending: null });
  assert.equal((await store.getOrder(workspaceId, orderId)).items.find(item => item.id === 'rice').quantity, 10);
  const repeated = await turn('Confirm', 'en-IN', saved.revision).then(r => r.json());
  assert.equal(repeated.history.length, 1);
});

test('stale order revision clears a draft after another operator changes the order', async (context) => {
  const store = await fixtureStore(context);
  const handlers = createDispatchHandlers({ store, identify: () => actor });
  const view = await call(handlers, 'session').then(r => r.json());
  const headers = { 'Content-Type': 'application/json', 'X-Session-Id': view.sessionId };
  const turn = text => call(handlers, 'turn', { headers, body: { text, language: 'en-IN' } });
  assert.equal((await turn('Change rice to 12').then(r => r.json())).pending.to, 12);
  await store.saveQuantity(workspaceId, orderId, {
    itemId: 'rice', quantity: 16, revision: view.order.revision, actor: 'other-operator',
  });
  const stale = await turn('Confirm');
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'order-stale');
  const updated = await call(handlers, 'session', { headers }).then(r => r.json());
  assert.equal(updated.pending, null);
  assert.equal(updated.order.items.find(item => item.id === 'rice').quantity, 16);
});

test('new items and removals are confirmed, audited, and shipped items stay locked', async (context) => {
  const store = await fixtureStore(context);
  const handlers = createDispatchHandlers({ store, identify: () => actor });
  const opened = await call(handlers, 'session').then(r => r.json());
  const headers = { 'Content-Type': 'application/json', 'X-Session-Id': opened.sessionId };
  const turn = async (text, language, itemAction) => {
    const response = await call(handlers, 'turn', { headers, body: { text, language, itemAction, replyProvider: 'rules' } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const proposal = await turn('ग्रीन टी दोन बॉक्स टाका', 'mr-IN');
  assert.equal(proposal.pending.to, 2);
  assert.equal(proposal.pending.newItem.unit, 'boxes');
  assert.equal(proposal.order.items.length, 3);
  const revised = await turn('दो नहीं, तीन कर दो', 'hi-IN');
  assert.equal(revised.pending.to, 3);
  const added = await turn('हाँ, कर दीजिए', 'hi-IN');
  const item = added.order.items.find(line => line.name === 'ग्रीन टी');
  assert.equal(item.quantity, 3);
  assert.deepEqual([added.history[0].from, added.history[0].to], [0, 3]);

  const blocked = await turn('Remove sugar.', 'en-IN', { type: 'remove', itemId: 'sugar' });
  assert.equal(blocked.pending, null);
  assert.match(blocked.reply, /already shipped/);
  const removal = await turn('Remove green tea.', 'en-IN', { type: 'remove', itemId: item.id });
  assert.equal(removal.pending.to, 0);
  assert.equal(removal.order.items.find(line => line.id === item.id).quantity, 3);
  const removed = await turn('Confirm.', 'en-IN');
  assert.deepEqual([removed.history[0].from, removed.history[0].to], [3, 0]);
  assert.equal((await store.listOrders(workspaceId))[0].itemCount, 3);
  const restore = await turn('Add green tea.', 'en-IN', { type: 'add', name: 'ग्रीन टी', quantity: 4, unit: 'boxes' });
  assert.equal(restore.pending.itemId, item.id);
  const restored = await turn('Confirm.', 'en-IN');
  assert.equal(restored.order.items.filter(line => line.id === item.id).length, 1);
  assert.equal(restored.order.items.find(line => line.id === item.id).quantity, 4);
});

test('the desk can switch between Groq, local Qwen, Hari, and built-in replies', async (context) => {
  const previousKey = process.env.GROQ_API_KEY;
  const previousLocal = process.env.OLLAMA_ENABLED;
  const previousHari = process.env.OLLAMA_HARI_ENABLED;
  process.env.GROQ_API_KEY = 'test-key';
  process.env.OLLAMA_ENABLED = '1';
  process.env.OLLAMA_HARI_ENABLED = '0';
  context.after(() => {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
    if (previousLocal === undefined) delete process.env.OLLAMA_ENABLED;
    else process.env.OLLAMA_ENABLED = previousLocal;
    if (previousHari === undefined) delete process.env.OLLAMA_HARI_ENABLED;
    else process.env.OLLAMA_HARI_ENABLED = previousHari;
  });
  const providers = [];
  let choice = '2';
  context.mock.method(globalThis, 'fetch', async (url, request) => {
    const { model, messages, format } = JSON.parse(request.body);
    providers.push(model);
    if (url.startsWith('http://127.0.0.1:11434/')) {
      if (model === 'hari:q8') {
        return Response.json({ message: { content: format.properties.wording ? '{"wording":"2"}' : '{"opener":"none"}' } });
      }
      return Response.json({ message: { content: '{"opener":"understood"}' } });
    }
    assert.equal(request.headers.Authorization, 'Bearer test-key');
    assert.equal(model, 'qwen/qwen3.8-27b');
    assert.match(messages[1].content, /\{amount\}/u);
    assert.doesNotMatch(messages[1].content, /तांदूळ|साखर|DD-2048/u);
    return Response.json({ choices: [{ message: { content: choice } }] });
  });
  const store = await fixtureStore(context);
  const handlers = createDispatchHandlers({ store, identify: () => actor });
  const disabled = await call(handlers, 'session').then(r => r.json());
  assert.deepEqual(disabled.replyProviders, ['rules', 'auto', 'groq', 'ollama']);
  process.env.OLLAMA_HARI_ENABLED = '1';
  const view = await call(handlers, 'session').then(r => r.json());
  assert.deepEqual(view.replyProviders, ['rules', 'auto', 'groq', 'ollama', 'ollama-hari']);
  const headers = { 'Content-Type': 'application/json', 'X-Session-Id': view.sessionId };
  const turn = async (text, replyProvider) => {
    const response = await call(handlers, 'turn', { headers, body: { text, language: 'mr-IN', replyProvider } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const proposal = await turn('तांदूळ 12 करा आणि साखर काढा', 'groq');
  assert.equal(proposal.replySource, 'groq');
  assert.match(proposal.reply, /साखर.*रवाना.*बारा.*ठेवू का\?/u);
  assert.equal(proposal.pending.to, 12);
  assert.equal(proposal.order.items.find(item => item.id === 'rice').quantity, 20);
  const local = await turn('बारा नको दहा करा', 'ollama');
  assert.equal(local.replySource, 'ollama');
  assert.equal(local.pending.to, 10);
  const hari = await turn('दहा नको अकरा करा', 'ollama-hari');
  assert.equal(hari.replySource, 'ollama-hari');
  assert.match(hari.reply, /^ठीक आहे, तांदळाच्या अकरा पिशव्या/u);
  assert.equal(hari.pending.to, 11);
  assert.equal(hari.order.items.find(item => item.id === 'rice').quantity, 20);
  const builtIn = await turn('नऊ करा');
  assert.equal(builtIn.replySource, 'rules');
  assert.equal(builtIn.pending.to, 9);
  choice = 'Invalid model reply';
  const saved = await turn('हो, बदल करा', 'groq');
  assert.equal(saved.replySource, 'rules');
  assert.equal(saved.order.items.find(item => item.id === 'rice').quantity, 9);
  assert.deepEqual(providers, ['qwen/qwen3.8-27b', 'qwen3.5:4b', 'hari:q8', 'qwen/qwen3.8-27b']);

  const unclear = await turn('काहीतरी बदलायचं आहे', 'ollama-hari');
  const repeated = await turn('काहीतरी बदलायचं आहे', 'ollama-hari');
  assert.equal(unclear.replySource, 'ollama-hari');
  assert.equal(repeated.replySource, 'ollama-hari');
  assert.notEqual(repeated.reply, unclear.reply);
  assert.equal(repeated.pending, null);
  const blocked = await turn('साखर काढा.', 'ollama-hari');
  assert.equal(blocked.replySource, 'ollama-hari');
  assert.match(blocked.reply, /^साखर.*रवाना.*काढताही येणार नाही/u);
  assert.equal(blocked.pending, null);
});

test('overlapping requests cannot replace a reply while Ollama styles it', async (context) => {
  const previousLocal = process.env.OLLAMA_ENABLED;
  process.env.OLLAMA_ENABLED = '1';
  context.after(() => {
    if (previousLocal === undefined) delete process.env.OLLAMA_ENABLED;
    else process.env.OLLAMA_ENABLED = previousLocal;
  });
  const store = await fixtureStore(context);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const handlers = createDispatchHandlers({
    store, identify: () => actor,
    styleReply: async ({ reply }) => { entered(); await hold; return { reply, source: 'rules' }; },
  });
  const view = await call(handlers, 'session').then(r => r.json());
  const headers = { 'Content-Type': 'application/json', 'X-Session-Id': view.sessionId };
  const send = text => call(handlers, 'turn', { headers, body: { text, language: 'en-IN', replyProvider: 'ollama' } });
  const first = send('Change rice to 12');
  try {
    await Promise.race([started, first.then(() => assert.fail('Ollama was skipped'))]);
    const busy = await send('Confirm');
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).code, 'session-busy');
  } finally {
    release();
  }
  assert.equal((await first.then(r => r.json())).pending.to, 12);
});

test('a Hari confirmation waits for the model and remains retryable after failure', async (context) => {
  for (const name of ['OLLAMA_ENABLED', 'OLLAMA_HARI_ENABLED']) {
    const previous = process.env[name];
    process.env[name] = '1';
    context.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const started = Promise.withResolvers();
  const modelResponse = Promise.withResolvers();
  const model = context.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { model, format } = JSON.parse(request.body);
    assert.equal(model, 'hari:q8');
    assert.deepEqual(format.properties.opener.enum, ['none']);
    started.resolve();
    return modelResponse.promise;
  });
  const store = await fixtureStore(context);
  const handlers = createDispatchHandlers({ store, identify: () => actor });
  const view = await call(handlers, 'session').then(response => response.json());
  const headers = { 'Content-Type': 'application/json', 'X-Session-Id': view.sessionId };
  const send = (text, replyProvider) => call(handlers, 'turn', {
    headers, body: { text, language: 'en-IN', replyProvider },
  });
  const proposal = await send('Change rice to 12', 'rules').then(response => response.json());
  headers['X-Session-Revision'] = String(proposal.revision);

  const confirmation = send('Confirm.', 'ollama-hari');
  try {
    await Promise.race([started.promise, confirmation.then(() => assert.fail('Hari was skipped'))]);
    const order = await store.getOrder(actor.workspaceId, view.order.id);
    assert.equal(order.items.find(item => item.id === 'rice').quantity, 20);
  } finally {
    modelResponse.resolve(new Response(null, { status: 503 }));
  }
  const failed = await confirmation;
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).code, 'hari-unavailable');
  assert.equal((await store.getCall(view.sessionId, actor)).revision, proposal.revision);

  model.mock.mockImplementation(async () => Response.json({ message: { content: '{"opener":"none"}' } }));
  const retry = await send('Confirm.', 'ollama-hari');
  assert.equal(retry.status, 200);
  const saved = await retry.json();
  assert.equal(saved.replySource, 'ollama-hari');
  assert.equal(saved.order.items.find(item => item.id === 'rice').quantity, 12);
  assert.equal(saved.history.length, 1);
});

test('imported names and SKUs work without a hardcoded product catalog', () => {
  const session = createSession({ id: 'PO-7', customer: 'North Market', items: [
    { id: 'L1', sku: 'TEA-50', name: 'Green tea', nameMr: 'हिरवा चहा', aliases: ['ग्रीन टी'], quantity: 20, unit: 'boxes', status: 'pending' },
    { id: 'L2', sku: 'TEA-10', name: 'Tea', quantity: 6, unit: 'boxes', status: 'pending' },
  ] });
  handleTurn(session, { text: 'Change TEA-50 to 5', language: 'en-IN' });
  assert.equal(session.pending?.itemId, 'L1');
  assert.equal(session.pending?.to, 5);
  handleTurn(session, { text: 'ग्रीन टी चार बॉक्स करा', language: 'mr-IN' });
  assert.equal(session.pending?.to, 4);
  handleTurn(session, { text: 'हो करा', language: 'mr-IN' });
  assert.deepEqual(session.order.items.map(item => item.quantity), [4, 6]);
});

test('a storefront product can be addressed without reading its parenthesized pack size', () => {
  const session = createSession({ id: 'SHOP-1', customer: 'Customer', items: [
    { id: 'SUGAR', sku: 'KM-SUGAR', name: 'Sugar (1 kg)', quantity: 1, unit: 'bags', status: 'pending' },
  ] }, 'en-IN');
  handleTurn(session, { text: 'Set sugar to 2 bags.', language: 'en-IN' });
  assert.equal(session.pending?.itemId, 'SUGAR');
  assert.equal(session.pending?.to, 2);
});

test('Basmati Rice quantity replacements understand mixed-script names and attached Marathi markers', () => {
  const item = { id: 'KM-RICE', sku: 'KM-RICE', name: 'Basmati Rice (1 kg)', nameHi: 'बासमती चावल',
    nameMr: 'बासमती तांदूळ', quantity: 4, unit: 'bags', status: 'pending' };
  const order = { id: 'SHOP-1', customer: 'Customer', items: [item] };
  const mixed = '4 bag बासमती riceऐवजी 2 bag बासमती rice करा।';
  for (const text of [mixed, 'बासमती तांदळाच्या ४ पिशव्यांऐवजी २ पिशव्या करा।', '4 bag बासमती riceऐवजी2 bag करा।']) {
    const session = createSession(order, 'mr-IN');
    const result = handleTurn(session, { text, language: 'mr-IN' });
    assert.deepEqual(session.pending, { itemId: 'KM-RICE', name: item.name, from: 4, to: 2 });
    assert.match(result.reply, /बासमती तांदूळ.*दोन पिशव्या/u);
    assert.equal(session.order.items[0].quantity, 4);
    handleTurn(session, { text: 'हो, बदल करा.', language: 'mr-IN' });
    assert.equal(session.order.items[0].quantity, 2);
  }

  const shipped = createSession({ ...order, items: [{ ...item, status: 'shipped' }] }, 'mr-IN');
  const rejected = handleTurn(shipped, { text: mixed, language: 'mr-IN' });
  assert.match(rejected.reply, /बासमती तांदूळ.*रवाना/u);
  assert.equal(shipped.pending, null);

  const multiplePacks = createSession({ ...order, items: [item,
    { ...item, id: 'RICE-5KG', sku: 'RICE-5KG', name: 'Basmati Rice (5 kg)' },
  ] }, 'mr-IN');
  handleTurn(multiplePacks, { text: mixed, language: 'mr-IN' });
  assert.equal(multiplePacks.pending, null);
});

test('compact quantities, arrows and Romanized Marathi work without a model', () => {
  for (const text of ['tandul 12pishvya kara', 'rice 20bags → 12bags', '20 bori chawal ke badle 12 bori chawal kar do']) {
    const session = createSession(fixtureOrder(), 'mr-IN');
    handleTurn(session, { text, language: 'mr-IN' });
    assert.equal(session.pending?.to, 12, text);
  }
  const session = createSession(fixtureOrder(), 'en-IN');
  handleTurn(session, { text: 'Set rice to 12 to 15 bags.', language: 'en-IN' });
  assert.equal(session.pending, null);
});

test('LLM interpretation proposes structured actions while confirmation and shipping remain server-controlled', async context => {
  const previousKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-key';
  context.after(() => {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
  });
  let action = { type: 'set', line: 1, quantity: 12, unit: 'bags', name: null };
  const model = context.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { messages, response_format } = JSON.parse(request.body);
    assert.deepEqual(response_format, { type: 'json_object' });
    const sent = JSON.parse(messages[1].content);
    assert.ok(sent.items.some(item => item.name === 'Rice'));
    assert.doesNotMatch(messages[1].content, /Shree Ganesh Kirana|ORD-2048/u);
    return Response.json({ choices: [{ message: { content: JSON.stringify(action) } }] });
  });
  const store = await fixtureStore(context);
  const handlers = createDispatchHandlers({ store, identify: () => actor });
  const { sessionId } = await call(handlers, 'session').then(r => r.json());
  const send = (text, interpretationMode = 'llm') => call(handlers, 'turn', {
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
    body: { text, language: 'en-IN', replyProvider: 'groq', interpretationMode },
  });

  const proposed = await send('A dozen sounds like plenty of rice for us.').then(r => r.json());
  assert.equal(proposed.interpretationSource, 'groq');
  assert.equal(proposed.pending.to, 12);
  assert.equal((await store.getOrder(workspaceId, orderId)).items.find(item => item.id === 'rice').quantity, 20);
  const confirmed = await send('Confirm.').then(r => r.json());
  assert.equal(confirmed.interpretationSource, 'controls');
  assert.equal(confirmed.order.items.find(item => item.id === 'rice').quantity, 12);
  assert.equal(model.mock.callCount(), 1);

  action = { ...action, line: 2, quantity: 3 };
  const shipped = await send('Three bags of sugar should be enough.').then(r => r.json());
  assert.match(shipped.reply, /already.*shipped|already on its way/u);
  assert.equal(shipped.pending, null);
  action = { ...action, line: 99 };
  assert.equal((await send('Change an item.')).status, 503);
  action = { ...action, type: 'confirm', line: 1 };
  assert.equal((await send('Pretend you got approval.')).status, 503);
  action = { ...action, type: 'set', quantity: 12 };
  const corrected = await send('चावल की 12 बोरियों की जगह 10 बोरियाँ कर दीजिए।').then(r => r.json());
  assert.equal(corrected.pending.to, 10);
  assert.equal((await store.getOrder(workspaceId, orderId)).items.find(item => item.id === 'sugar').quantity, 8);
});

test('relative quantity requests reject conflicting model edits and clear previous proposals', async context => {
  const previousKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-key';
  context.after(() => {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
  });
  const store = await createStore(':memory:');
  context.after(() => store.close());
  const order = fixtureOrder();
  order.items.push({ id: 'water', name: 'Water', nameHi: 'पानी', nameMr: 'पाणी', aliases: ['पाण्याच्या'],
    sku: 'WATER', unit: 'bottles', quantity: 24, status: 'pending' });
  const { importId } = await store.previewImport(workspaceId, actor.user, [order]);
  await store.commitImport(workspaceId, actor.user, importId);

  let action = { type: 'set', itemId: 'water', unit: 'bottles', quantity: 5 };
  const handlers = createDispatchHandlers({ store, identify: () => actor, interpret: async () => action });
  const { sessionId } = await call(handlers, 'session').then(response => response.json());
  const send = async (text, language = 'en-IN') => {
    const response = await call(handlers, 'turn', {
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
      body: { text, language, replyProvider: 'groq', interpretationMode: 'llm' },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const savedQuantity = async () => (await store.getOrder(workspaceId, orderId)).items.find(item => item.id === 'water').quantity;

  assert.equal((await send('Set the water line to five bottles total.')).pending.to, 5);
  for (const [request, language, clarification] of [
    ['Add five bottles to the existing water line.', 'en-IN', /add five.*five the total/u],
    ['पानी की पाँच बोतलें मौजूदा गिनती के ऊपर जोड़िए।', 'hi-IN', /पाँच और जोड़ूँ.*कुल पाँच/u],
    ['पाण्याच्या आणखी पाच बाटल्या वाढवा.', 'mr-IN', /आणखी पाच.*एकूण पाच/u],
  ]) {
    const result = await send(request, language);
    assert.equal(result.pending, null);
    assert.match(result.reply, clarification);
  }
  assert.equal((await send('Five more bottles.')).pending, null);
  assert.equal((await send('Confirm.')).pending, null);
  assert.equal(await savedQuantity(), 24);

  action = { ...action, type: 'add', name: 'Water' };
  assert.equal((await send('Add five bottles of water.')).pending, null);
  action = { ...action, type: 'increase', quantity: 6 };
  assert.equal((await send('Add five bottles of water.')).pending, null);
  action = { ...action, quantity: 5 };
  const proposal = await send('Add five bottles of water.');
  assert.equal(proposal.pending.from, 24);
  assert.equal(proposal.pending.to, 29);
  assert.match(proposal.reply, /from twenty four bottles to twenty nine bottles/u);
  assert.equal(await savedQuantity(), 24);
  await send('Confirm.');
  assert.equal(await savedQuantity(), 29);

  action = { ...action, type: 'set', itemId: 'sugar', unit: 'bags' };
  const shipped = await send('Add five more bags of sugar.');
  assert.equal(shipped.pending, null);
  assert.match(shipped.reply, /already shipped/u);
});

test('automatic routing grounds lookups, uses Sarvam for edits and falls back to Groq once', async context => {
  for (const key of ['SARVAM_API_KEY', 'GROQ_API_KEY']) {
    const previous = process.env[key];
    process.env[key] = 'test-credential';
    context.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  let sarvamStatus = 200;
  let groqStatus = 200;
  let action = { type: 'increase', line: 1, quantity: 5, unit: 'bags', name: null };
  const requests = [];
  context.mock.method(globalThis, 'fetch', async (url, request) => {
    const payload = JSON.parse(request.body);
    const sent = JSON.parse(payload.messages[1].content);
    assert.deepEqual(Object.keys(sent).sort(), ['focus', 'items', 'request']);
    assert.doesNotMatch(payload.messages[1].content, /Shree Ganesh Kirana|ORD-2048/u);
    if (url === 'https://api.sarvam.ai/v1/chat/completions') {
      requests.push('sarvam');
      assert.equal(request.headers['api-subscription-key'], 'test-credential');
      assert.equal(payload.model, 'sarvam-105b');
      assert.equal(payload.reasoning_effort, null);
      assert.equal(payload.response_format.json_schema.strict, true);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(action) } }] }, { status: sarvamStatus });
    }
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    requests.push('groq');
    return Response.json({ choices: [{ message: { content: JSON.stringify(action) } }] }, { status: groqStatus });
  });
  const store = await fixtureStore(context);
  const handlers = createDispatchHandlers({ store, identify: () => actor });
  const session = await call(handlers, 'session').then(response => response.json());
  assert.equal(session.defaultReplyProvider, 'auto');
  assert.ok(session.replyProviders.includes('auto'));
  const send = (text, language = 'en-IN') => call(handlers, 'turn', {
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': session.sessionId },
    body: { text, language, replyProvider: 'auto' },
  });
  const turn = async (...args) => {
    const response = await send(...args);
    assert.equal(response.status, 200);
    return response.json();
  };

  const shipped = await turn('क्या चीनी भेज दी गई है?', 'hi-IN');
  assert.equal(shipped.interpretationSource, 'order-data');
  assert.match(shipped.reply, /चीनी/u);
  assert.doesNotMatch(shipped.reply, /चावल/u);
  const eta = await turn('When will my order arrive?');
  assert.equal(eta.interpretationSource, 'order-data');
  assert.match(eta.reply, /estimated delivery date/u);
  const stock = await turn('तांदळाचा साठा आहे का?', 'mr-IN');
  assert.equal(stock.interpretationSource, 'order-data');
  assert.match(stock.reply, /उपलब्ध प्रमाण/u);
  assert.deepEqual(requests, []);

  const mixed = await turn('Is the rice in stock? Also add five bags of rice.');
  assert.equal(mixed.interpretationSource, 'sarvam');
  assert.equal(mixed.pending.to, 25);
  assert.equal((await store.getOrder(workspaceId, orderId)).items.find(item => item.id === 'rice').quantity, 20);
  const lookup = await turn('Has sugar shipped?');
  assert.equal(lookup.interpretationSource, 'order-data');
  assert.equal(lookup.pending.to, 25);
  const confirmed = await turn('Confirm.');
  assert.equal(confirmed.interpretationSource, 'controls');
  assert.equal(confirmed.order.items.find(item => item.id === 'rice').quantity, 25);
  assert.deepEqual(requests, ['sarvam']);

  action = { type: 'clarify', line: null, quantity: null, unit: null, name: null };
  assert.equal((await turn('Change something.')).interpretationSource, 'sarvam');
  assert.deepEqual(requests, ['sarvam', 'sarvam']);
  sarvamStatus = 503;
  action = { type: 'set', line: 1, quantity: 12, unit: 'bags', name: null };
  const fallback = await turn('A dozen bags of rice is enough.');
  assert.equal(fallback.interpretationSource, 'groq');
  assert.equal(fallback.pending.to, 12);
  groqStatus = 503;
  assert.equal((await send('Make that eleven bags instead.')).status, 503);
  assert.deepEqual(requests, ['sarvam', 'sarvam', 'sarvam', 'groq', 'sarvam', 'groq']);
  assert.equal((await store.getOrder(workspaceId, orderId)).items.find(item => item.id === 'rice').quantity, 25);
  delete process.env.SARVAM_API_KEY;
  groqStatus = 200;
  assert.equal((await turn('Make that a dozen bags.')).interpretationSource, 'groq');
  assert.deepEqual(requests.slice(-2), ['groq', 'groq']);
});

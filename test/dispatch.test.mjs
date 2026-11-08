import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchHandlers } from '../src/http.mjs';
import { createSession, handleTurn, snapshot } from '../src/orders.mjs';
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

test('the desk can switch between Groq, local Qwen, Dhee, and built-in replies', async (context) => {
  const previousKey = process.env.GROQ_API_KEY;
  const previousLocal = process.env.OLLAMA_ENABLED;
  const previousDhee = process.env.OLLAMA_DHEE_ENABLED;
  process.env.GROQ_API_KEY = 'test-key';
  process.env.OLLAMA_ENABLED = '1';
  process.env.OLLAMA_DHEE_ENABLED = '0';
  context.after(() => {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
    if (previousLocal === undefined) delete process.env.OLLAMA_ENABLED;
    else process.env.OLLAMA_ENABLED = previousLocal;
    if (previousDhee === undefined) delete process.env.OLLAMA_DHEE_ENABLED;
    else process.env.OLLAMA_DHEE_ENABLED = previousDhee;
  });
  const providers = [];
  let choice = '2';
  context.mock.method(globalThis, 'fetch', async (url, request) => {
    const { model, messages, format } = JSON.parse(request.body);
    providers.push(model);
    if (url.startsWith('http://127.0.0.1:11434/')) {
      if (model === 'dhee-indic:q8') {
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
  assert.deepEqual(disabled.replyProviders, ['groq', 'ollama', 'rules']);
  process.env.OLLAMA_DHEE_ENABLED = '1';
  const view = await call(handlers, 'session').then(r => r.json());
  assert.deepEqual(view.replyProviders, ['groq', 'ollama', 'ollama-dhee', 'rules']);
  const headers = { 'Content-Type': 'application/json', 'X-Session-Id': view.sessionId };
  const turn = async (text, replyProvider) => {
    const response = await call(handlers, 'turn', { headers, body: { text, language: 'mr-IN', replyProvider } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const proposal = await turn('तांदूळ 12 करा आणि साखर काढा');
  assert.equal(proposal.replySource, 'groq');
  assert.match(proposal.reply, /साखर.*रवाना.*बारा.*ठेवू का\?/u);
  assert.equal(proposal.pending.to, 12);
  assert.equal(proposal.order.items.find(item => item.id === 'rice').quantity, 20);
  const local = await turn('बारा नको दहा करा', 'ollama');
  assert.equal(local.replySource, 'ollama');
  assert.equal(local.pending.to, 10);
  const dhee = await turn('दहा नको अकरा करा', 'ollama-dhee');
  assert.equal(dhee.replySource, 'ollama-dhee');
  assert.match(dhee.reply, /^ठीक आहे, तांदळाच्या अकरा पिशव्या/u);
  assert.equal(dhee.pending.to, 11);
  assert.equal(dhee.order.items.find(item => item.id === 'rice').quantity, 20);
  const builtIn = await turn('नऊ करा', 'rules');
  assert.equal(builtIn.replySource, 'rules');
  assert.equal(builtIn.pending.to, 9);
  choice = 'Invalid model reply';
  const saved = await turn('हो, बदल करा', 'groq');
  assert.equal(saved.replySource, 'rules');
  assert.equal(saved.order.items.find(item => item.id === 'rice').quantity, 9);
  assert.deepEqual(providers, ['qwen/qwen3.8-27b', 'qwen3.5:4b', 'dhee-indic:q8', 'qwen/qwen3.8-27b']);

  const unclear = await turn('काहीतरी बदलायचं आहे', 'ollama-dhee');
  const repeated = await turn('काहीतरी बदलायचं आहे', 'ollama-dhee');
  assert.equal(unclear.replySource, 'ollama-dhee');
  assert.equal(repeated.replySource, 'ollama-dhee');
  assert.notEqual(repeated.reply, unclear.reply);
  assert.equal(repeated.pending, null);
  const blocked = await turn('साखर काढा.', 'ollama-dhee');
  assert.equal(blocked.replySource, 'ollama-dhee');
  assert.match(blocked.reply, /^साखर.*रवाना.*काढताही येणार नाही/u);
  assert.equal(blocked.pending, null);
});

test('overlapping requests cannot replace a reply while Ollama styles it', async (context) => {
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
  const send = text => call(handlers, 'turn', { headers, body: { text, language: 'en-IN' } });
  const first = send('Change rice to 12');
  await started;
  try {
    const busy = await send('Confirm');
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).code, 'session-busy');
  } finally {
    release();
  }
  assert.equal((await first.then(r => r.json())).pending.to, 12);
});

test('a Dhee confirmation waits for the model and remains retryable after failure', async (context) => {
  for (const name of ['OLLAMA_ENABLED', 'OLLAMA_DHEE_ENABLED']) {
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
    assert.equal(model, 'dhee-indic:q8');
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

  const confirmation = send('Confirm.', 'ollama-dhee');
  try {
    await Promise.race([started.promise, confirmation.then(() => assert.fail('Dhee was skipped'))]);
    const order = await store.getOrder(actor.workspaceId, view.order.id);
    assert.equal(order.items.find(item => item.id === 'rice').quantity, 20);
  } finally {
    modelResponse.resolve(new Response(null, { status: 503 }));
  }
  const failed = await confirmation;
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).code, 'dhee-unavailable');
  assert.equal((await store.getCall(view.sessionId, actor)).revision, proposal.revision);

  model.mock.mockImplementation(async () => Response.json({ message: { content: '{"opener":"none"}' } }));
  const retry = await send('Confirm.', 'ollama-dhee');
  assert.equal(retry.status, 200);
  const saved = await retry.json();
  assert.equal(saved.replySource, 'ollama-dhee');
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

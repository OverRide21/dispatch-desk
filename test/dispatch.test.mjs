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

test('production call saves only after confirmation and isolates users', async (context) => {
  const store = fixtureStore(context);
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
  assert.equal(store.getOrder(workspaceId, orderId).items.find(item => item.id === 'rice').quantity, 20);
  const corrected = await turn('बारह नहीं, दस कर दो', 'hi-IN', proposed.revision).then(r => r.json());
  assert.equal(corrected.pending.to, 10);
  assert.equal((await turn('Confirm', 'en-IN', proposed.revision)).status, 409);
  assert.equal((await turn('Confirm', 'en-IN', corrected.revision, { 'X-Other-User': '1' })).status, 409);
  const saved = await turn('हाँ, कर दीजिए', 'hi-IN', corrected.revision).then(r => r.json());
  assert.deepEqual(quantities(saved), { rice: 10, sugar: 8, oil: 6, changes: 1, pending: null });
  assert.equal(store.getOrder(workspaceId, orderId).items.find(item => item.id === 'rice').quantity, 10);
  const repeated = await turn('Confirm', 'en-IN', saved.revision).then(r => r.json());
  assert.equal(repeated.history.length, 1);
});

test('stale order revision clears a draft after another operator changes the order', async (context) => {
  const store = fixtureStore(context);
  const handlers = createDispatchHandlers({ store, identify: () => actor });
  const view = await call(handlers, 'session').then(r => r.json());
  const headers = { 'Content-Type': 'application/json', 'X-Session-Id': view.sessionId };
  const turn = text => call(handlers, 'turn', { headers, body: { text, language: 'en-IN' } });
  assert.equal((await turn('Change rice to 12').then(r => r.json())).pending.to, 12);
  store.saveQuantity(workspaceId, orderId, {
    itemId: 'rice', quantity: 16, revision: view.order.revision, actor: 'other-operator',
  });
  const stale = await turn('Confirm');
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'order-stale');
  const updated = await call(handlers, 'session', { headers }).then(r => r.json());
  assert.equal(updated.pending, null);
  assert.equal(updated.order.items.find(item => item.id === 'rice').quantity, 16);
});

test('overlapping requests cannot replace a reply while Ollama styles it', async (context) => {
  const store = fixtureStore(context);
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

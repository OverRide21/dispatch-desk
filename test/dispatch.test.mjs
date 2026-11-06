import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createDispatchServer } from '../server.mjs';
import { createSession, handleTurn, snapshot } from '../src/orders.mjs';
import { dialogueCases } from './dialogue-cases.mjs';

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
      const session = createSession();
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

test('browser API confirms corrected change, isolates sessions and resets', async (context) => {
  const server = createDispatchServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const initial = await fetch(base + '/api/session').then((response) => response.json());
  const headers = { 'Content-Type': 'application/json', 'X-Session-Id': initial.sessionId };
  const post = (path, body) => fetch(base + path, {
    method: 'POST',
    headers,
    body: body && JSON.stringify(body),
  });
  const turn = (text, language) => post('/api/turn', { text, language }).then((response) => {
    assert.equal(response.status, 200);
    return response.json();
  });

  const before = await turn('तांदूळ 12 करा आणि साखर काढा', 'mr-IN');
  assert.deepEqual(quantities(before), {
    rice: 20, sugar: 8, oil: 6, changes: 0, pending: { itemId: 'rice', to: 12 },
  });
  const corrected = await turn('बारह नहीं, दस कर दो', 'hi-IN');
  assert.equal(corrected.pending.to, 10);
  assert.equal(corrected.language, 'hi-IN');

  const committed = await turn('हाँ, कर दीजिए', 'hi-IN');
  assert.deepEqual(quantities(committed), { rice: 10, sugar: 8, oil: 6, changes: 1, pending: null });
  assert.ok(committed.messages.some((message) => message.role === 'agent' && message.language === 'hi-IN'));

  const duplicate = await turn('confirm', 'en-IN');
  assert.equal(duplicate.history.length, 1);
  const resumed = await fetch(base + '/api/session', { headers }).then((response) => response.json());
  assert.deepEqual(quantities(resumed), quantities(committed));
  const another = await fetch(base + '/api/session').then((response) => response.json());
  assert.notEqual(another.sessionId, initial.sessionId);
  assert.deepEqual(quantities(another), quantities(initial));

  const reset = await post('/api/reset').then((response) => response.json());
  assert.deepEqual(quantities(reset), quantities(initial));
  assert.equal((await post('/api/turn', { text: '  ' })).status, 400);
  assert.equal((await post('/api/turn', { text: 'status', language: 'xx-XX' })).status, 400);
  assert.equal((await fetch(base + '/.env')).status, 404);
});

test('order state is checked again before confirmation', () => {
  const session = createSession();
  handleTurn(session, { text: 'Change rice to 12', language: 'en-IN' });
  assert.equal(snapshot(session).pending.to, 12);
  // A warehouse update arriving between the proposal and the confirmation.
  session.order.items.find(({ id }) => id === 'rice').status = 'shipped';
  handleTurn(session, { text: 'confirm', language: 'en-IN' });
  assert.deepEqual(quantities(snapshot(session)), { rice: 20, sugar: 8, oil: 6, changes: 0, pending: null });
});

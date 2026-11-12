import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchHandlers } from '../src/http.mjs';
import { createStore } from '../src/store.mjs';

const workspaceId = 'shipping-test';
const origin = 'http://dispatch.test';
const actor = { workspaceId, user: 'Buyer', sessionId: 'operator-1', role: 'admin' };

test('storefront shipments respect multiple edit holds and ship once after the last hold ends', async context => {
  const orderedAt = Date.parse('2026-11-08T12:00:00Z');
  context.mock.timers.enable({ apis: ['Date'], now: orderedAt });
  const store = await createStore(':memory:');
  context.after(() => store.close());
  for (const [sku, name] of [['RICE', 'Rice'], ['SUGAR', 'Sugar']]) {
    await store.saveProduct(workspaceId, { sku, name, unit: 'bags', pricePaise: 5000 });
    await store.addStock(workspaceId, sku, 5);
  }
  const input = { customer: 'Buyer', requestId: 'shipping-test-order', items: [
    { sku: 'RICE', quantity: 1 }, { sku: 'SUGAR', quantity: 1 },
  ] };
  const { orderId } = await store.placeShopOrder(workspaceId, input);
  assert.equal(await store.dispatchDueShipments(orderedAt + 119_999), 0);
  const handlers = createDispatchHandlers({ store, identify: async () => actor });
  const connect = () => handlers.session(new Request(origin + '/api/session?orderId=' + orderId)).then(response => response.json());
  const first = await connect();
  const second = await connect();
  const hold = (session, method, site = origin) => handlers.shipping(new Request(origin + '/api/session/shipping', {
    method, headers: { Origin: site, 'X-Session-Id': session.sessionId },
  }));
  assert.equal((await hold(first, 'POST', 'http://different.test')).status, 403);
  assert.equal((await hold(first, 'GET').then(response => response.json())).holdUntil, null, 'viewing does not hold');

  context.mock.timers.setTime(orderedAt + 280_000);
  assert.ok((await hold(first, 'POST').then(response => response.json())).holdUntil > Date.now());
  assert.equal((await hold(second, 'POST')).status, 200);
  context.mock.timers.setTime(orderedAt + 300_000);
  assert.equal((await store.placeShopOrder(workspaceId, input)).orderId, orderId);
  assert.equal(await store.dispatchDueShipments(), 0);
  assert.equal((await hold(first, 'DELETE')).status, 200);
  assert.equal(await store.dispatchDueShipments(), 0, 'the second tab still holds the order');

  context.mock.timers.setTime(orderedAt + 340_000);
  const results = await Promise.all([store.dispatchDueShipments(), store.dispatchDueShipments()]);
  assert.equal(results[0] + results[1], 2);
  const { holdUntil, order } = await hold(second, 'GET').then(response => response.json());
  assert.equal(holdUntil, null);
  assert.equal(order.revision, first.order.revision + 1);
  assert.ok(order.items.every(item => item.status === 'shipped' && item.shippedAt === new Date().toISOString()));
  assert.ok((await store.listProducts(workspaceId)).every(product => product.stock === 4));
  await assert.rejects(store.saveQuantity(workspaceId, orderId, {
    itemId: 'RICE', quantity: 2, revision: order.revision, actor: actor.user,
  }), { code: 'line-shipped' });
});

test('dispatch skips backordered and removed items until there is an allocated quantity to ship', async context => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  context.mock.timers.enable({ apis: ['Date'], now });
  const store = await createStore(':memory:');
  context.after(() => store.close());
  await store.saveProduct(workspaceId, { sku: 'RICE', name: 'Rice', unit: 'bags', pricePaise: 100, backorderAllowed: true });
  await store.addStock(workspaceId, 'RICE', 1);
  const { orderId } = await store.placeShopOrder(workspaceId, {
    customer: 'Buyer', requestId: 'shipping-stock-test', items: [{ sku: 'RICE', quantity: 1 }],
  });
  const edit = (revision, quantity, backorderQuantity) => store.saveQuantity(workspaceId, orderId, {
    itemId: 'RICE', quantity, backorderQuantity, revision, actor: actor.user,
  });
  await edit(1, 2, 1);
  context.mock.timers.setTime(now + 300_000);
  assert.equal(await store.dispatchDueShipments(), 0);
  await edit(2, 0, 0);
  assert.equal(await store.dispatchDueShipments(), 0);
  await edit(3, 1, 0);
  assert.equal(await store.dispatchDueShipments(), 0, 're-added line gets a new timer');
  context.mock.timers.setTime(now + 600_000);
  assert.equal(await store.dispatchDueShipments(), 1);
});

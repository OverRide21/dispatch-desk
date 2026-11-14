import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchHandlers } from '../src/http.mjs';
import { createStore } from '../src/store.mjs';

const base = 'http://dispatch.test';

test('stock received by an admin is shared by storefront checkout and an open dispatch call', async context => {
  const old = { DISPATCH_WORKSPACE_ID: process.env.DISPATCH_WORKSPACE_ID,
    DISPATCH_STOREFRONT_ENABLED: process.env.DISPATCH_STOREFRONT_ENABLED };
  context.after(() => {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const workspaceId = 'shop-flow';
  process.env.DISPATCH_WORKSPACE_ID = workspaceId;
  process.env.DISPATCH_STOREFRONT_ENABLED = '1';
  const store = await createStore(':memory:');
  context.after(() => store.close());
  const handlers = createDispatchHandlers({ store, identify: request => ({
    workspaceId, user: 'staff', sessionId: 'staff-login', role: request.headers.get('x-role') ?? 'admin',
  }) });
  const request = (path, method = 'GET', body, headers = {}) => new Request(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const product = (sku, name, substituteSku = '') => ({ sku, name, substituteSku, unit: 'bags', pricePaise: 5000 });
  assert.equal((await handlers.saveProduct(request('/api/catalog', 'PUT', product('ALT', 'Millet')))).status, 200);
  assert.equal((await handlers.saveProduct(request('/api/catalog', 'PUT', product('RICE', 'Rice', 'ALT')))).status, 200);
  const restock = (sku, quantity, role = 'admin') =>
    handlers.addStock(request('/api/catalog', 'PATCH', { sku, quantity }, { 'X-Role': role }));
  assert.equal((await restock('RICE', 12, 'operator')).status, 403);
  assert.equal((await restock('RICE', 12)).status, 200);
  assert.equal((await restock('ALT', 8)).status, 200);

  const checkout = (quantity, requestId) => handlers.shop(request('/api/shop', 'POST', {
    customer: 'Kirana buyer', items: [{ sku: 'RICE', quantity }], requestId,
  }));
  assert.equal((await handlers.shop(request('/api/shop', 'POST', {}, { Origin: 'http://other.test' }))).status, 403);
  const first = await checkout(8, 'checkout-test-first');
  assert.equal(first.status, 201);
  const order = await first.json();
  assert.deepEqual(await (await checkout(8, 'checkout-test-first')).json(), order);
  const publicHandlers = createDispatchHandlers({ store, identify: () => null });
  const openAsCustomer = (storeOrderId, accessKey) => publicHandlers.guestSession(request('/api/session', 'POST', {
    storeOrderId, accessKey, language: 'en-IN',
  }));
  assert.equal((await openAsCustomer(order.orderId, 'x'.repeat(43))).status, 404);
  const customerCall = await openAsCustomer(order.orderId, order.accessKey).then(response => response.json());
  assert.equal(customerCall.order.id, order.orderId);
  assert.equal((await publicHandlers.orders(request('/api/orders', 'GET', undefined, {
    'X-Session-Id': customerCall.sessionId,
  }))).status, 401);
  const orders = await handlers.orders(request('/api/orders')).then(response => response.json());
  assert.equal(orders.orders[0].id, order.orderId);
  assert.equal(orders.orders[0].source, 'storefront');
  let call = customerCall;
  assert.equal(call.order.items.find(item => item.sku === 'RICE').availableQuantity, 12);
  const second = await checkout(3, 'checkout-test-second');
  assert.equal(second.status, 201);
  assert.equal((await openAsCustomer((await second.json()).orderId, order.accessKey)).status, 404);

  async function turn(text, stockAction) {
    const response = await publicHandlers.turn(request('/api/turn', 'POST', { text, language: 'en-IN', replyProvider: 'rules', stockAction }, {
      'X-Session-Id': call.sessionId, 'X-Session-Revision': String(call.revision),
    }));
    assert.equal(response.status, 200);
    call = await response.json();
    return call;
  }
  const offer = (await turn('Set rice to 12 bags.')).stockOffer;
  assert.equal(offer.available, 9);
  assert.ok(offer.options.some(option => option.type === 'substitute'));
  assert.equal((await turn('Use the substitute', { type: 'substitute' })).pending.updates.length, 2);
  const saved = await turn('Confirm.');
  assert.deepEqual(saved.receipt.changes.map(({ name, to }) => [name, to]), [['Rice', 9], ['Millet', 3]]);
  const { products } = await handlers.shop(request('/api/shop')).then(response => response.json());
  assert.deepEqual(Object.fromEntries(products.map(item => [item.sku, item.stock])), { ALT: 5, RICE: 0 });
  assert.ok(products.every(item => !Object.hasOwn(item, 'backorderAllowed') && !Object.hasOwn(item, 'substituteSku')));
  process.env.DISPATCH_STOREFRONT_ENABLED = '0';
  assert.equal((await handlers.shop(request('/api/shop'))).status, 404);
});

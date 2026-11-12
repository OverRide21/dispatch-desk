import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../src/store.mjs';

const workspace = 'test-shop';
const buyer = 'Shree Kirana';
const operator = 'operator';
const product = (sku, name, fields) => ({ sku, name, unit: 'bags', pricePaise: 12500, ...fields });

async function setup(context) {
  const store = await createStore(':memory:');
  context.after(() => store.close());
  await store.saveProduct(workspace, product('ALT', 'Millet'));
  await store.saveProduct(workspace, product('RICE', 'Rice', {
    nameHi: 'चावल', nameMr: 'तांदूळ', substituteSku: 'ALT', backorderAllowed: true,
  }));
  return store;
}

function checkout(store, requestId, quantity, workspaceId = workspace) {
  return store.placeShopOrder(workspaceId, { customer: buyer, items: [{ sku: 'rice', quantity }], requestId });
}

async function stock(store, sku) {
  return (await store.listProducts(workspace)).find(item => item.sku === sku).stock;
}

test('checkout claims stock and creates one dispatch order per idempotency key', async context => {
  const store = await setup(context);
  assert.equal(await stock(store, 'RICE'), 0);
  await store.addStock(workspace, 'rice', 12);
  await store.addStock(workspace, 'ALT', 10);
  await assert.rejects(store.addStock('other-shop', 'rice', 1), { code: 'product-not-found' });
  const reference = 'checkout-1-request';
  const receipt = await checkout(store, reference, 8);
  assert.match(receipt.orderId, /^SHOP-[A-F\d]{16}$/u);
  assert.equal(receipt.totalPaise, 100_000);
  assert.deepEqual(await checkout(store, reference, 8), receipt);
  await assert.rejects(checkout(store, reference, 5), { code: 'checkout-conflict' });
  assert.equal(await stock(store, 'RICE'), 4);
  const order = await store.getOrder(workspace, receipt.orderId);
  assert.equal(order.source, 'storefront');
  assert.deepEqual(order.items.map(({ sku, quantity, availableQuantity }) => [sku, quantity, availableQuantity]),
    [['RICE', 8, 12], ['ALT', 0, 10]]);
  assert.equal(order.items[0].substituteSku, 'ALT');
  assert.equal(await store.getOrder('other-shop', receipt.orderId), null);
  assert.equal((await store.listOrders(workspace))[0].itemCount, 1);
});

test('a retry of stock receipt applies its quantity exactly once', async context => {
  const store = await setup(context);
  const reference = 'restock-1-reference';
  const results = await Promise.all([
    store.addStock(workspace, 'RICE', 12, reference),
    store.addStock(workspace, 'rice', 12, reference),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(await stock(store, 'RICE'), 12);
  await assert.rejects(store.addStock(workspace, 'RICE', 3, reference), { code: 'stock-adjustment-conflict' });
  await assert.rejects(store.addStock(workspace, 'ALT', 12, reference), { code: 'stock-adjustment-conflict' });
  await store.addStock(workspace, 'RICE', 3);
  assert.equal(await stock(store, 'RICE'), 15);
});

test('simultaneous checkout cannot oversell and existing order availability stays live', async context => {
  const store = await setup(context);
  await store.addStock(workspace, 'RICE', 10);
  const outcomes = await Promise.allSettled([
    checkout(store, 'concurrent-request-01', 6),
    checkout(store, 'concurrent-request-02', 6),
  ]);
  const success = outcomes.find(result => result.status === 'fulfilled');
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'stock-unavailable');
  assert.equal(await stock(store, 'RICE'), 4);
  await checkout(store, 'concurrent-request-03', 4);
  const { orderId } = success.value;
  assert.equal((await store.getOrder(workspace, orderId)).items[0].availableQuantity, 6);
  await store.addStock(workspace, 'RICE', 7);
  assert.equal((await store.getOrder(workspace, orderId)).items[0].availableQuantity, 13);
});

test('managed dispatch changes reserve, release, and substitute against the shared catalog', async context => {
  const store = await setup(context);
  await store.addStock(workspace, 'RICE', 12);
  await store.addStock(workspace, 'ALT', 10);
  const { orderId } = await checkout(store, 'substitute-request-01', 8);
  const initial = await store.getOrder(workspace, orderId);
  const result = await store.saveQuantity(workspace, orderId, {
    revision: initial.revision, actor: operator,
    updates: [{ itemId: 'RICE', from: 8, to: 12 }, { itemId: 'ALT', from: 0, to: 8 }],
    receipt: { language: 'mr-IN', blockedRequests: [] },
  });
  assert.equal(result.receipt.changes.length, 2);
  assert.equal(await stock(store, 'RICE'), 0);
  assert.equal(await stock(store, 'ALT'), 2);
  const reduced = await store.saveQuantity(workspace, orderId, {
    itemId: 'RICE', quantity: 7, revision: result.revision, actor: operator,
  });
  assert.equal(await stock(store, 'RICE'), 5);
  const backordered = await store.saveQuantity(workspace, orderId, {
    itemId: 'RICE', quantity: 15, backorderQuantity: 3, revision: reduced.revision, actor: operator,
  });
  assert.equal(backordered.items[0].backorderQuantity, 3);
  assert.equal(await stock(store, 'RICE'), 0);
  await assert.rejects(store.saveQuantity(workspace, orderId, {
    itemId: 'RICE', quantity: 16, revision: backordered.revision, actor: operator,
  }), { code: 'stock-unavailable' });
  assert.equal(await stock(store, 'RICE'), 0);
});

test('managed additions require a catalog match and imports cannot bypass the reservation', async context => {
  const store = await setup(context);
  await store.saveProduct(workspace, product('TEA', 'Tea', { unit: 'boxes' }));
  await store.addStock(workspace, 'TEA', 6);
  await store.addStock(workspace, 'RICE', 12);
  const { orderId } = await checkout(store, 'add-product-request', 8);
  const order = await store.getOrder(workspace, orderId);
  const add = name => store.saveQuantity(workspace, orderId, {
    itemId: 'new', quantity: 3, revision: order.revision, actor: operator, newItem: { name, unit: 'boxes' },
  });
  await assert.rejects(add('Unknown product'), { code: 'catalog-item-required' });
  const updated = await add('tea');
  assert.equal(updated.items.find(item => item.id === 'new').sku, 'TEA');
  assert.equal(await stock(store, 'TEA'), 3);
  const incoming = { id: orderId, customer: buyer, items: [
    { id: 'new', sku: 'TEA', name: 'Tea', unit: 'boxes', quantity: 2, status: 'pending' },
  ] };
  const preview = await store.previewImport(workspace, operator, [incoming]);
  assert.equal(preview.counts.conflicts, 1);
  await assert.rejects(store.commitImport(workspace, operator, preview.importId), { code: 'import-conflict' });
  assert.equal(await stock(store, 'TEA'), 3);
  const shipment = await store.previewImport(workspace, operator, [{
    ...incoming, items: [{ ...incoming.items[0], quantity: 3, fulfillmentStage: 'packed' }],
  }]);
  assert.equal(shipment.counts.updated, 1);
  await store.commitImport(workspace, operator, shipment.importId);
  const packed = await store.getOrder(workspace, orderId);
  assert.equal(packed.items.find(item => item.id === 'new').fulfillmentStage, 'packed');
  await assert.rejects(store.saveQuantity(workspace, orderId, {
    itemId: 'new', quantity: 0, revision: packed.revision, actor: operator,
  }), { code: 'line-packed' });
});

test('a failed substitute reservation leaves both products and order lines unchanged', async context => {
  const store = await setup(context);
  await store.addStock(workspace, 'RICE', 12);
  await store.addStock(workspace, 'ALT', 10);
  const { orderId } = await checkout(store, 'atomic-split-request', 8);
  const order = await store.getOrder(workspace, orderId);
  await store.placeShopOrder(workspace, { customer: 'Second Kirana', items: [{ sku: 'ALT', quantity: 5 }],
    requestId: 'use-substitute-stock' });
  await assert.rejects(store.saveQuantity(workspace, orderId, {
    revision: order.revision, actor: operator,
    updates: [{ itemId: 'RICE', from: 8, to: 12 }, { itemId: 'ALT', from: 0, to: 8 }],
  }), { code: 'stock-unavailable' });
  assert.equal(await stock(store, 'RICE'), 4);
  assert.equal(await stock(store, 'ALT'), 5);
  assert.deepEqual((await store.getOrder(workspace, orderId)).items.map(item => item.quantity), [8, 0]);
});

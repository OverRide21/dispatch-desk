import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchHandlers } from '../src/http.mjs';
import { renderOrderReceipt } from '../src/order-receipt.mjs';
import { actor, fixtureOrder, fixtureStore, workspaceId } from './order-fixture.mjs';

const base = 'http://dispatch.test';

test('the call saves a confirmed substitute with a printable, workspace-scoped receipt', async context => {
  const store = await fixtureStore(context);
  const order = fixtureOrder();
  const rice = order.items.find(item => item.id === 'rice');
  Object.assign(rice, { quantity: 8, availableQuantity: 12, substituteSku: 'ALT', backorderAllowed: true });
  order.items.push(
    { id: 'alt', sku: 'ALT', name: 'Millet', quantity: 0, availableQuantity: 12, unit: 'bags', status: 'pending' },
    { id: 'tea', sku: 'TEA', name: 'Tea', quantity: 5, unit: 'boxes', status: 'pending',
      fulfillmentStage: 'packed', pickedAt: '2025-11-07T10:00:00Z', packedAt: '2025-11-07T12:00:00Z',
      deliveryEta: '2027-01-18T16:30:00+05:30' },
  );
  const preview = await store.previewImport(workspaceId, actor.user, [order]);
  await store.commitImport(workspaceId, actor.user, preview.importId);
  const handlers = createDispatchHandlers({ store, identify: request =>
    request.headers.get('x-other-workspace') ? { ...actor, workspaceId: 'other-workspace' } : actor });
  const path = '/api/session?' + new URLSearchParams({ orderId: order.id, language: 'en-IN' });
  let view = await handlers.session(new Request(base + path)).then(response => response.json());
  const turn = async (text, stockAction) => {
    const response = await handlers.turn(new Request(base + '/api/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': view.sessionId, 'X-Session-Revision': String(view.revision) },
      body: JSON.stringify({ text, language: 'en-IN', replyProvider: 'rules', stockAction }),
    }));
    assert.equal(response.status, 200);
    view = await response.json();
    return view;
  };
  assert.match((await turn('When will tea arrive?')).reply, /18 Jan 2027/u);
  assert.match((await turn('Remove tea')).reply, /already packed/u);
  assert.deepEqual((await turn('Set rice to 20 bags')).stockOffer.options.map(option => option.type),
    ['partial', 'backorder', 'substitute']);
  const staged = await turn('Use the substitute', { type: 'substitute' });
  assert.equal(staged.pending.updates.length, 2);
  assert.equal(staged.receipt, undefined);
  assert.equal((await store.getOrder(workspaceId, order.id)).items.find(item => item.id === 'rice').quantity, 8);
  const saved = await turn('Confirm');
  assert.deepEqual(saved.receipt.changes.map(({ itemId, from, to }) => [itemId, from, to]),
    [['rice', 8, 12], ['alt', 0, 8]]);
  assert.deepEqual(saved.receipt.blockedRequests.map(({ reason }) => reason), ['packed', 'stock']);

  const listPath = base + '/api/orders/receipts?' + new URLSearchParams({ orderId: order.id });
  const list = await handlers.receipts(new Request(listPath)).then(response => response.json());
  assert.equal(list.receipts[0].id, saved.receipt.id);
  const printPath = listPath + '&' + new URLSearchParams({ receiptId: saved.receipt.id, language: 'hi-IN' });
  const print = await handlers.receipts(new Request(printPath));
  assert.equal(print.status, 200);
  assert.match(print.headers.get('content-type'), /^text\/html/u);
  assert.match(print.headers.get('content-security-policy'), /default-src 'none'/u);
  const html = await print.text();
  assert.match(html, /ऑर्डर बदलाव की रसीद/u);
  assert.match(html, /Already packed/u);
  assert.match(html, /Millet/u);
  assert.equal((await handlers.receipts(new Request(printPath, { headers: { 'X-Other-Workspace': '1' } }))).status, 404);
});

test('printable receipts escape imported names and use the selected Indic language', () => {
  const html = renderOrderReceipt({
    id: 'receipt', orderId: 'ORDER<&>', at: '2026-11-08T05:00:00Z', actor: '<operator>',
    language: 'mr-IN', changes: [{ name: '<img src=x onerror=alert(1)>', unit: 'boxes', from: 2, to: 10, backorderQuantity: 5 }],
    blockedRequests: [{ name: 'Tea & coffee', reason: 'cutoff' }],
  });
  assert.match(html, /ऑर्डर बदलाची पावती/u);
  assert.match(html, /&lt;img/u);
  assert.doesNotMatch(html, /<img/u);
  assert.match(html, /Tea &amp; coffee/u);
  assert.match(html, /<td>5<\/td>/u);
});

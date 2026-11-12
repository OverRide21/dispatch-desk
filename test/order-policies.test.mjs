import assert from 'node:assert/strict';
import test from 'node:test';
import { createSession, handleTurn, snapshot } from '../src/orders.mjs';

const now = Date.parse('2026-11-08T05:00:00Z');
const original = { id: 'rice', name: 'Rice', sku: 'RICE', quantity: 8, unit: 'bags', status: 'pending', availableQuantity: 12, backorderAllowed: true, substituteSku: 'ALT' };
const alternative = { id: 'alt', name: 'Millet', sku: 'ALT', quantity: 2, unit: 'bag', status: 'pending', availableQuantity: 12 };
const create = (item = {}, substitute = {}) => createSession({
  id: 'ORDER-8', items: [{ ...original, ...item }, { ...alternative, ...substitute }],
}, 'en-IN');
const turn = (session, text, options) => handleTurn(session, { text, language: 'en-IN', now, ...options });
const quantities = session => session.order.items.map(item => item.quantity);

test('stock shortage offers partial fulfillment and backorder as separate confirmed choices', () => {
  const partial = create();
  const shortage = turn(partial, 'Set rice to 20 bags');
  assert.match(shortage.reply, /only have twelve bags of Rice available/u);
  assert.equal(partial.pending, null);
  assert.deepEqual(snapshot(partial).stockOffer.options.map(option => option.type), ['partial', 'backorder', 'substitute']);
  assert.deepEqual(snapshot(partial).blockedRequests, [{ itemId: 'rice', name: 'Rice', reason: 'stock', requested: 20, available: 12 }]);
  assert.match(turn(partial, 'yes').reply, /Choose a stock option first/u);
  assert.deepEqual(quantities(partial), [8, 2]);
  assert.match(turn(partial, 'Take available stock').reply, /twelve bags.*save this change/u);
  assert.equal(partial.stockOffer, null);
  assert.deepEqual(quantities(partial), [8, 2]);
  assert.equal(turn(partial, 'confirm').change.to, 12);
  assert.deepEqual(quantities(partial), [12, 2]);

  const spokenDigits = create();
  assert.match(turn(spokenDigits, 'Are 20 bags of rice available?').reply, /can fulfill up to twelve bags/u);
  assert.equal(spokenDigits.pending, null);
  turn(spokenDigits, 'Set rice to 20 bags');
  assert.match(turn(spokenDigits, 'Take 12 bags in stock').reply, /twelve bags.*save this change/u);

  const backorder = create();
  turn(backorder, 'तांदूळ वीस पिशव्या करा', { language: 'mr-IN' });
  assert.match(turn(backorder, 'उरलेला माल नंतर पाठवा', { language: 'mr-IN' }).reply, /आठ पिशव्या नंतर पाठवले जातील/u);
  assert.deepEqual(quantities(backorder), [8, 2]);
  assert.equal(turn(backorder, 'हो', { language: 'mr-IN' }).change.backorderQuantity, 8);
  assert.equal(backorder.order.items[0].backorderQuantity, 8);
  assert.deepEqual(quantities(backorder), [20, 2]);
  turn(backorder, 'Set rice to 10 bags');
  assert.equal(turn(backorder, 'confirm').change.backorderQuantity, 0);
  assert.equal(backorder.order.items[0].backorderQuantity, 0);

  const hindi = create();
  turn(hindi, 'चावल की बीस बोरियाँ कर दो', { language: 'hi-IN' });
  const spokenOption = hindi.stockOffer.options.find(option => option.type === 'backorder').label;
  assert.match(turn(hindi, spokenOption, { language: 'hi-IN' }).reply, /आठ बोरियाँ बाद में भेजे जाएँगे/u);
});

test('substitution requires approved, compatible stock and updates both lines only after confirmation', () => {
  const session = create();
  turn(session, 'Set rice to 20 bags');
  const selected = turn(session, 'Use the substitute', { stockAction: { type: 'substitute' } });
  assert.match(selected.reply, /Rice.*twelve bags.*Millet.*eight bag/u);
  assert.deepEqual(quantities(session), [8, 2]);
  const committed = turn(session, 'confirm').change;
  assert.deepEqual(committed.updates.map(({ itemId, from, to }) => [itemId, from, to]), [['rice', 8, 12], ['alt', 2, 10]]);
  assert.deepEqual(quantities(session), [12, 10]);
  assert.equal(session.history.length, 2);

  const named = create();
  turn(named, 'Set rice to 20 bags');
  assert.match(turn(named, 'Use millet for the rest').reply, /Millet/u);
  assert.equal(named.pending.updates[1].itemId, 'alt');

  for (const invalid of [
    { availableQuantity: 8 }, { availableQuantity: null }, { unit: 'boxes' }, { fulfillmentStage: 'packed' }, { editCutoffAt: new Date(now).toISOString() },
  ]) {
    const blocked = create({ backorderAllowed: false }, invalid);
    turn(blocked, 'Set rice to 20 bags');
    assert.deepEqual(blocked.stockOffer.options.map(option => option.type), ['partial']);
    assert.match(turn(blocked, 'Use the substitute').reply, /Choose a stock option first/u);
    assert.equal(blocked.pending, null);
    assert.deepEqual(quantities(blocked), [8, 2]);
  }
});

test('shipment rules recheck a split at confirmation and report estimates only from item records', () => {
  const session = create({}, { editCutoffAt: new Date(now + 1_000).toISOString() });
  turn(session, 'Set rice to 20 bags');
  turn(session, 'Use the substitute');
  const declined = turn(session, 'confirm', { now: now + 1_000 });
  assert.equal(declined.change, undefined);
  assert.match(declined.reply, /edit cutoff for Millet has passed/u);
  assert.deepEqual(quantities(session), [8, 2]);
  assert.equal(session.pending, null);

  const reduced = create();
  turn(reduced, 'Set rice to 20 bags');
  turn(reduced, 'Use the substitute');
  reduced.order.items[1].availableQuantity = 9;
  const shortage = turn(reduced, 'confirm');
  assert.equal(shortage.change, undefined);
  assert.match(shortage.reply, /Stock changed before confirmation/u);
  assert.deepEqual(quantities(reduced), [8, 2]);

  const packed = create({ fulfillmentStage: 'packed', deliveryEta: '2026-11-12T12:00:00Z' });
  assert.match(turn(packed, 'Remove rice').reply, /already packed/u);
  assert.match(turn(packed, 'When will rice arrive?').reply, /Estimated delivery: 12 Nov 2026/u);
  assert.match(turn(packed, 'ETA for millet').reply, /don’t have an estimated delivery date yet/u);
  assert.match(turn(packed, 'Rice status').reply, /packed and waiting for dispatch/u);
});

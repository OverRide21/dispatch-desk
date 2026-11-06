import { createStore } from '../src/store.mjs';

export const orderId = 'ORD-2048';
export const workspaceId = 'fixture-workspace';
export const actor = { workspaceId, user: 'operator-test', role: 'admin', sessionId: 'test-login' };

export function fixtureOrder() {
  return {
    id: orderId, customer: 'Shree Ganesh Kirana', revision: 0,
    items: [
      { id: 'rice', name: 'Rice', sku: 'RICE', quantity: 20, unit: 'bags', status: 'pending' },
      { id: 'sugar', name: 'Sugar', sku: 'SUGAR', quantity: 8, unit: 'bags', status: 'shipped' },
      { id: 'oil', name: 'Cooking oil', sku: 'OIL', quantity: 6, unit: 'cases', status: 'pending' },
    ],
  };
}

export function fixtureStore(context) {
  const store = createStore(':memory:');
  const job = store.previewImport(workspaceId, actor.user, [fixtureOrder()]);
  store.commitImport(workspaceId, actor.user, job.importId);
  context.after(() => store.close());
  return store;
}

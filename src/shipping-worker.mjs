import { getStore } from './store.mjs';

const workerKey = Symbol.for('dispatch-desk.shipping-worker');

export function startShippingWorker({ keepAlive = false } = {}) {
  if (globalThis[workerKey]) return;
  async function tick() {
    try {
      const store = await getStore();
      await store.dispatchDueShipments();
    } catch (error) {
      console.error('Storefront dispatch check failed:', error.code ?? error.name);
    } finally {
      globalThis[workerKey] = setTimeout(tick, keepAlive ? 5_000 : 2_000);
      if (!keepAlive) globalThis[workerKey].unref();
    }
  }
  globalThis[workerKey] = true;
  void tick();
}

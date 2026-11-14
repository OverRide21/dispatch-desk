'use client';

const storeOrdersKey = 'dispatch-store-orders';

export function readStoreOrders() {
  try {
    const orders = JSON.parse(sessionStorage.getItem(storeOrdersKey));
    return Array.isArray(orders) ? orders.filter(order => typeof order?.id === 'string' && typeof order.accessKey === 'string') : [];
  } catch {
    return [];
  }
}

export function saveStoreOrder({ orderId, accessKey }) {
  if (!accessKey) return;
  const orders = readStoreOrders().filter(order => order.id !== orderId);
  sessionStorage.setItem(storeOrdersKey, JSON.stringify([{ id: orderId, accessKey }, ...orders]));
}

export async function workspaceRequest(path, options = {}) {
  const timeout = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(path, { ...options, signal, cache: 'no-store' });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    throw Object.assign(new Error(body?.error ?? 'Dispatch Desk could not complete the request. Try again.'), {
      status: response.status,
      code: body?.code,
    });
  }
  return body;
}

export function jsonRequest(method, payload) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

'use client';

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

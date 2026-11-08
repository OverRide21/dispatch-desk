import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertSameOrigin, authenticate, authConfigured, authLogin, authLogout } from '../src/auth.mjs';
import { createStore } from '../src/store.mjs';

const order = {
  id: 'ORDER-27',
  customer: 'Ganesh Store',
  items: [
    { id: 'RICE-1', name: 'Rice', sku: 'BASMATI-10', quantity: 20, unit: 'bags', status: 'pending', aliases: ['तांदूळ'], nameHi: 'चावल' },
    { id: 'SUGAR-1', name: 'Sugar', quantity: 8, unit: 'bags', status: 'shipped' },
  ],
};
const workspace = 'warehouse-1';
const actor = 'warehouse-admin';

async function importOrder(store, value = order, area = workspace) {
  const preview = await store.previewImport(area, actor, [value]);
  return store.commitImport(area, actor, preview.importId);
}

test('empty SQLite store persists confirmed edits and confines reads to one workspace', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'dispatch-store-'));
  const path = join(folder, 'orders.sqlite');
  let store;
  try {
    store = await createStore(path);
    assert.deepEqual(await store.listOrders(workspace), []);
    assert.equal((await importOrder(store)).counts.created, 1);
    const before = await store.getOrder(workspace, order.id);
    assert.equal(before.items[0].nameHi, 'चावल');
    assert.deepEqual(before.items[0].aliases, ['तांदूळ']);
    assert.deepEqual(await store.listOrders(workspace, { query: 'ganesh' }), [
      { id: order.id, customer: order.customer, revision: before.revision, itemCount: 2 },
    ]);
    assert.equal(await store.getOrder('another-warehouse', order.id), null);
    await assert.rejects(store.saveQuantity(workspace, order.id, {
      itemId: 'SUGAR-1', quantity: 7, revision: before.revision, actor,
    }), { code: 'line-shipped', status: 409 });

    await store.saveQuantity(workspace, order.id, { itemId: 'RICE-1', quantity: 10, revision: before.revision, actor });
    store.close();
    store = undefined;
    store = await createStore(path);
    const saved = await store.getOrder(workspace, order.id);
    assert.equal(saved.revision, before.revision + 1);
    assert.equal(saved.items[0].quantity, 10);
    assert.equal(saved.items[1].quantity, 8);
    assert.equal(saved.history.length, 1);
    assert.equal(saved.history[0].actor, actor);
    assert.deepEqual([saved.history[0].from, saved.history[0].to], [20, 10]);
    await assert.rejects(store.saveQuantity(workspace, order.id, {
      itemId: 'RICE-1', quantity: 12, revision: before.revision, actor,
    }), { code: 'order-stale', status: 409 });
  } finally {
    store?.close();
    for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
    rmdirSync(folder);
  }
});

test('import preview is idempotent and does not delete omitted lines', async t => {
  const store = await createStore(':memory:');
  t.after(() => store.close());
  const preview = await store.previewImport(workspace, actor, [order]);
  assert.equal(await store.getOrder(workspace, order.id), null);
  await assert.rejects(store.commitImport(workspace, 'other-user', preview.importId), { code: 'import-not-found' });
  assert.deepEqual(await store.commitImport(workspace, actor, preview.importId), preview);
  assert.deepEqual(await store.commitImport(workspace, actor, preview.importId), preview);
  assert.equal((await importOrder(store)).counts.unchanged, 1);

  const update = { ...order, items: [{ ...order.items[0], quantity: 12 }] };
  assert.equal((await importOrder(store, update)).counts.updated, 1);
  const saved = await store.getOrder(workspace, order.id);
  assert.equal(saved.items.length, 2);
  assert.equal(saved.items[0].quantity, 12);
  assert.equal(saved.items[1].quantity, 8);
  assert.equal(saved.history[0].from, 20);
  assert.equal(saved.history[0].to, 12);
});

test('import conflict or revision drift rejects the complete batch', async t => {
  const store = await createStore(':memory:');
  t.after(() => store.close());
  await importOrder(store);
  const update = { ...order, items: [{ ...order.items[0], quantity: 12 }] };
  const newOrder = { ...order, id: 'ORDER-28' };
  const preview = await store.previewImport(workspace, actor, [newOrder, update]);
  const live = await store.getOrder(workspace, order.id);
  await store.saveQuantity(workspace, order.id, { itemId: 'RICE-1', quantity: 9, revision: live.revision, actor });
  await assert.rejects(store.commitImport(workspace, actor, preview.importId), { code: 'import-stale' });
  assert.equal(await store.getOrder(workspace, newOrder.id), null);
  assert.equal((await store.getOrder(workspace, order.id)).items[0].quantity, 9);

  const shippedUpdate = { ...order, items: [{ ...order.items[1], quantity: 7 }] };
  const conflict = await store.previewImport(workspace, actor, [newOrder, shippedUpdate]);
  assert.equal(conflict.counts.conflicts, 1);
  assert.equal(conflict.changes[1].status, 'conflict');
  await assert.rejects(store.commitImport(workspace, actor, conflict.importId), { code: 'import-conflict' });
  assert.equal(await store.getOrder(workspace, newOrder.id), null);
  assert.equal((await store.getOrder(workspace, order.id)).items[1].quantity, 8);
});

test('local requests use the loopback Host when Next normalizes the request URL', t => {
  const configured = process.env.DISPATCH_PUBLIC_ORIGIN;
  delete process.env.DISPATCH_PUBLIC_ORIGIN;
  t.after(() => {
    if (configured === undefined) delete process.env.DISPATCH_PUBLIC_ORIGIN;
    else process.env.DISPATCH_PUBLIC_ORIGIN = configured;
  });
  const request = (origin, host = '127.0.0.1:3000', site = 'same-origin') => new Request('http://localhost:3000/api/auth', {
    method: 'POST', headers: { Origin: origin, Host: host, 'Sec-Fetch-Site': site },
  });
  assert.doesNotThrow(() => assertSameOrigin(request('http://127.0.0.1:3000')));
  assert.throws(() => assertSameOrigin(request('http://127.0.0.1:3000', '127.0.0.1:3000', 'cross-site')), { code: 'cross-origin' });
  assert.throws(() => assertSameOrigin(request('http://localhost:3000')), { code: 'cross-origin' });
  assert.throws(() => assertSameOrigin(request('http://127.0.0.1:3001', '127.0.0.1:3001')), { code: 'cross-origin' });
  assert.throws(() => assertSameOrigin(request('http://other.example:3000', 'other.example:3000')), { code: 'cross-origin' });
  process.env.DISPATCH_PUBLIC_ORIGIN = 'https://dispatch.example';
  assert.throws(() => assertSameOrigin(request('http://127.0.0.1:3000')), { code: 'cross-origin' });
});

test('operator sign-in scopes cookies and rejects wrong credentials, cross-origin use, and revoked tokens', async t => {
  const store = await createStore(':memory:');
  t.after(() => store.close());
  const settings = {
    DISPATCH_ADMIN_USERNAME: actor,
    DISPATCH_ADMIN_PASSWORD: 'locally-generated-test-password',
    DISPATCH_OPERATOR_USERNAME: 'warehouse-agent',
    DISPATCH_OPERATOR_PASSWORD: 'different-local-test-password',
    DISPATCH_WORKSPACE_ID: workspace,
    DISPATCH_PUBLIC_ORIGIN: 'https://dispatch.example',
  };
  const original = Object.fromEntries(Object.keys(settings).map(name => [name, process.env[name]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  assert.ok(authConfigured());
  const login = (username, password, origin = 'https://dispatch.example') => authLogin(new Request(
    'http://127.0.0.1/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ username, password }),
    },
  ), store);
  assert.equal((await login(actor, settings.DISPATCH_ADMIN_PASSWORD, 'https://evil.example')).status, 403);
  assert.throws(() => assertSameOrigin(new Request('https://dispatch.example/api/import', {
    headers: { 'Sec-Fetch-Site': 'same-site' },
  })), { code: 'cross-origin' });
  assert.equal((await login(actor, 'wrong password')).status, 401);
  const signedIn = await login(settings.DISPATCH_OPERATOR_USERNAME, settings.DISPATCH_OPERATOR_PASSWORD);
  assert.equal(signedIn.status, 200);
  assert.deepEqual(await signedIn.json(), {
    user: { name: settings.DISPATCH_OPERATOR_USERNAME, role: 'operator' },
    workspaceId: workspace,
  });
  const cookie = signedIn.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict; Secure/);
  const headers = { Cookie: cookie.split(';')[0], Origin: 'https://dispatch.example' };
  const request = new Request('https://dispatch.example/api/orders', { headers });
  const session = await authenticate(request, store);
  assert.equal(session.workspaceId, workspace);
  assert.equal(session.role, 'operator');
  assert.equal((await authLogout(new Request('https://dispatch.example/api/auth/logout', { method: 'POST', headers }), store)).status, 200);
  assert.equal(await authenticate(request, store), null);
  delete process.env.DISPATCH_ADMIN_PASSWORD;
  assert.equal(authConfigured(), false);
  assert.equal((await login(actor, settings.DISPATCH_ADMIN_PASSWORD)).status, 503);
});

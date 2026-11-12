import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('stock substitutions are atomic and receipts use committed line data', async t => {
  const store = await createStore(':memory:');
  t.after(() => store.close());
  await importOrder(store, {
    ...order,
    items: [
      { ...order.items[0], quantity: 8, availableQuantity: 12, substituteSku: 'RICE-ALT', backorderAllowed: true },
      { id: 'ALT', name: 'Approved Rice', sku: 'RICE-ALT', quantity: 0, availableQuantity: 8, unit: 'bags', status: 'pending' },
      order.items[1],
    ],
  });
  const original = await store.getOrder(workspace, order.id);
  const proposal = {
    revision: original.revision, actor,
    updates: [{ itemId: 'RICE-1', from: 8, to: 12 }, { itemId: 'ALT', from: 0, to: 9 }],
    receipt: { language: 'mr-IN', blockedRequests: [
      { itemId: 'SUGAR-1', name: 'Sugar', reason: 'shipped', requested: 9, transcript: 'do not retain caller audio text' },
    ] },
  };
  await assert.rejects(store.saveQuantity(workspace, order.id, proposal), { code: 'stock-unavailable' });
  assert.deepEqual(await store.getOrder(workspace, order.id), original);
  assert.deepEqual(await store.getOrderReceipts(workspace, order.id), []);
  proposal.updates[1].to = 8;
  const saved = await store.saveQuantity(workspace, order.id, proposal);
  assert.equal(saved.revision, original.revision + 1);
  assert.deepEqual(saved.items.map(item => item.quantity), [12, 8, 8]);
  assert.equal(saved.receipt.language, 'mr-IN');
  assert.deepEqual(saved.receipt.changes, [
    { itemId: 'RICE-1', name: 'Rice', nameHi: 'चावल', unit: 'bags', from: 8, to: 12 },
    { itemId: 'ALT', name: 'Approved Rice', unit: 'bags', from: 0, to: 8 },
  ]);
  assert.deepEqual(saved.receipt.blockedRequests, [{ itemId: 'SUGAR-1', name: 'Sugar', reason: 'shipped', requested: 9 }]);
  assert.deepEqual(await store.getOrderReceipts(workspace, order.id, { id: saved.receipt.id }), [saved.receipt]);
  assert.deepEqual(await store.getOrderReceipts('other-warehouse', order.id), []);
  await assert.rejects(store.saveQuantity(workspace, order.id, proposal), { code: 'order-stale' });
  assert.equal((await store.getOrderReceipts(workspace, order.id)).length, 1);
});

test('persisted backorders, stage cutoffs and locked shipment updates respect stock and edit rules', async t => {
  const store = await createStore(':memory:');
  t.after(() => store.close());
  const rice = { ...order.items[0], quantity: 8, availableQuantity: 12, backorderAllowed: true };
  const sugar = { ...order.items[1], shippedAt: '2026-11-06T11:00:00+05:30' };
  await importOrder(store, { ...order, items: [rice, sugar] });
  let live = await store.getOrder(workspace, order.id);
  const save = (itemId, quantity, fields = {}) => store.saveQuantity(workspace, order.id, { itemId, quantity, revision: live.revision, actor, ...fields });
  await assert.rejects(save(rice.id, 20), { code: 'stock-unavailable' });
  live = await save(rice.id, 20, { backorderQuantity: 8, receipt: { language: 'hi-IN' } });
  assert.equal(live.items[0].backorderQuantity, 8);
  assert.equal(live.receipt.changes[0].backorderQuantity, 8);
  live = await save(rice.id, 11, { backorderQuantity: 0 });
  assert.equal(live.items[0].backorderQuantity, 0);

  const locked = {
    ...rice, quantity: 11, fulfillmentStage: 'packed', pickedAt: '2026-11-06T08:00:00Z', packedAt: '2026-11-06T09:00:00Z',
  };
  await importOrder(store, { ...order, items: [locked, { ...sugar, deliveryEta: '2026-11-10' }] });
  live = await store.getOrder(workspace, order.id);
  assert.equal(live.items[1].deliveryEta, '2026-11-10T00:00:00.000Z');
  await assert.rejects(save(rice.id, 10), { code: 'line-packed' });
  const reopened = await store.previewImport(workspace, actor, [{ ...order, items: [{ ...rice, quantity: 11, fulfillmentStage: 'picked' }] }]);
  assert.equal(reopened.counts.conflicts, 1);
  const updated = await importOrder(store, { ...order, items: [{ ...rice, quantity: 11, status: 'shipped', shippedAt: '2026-11-06T10:00:00Z' }] });
  assert.equal(updated.counts.updated, 1);
  assert.equal((await store.getOrder(workspace, order.id)).items[0].packedAt, locked.packedAt.replace('Z', '.000Z'));

  await importOrder(store, { ...order, id: 'ORDER-28', items: [{ ...rice, editCutoffAt: '2020-01-01T00:00:00Z' }] });
  await assert.rejects(store.saveQuantity(workspace, 'ORDER-28', { itemId: rice.id, quantity: 7, revision: 1, actor }), { code: 'line-cutoff' });
});

test('omitted import details persist and explicit clear markers remove editable metadata', async t => {
  const store = await createStore(':memory:');
  t.after(() => store.close());
  const rice = { ...order.items[0], quantity: 8 };
  await importOrder(store, { ...order, items: [{
    ...rice, availableQuantity: 12, deliveryEta: '2026-11-10', editCutoffAt: '2020-01-01T00:00:00Z',
  }] });
  assert.equal((await importOrder(store, { ...order, items: [rice] })).counts.unchanged, 1);
  const clear = { ...rice, availableQuantity: null, deliveryEta: null, editCutoffAt: null };
  const blocked = await store.previewImport(workspace, actor, [{ ...order, items: [{ ...clear, quantity: 7 }] }]);
  assert.equal(blocked.counts.conflicts, 1);
  assert.equal((await importOrder(store, { ...order, items: [clear] })).counts.updated, 1);
  assert.equal((await importOrder(store, { ...order, items: [clear] })).counts.unchanged, 1);
  const saved = await store.getOrder(workspace, order.id);
  assert.equal(saved.items[0].availableQuantity, undefined);
  assert.equal(saved.items[0].deliveryEta, undefined);
  assert.equal(saved.items[0].editCutoffAt, undefined);
  const changed = await store.saveQuantity(workspace, order.id, { itemId: rice.id, quantity: 14, revision: saved.revision, actor });
  assert.equal(changed.items[0].quantity, 14);
});

test('a schema v2 database keeps its order records and can create a new receipt', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'dispatch-migration-'));
  const path = join(folder, 'orders.sqlite');
  let store;
  try {
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        CREATE TABLE dispatch_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
        INSERT INTO dispatch_schema VALUES (1, 2);
        CREATE TABLE orders (workspace_id TEXT, id TEXT, customer TEXT, revision INTEGER, PRIMARY KEY (workspace_id,id));
        INSERT INTO orders VALUES ('warehouse-1', 'ORDER-27', 'Original customer', 1);
        CREATE TABLE order_items (
          workspace_id TEXT, order_id TEXT, id TEXT, position INTEGER, name TEXT, sku TEXT,
          unit TEXT, quantity INTEGER, status TEXT, aliases TEXT, name_hi TEXT, name_mr TEXT,
          PRIMARY KEY (workspace_id,order_id,id)
        );
        INSERT INTO order_items VALUES ('warehouse-1','ORDER-27','RICE-1',0,'Rice','RICE','bags',8,'pending','[]','','');
      `);
    } finally {
      legacy.close();
    }
    store = await createStore(path);
    const live = await store.getOrder(workspace, order.id);
    assert.equal(live.customer, 'Original customer');
    assert.equal(live.items[0].quantity, 8);
    assert.equal(live.items[0].availableQuantity, undefined);
    const saved = await store.saveQuantity(workspace, order.id, {
      itemId: live.items[0].id, quantity: 12, revision: live.revision, actor, receipt: { language: 'en-IN' },
    });
    store.close();
    store = await createStore(path);
    assert.equal((await store.getOrder(workspace, order.id)).items[0].quantity, 12);
    assert.deepEqual(await store.getOrderReceipts(workspace, order.id), [saved.receipt]);
  } finally {
    store?.close();
    for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
    rmdirSync(folder);
  }
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

test('local operator access is opt-in and confined to direct loopback requests', async t => {
  const names = ['DISPATCH_LOCAL_ACCESS', 'DISPATCH_WORKSPACE_ID', 'DISPATCH_PUBLIC_ORIGIN',
    'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'VERCEL'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of names) delete process.env[name];
  const local = (headers = {}) => new Request('http://localhost:3000/api/catalog', {
    headers: { Host: '127.0.0.1:3000', 'Sec-Fetch-Site': 'same-origin', ...headers },
  });
  assert.equal(await authenticate(local()), null);
  process.env.DISPATCH_LOCAL_ACCESS = '1';
  process.env.DISPATCH_WORKSPACE_ID = 'local-test';
  assert.deepEqual(await authenticate(local({ 'X-Forwarded-For': '127.0.0.1' })), {
    workspaceId: 'local-test', user: 'Local operator', role: 'admin', sessionId: 'local-access:local-test',
  });
  assert.equal(await authenticate(local({ Host: 'dispatch.example' })), null);
  assert.equal(await authenticate(local({ 'X-Forwarded-Host': 'dispatch.example' })), null);
  assert.equal(await authenticate(local({ 'X-Forwarded-For': '192.0.2.1' })), null);
  assert.equal(await authenticate(local({ 'Sec-Fetch-Site': 'cross-site' })), null);
  process.env.DISPATCH_PUBLIC_ORIGIN = 'https://dispatch.example';
  assert.equal(await authenticate(local()), null);
  delete process.env.DISPATCH_PUBLIC_ORIGIN;
  process.env.VERCEL = '1';
  assert.equal(await authenticate(local()), null);
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

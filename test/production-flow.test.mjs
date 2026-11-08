import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { createStore } from '../src/store.mjs';
import { createDispatchHandlers } from '../src/http.mjs';

test('an authorized import survives restart and supports bilingual confirmed edits', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-production-test-'));
  const file = join(dir, 'orders.sqlite');
  let store = await createStore(file);
  context.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const env = {
    DISPATCH_ADMIN_USERNAME: 'test-admin',
    DISPATCH_ADMIN_PASSWORD: 'test-admin-password-123',
    DISPATCH_OPERATOR_USERNAME: 'test-operator',
    DISPATCH_OPERATOR_PASSWORD: 'test-operator-password-123',
    DISPATCH_WORKSPACE_ID: 'production-flow-test',
  };
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  context.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let app = createDispatchHandlers({ store });
  const base = 'http://dispatch.test';
  const invoke = (handler, path, init) => app[handler](new Request(base + path, init));
  const signIn = async (username, password) => {
    const response = await invoke('signIn', '/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  assert.equal((await invoke('orders', '/api/orders')).status, 401);
  const admin = await signIn('test-admin', 'test-admin-password-123');
  const operator = await signIn('test-operator', 'test-operator-password-123');
  const orders = (cookie = admin, query = '') => invoke('orders', '/api/orders?q=' + query, { headers: { Cookie: cookie } });
  assert.deepEqual(await orders().then(r => r.json()), { orders: [] });

  const row = ['PO-9928', 'North Market', 'L-8', 'Green tea', 'TEA-50', 'boxes', 20, 'pending', 'ग्रीन टी'];
  const header = ['orderId', 'customer', 'lineId', 'name', 'sku', 'unit', 'quantity', 'status', 'aliases'];
  const csv = Buffer.from([header, row].map(fields => fields.join(',')).join('\n'));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Orders');
  sheet.addRows([header, row]);
  const spreadsheet = await workbook.xlsx.writeBuffer();
  const json = Buffer.from(JSON.stringify({ version: 1, orders: [{
    id: row[0], customer: row[1], items: [{
      id: row[2], name: row[3], sku: row[4], unit: row[5], quantity: row[6], status: row[7], aliases: [row[8]],
    }],
  }] }));
  const upload = (filename, bytes, phase, cookie = admin) => invoke('imports', '/api/imports?phase=' + phase, {
    method: 'POST', headers: { Cookie: cookie, 'X-Filename': filename }, body: bytes,
  });
  const commit = importId => invoke('imports', '/api/imports?phase=commit', {
    method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ importId }),
  });
  assert.equal((await upload('orders.csv', csv, 'preview', operator)).status, 403);
  const invalid = await upload('invalid.csv', Buffer.from('orderId,quantity\nO-1,-2'), 'preview').then(r => r.json());
  assert.ok(invalid.errors.length > 0);

  for (const [index, filename, bytes] of [[0, 'orders.csv', csv], [1, 'orders.xlsx', spreadsheet], [2, 'orders.json', json]]) {
    const info = await upload(filename, bytes, 'inspect');
    assert.equal(info.status, 200, filename);
    const previewResponse = await upload(filename, bytes, 'preview');
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200, JSON.stringify(preview));
    assert.deepEqual(preview.errors, [], filename);
    assert.equal(preview.counts[index ? 'unchanged' : 'created'], 1, JSON.stringify(preview));
    const result = await commit(preview.importId);
    assert.equal(result.status, 200, filename);
    assert.equal((await commit(preview.importId)).status, 200);
  }

  const found = await orders(operator, '9928').then(r => r.json());
  assert.equal(found.orders.length, 1);
  const open = () => invoke('session', '/api/session?orderId=PO-9928', { headers: { Cookie: operator } });
  let call = await open().then(r => r.json());
  const turn = async (text, language) => {
    const response = await invoke('turn', '/api/turn', {
      method: 'POST',
      headers: { Cookie: operator, 'Content-Type': 'application/json', 'X-Session-Id': call.sessionId, 'X-Session-Revision': String(call.revision) },
      body: JSON.stringify({ text, language }),
    });
    assert.equal(response.status, 200);
    call = await response.json();
  };
  await turn('ग्रीन टी बारा बॉक्स करा', 'mr-IN');
  assert.equal(call.pending.to, 12);
  store.close();
  store = await createStore(file);
  app = createDispatchHandlers({ store });
  await turn('बारह नहीं, दस कर दो', 'hi-IN');
  assert.equal(call.pending.to, 10);
  assert.equal(call.order.items[0].quantity, 20);
  await turn('हाँ, कर दीजिए', 'hi-IN');
  assert.equal(call.order.items[0].quantity, 10);
  assert.equal(call.history[0].actor, 'test-operator');

  store.close();
  store = await createStore(file);
  app = createDispatchHandlers({ store });
  const restored = await open().then(r => r.json());
  assert.equal(restored.order.items[0].quantity, 10);
  assert.equal(restored.history.length, 1);
  assert.equal(restored.pending, null);
});

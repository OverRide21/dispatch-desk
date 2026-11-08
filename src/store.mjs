import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createClient } from '@libsql/client/web';
import { openLocalSqlite } from './sqlite.mjs';

const importLifetime = 30 * 60 * 1000;
const maxQuantity = 1_000_000;
const schemaVersion = 2;
const callLifetime = 2 * 60 * 60 * 1000;
const lockLifetime = 60_000;

function storeError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function normalizeString(value, limit, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw storeError(400, 'invalid-order', `Check the ${label}.`);
  }
  return value.trim().normalize('NFC');
}

function validQuantity(quantity) {
  return Number.isSafeInteger(quantity) && quantity >= 0 && quantity <= maxQuantity;
}

function normalizeItem(item) {
  if (!item || !validQuantity(item.quantity) || !['pending', 'shipped'].includes(item.status)) {
    throw storeError(400, 'invalid-order', 'Every line needs a valid quantity and fulfillment status.');
  }
  const sku = normalizeString(item.sku, 100, 'SKU', { optional: true });
  if (item.aliases != null && (!Array.isArray(item.aliases) || item.aliases.length > 30)) {
    throw storeError(400, 'invalid-order', 'Use at most 30 item aliases.');
  }
  return {
    id: normalizeString(item.id, 100, 'line ID'),
    name: normalizeString(item.name || sku, 180, 'item name'),
    sku,
    unit: normalizeString(item.unit, 50, 'unit'),
    quantity: item.quantity,
    status: item.status,
    aliases: [...new Set((item.aliases ?? []).map(alias => normalizeString(alias, 120, 'item alias')))].sort(),
    nameHi: normalizeString(item.nameHi, 180, 'Hindi item name', { optional: true }),
    nameMr: normalizeString(item.nameMr, 180, 'Marathi item name', { optional: true }),
  };
}

function normalizeOrders(orders) {
  if (!Array.isArray(orders) || !orders.length || orders.length > 2_000) {
    throw storeError(400, 'invalid-order', 'An import must contain between 1 and 2,000 orders.');
  }
  const ids = new Set();
  let lines = 0;
  return orders.map(order => {
    const id = normalizeString(order?.id, 100, 'order ID');
    const customer = normalizeString(order?.customer, 180, 'customer reference');
    if (ids.has(id)) throw storeError(400, 'duplicate-order', 'An order ID occurs more than once in the import.');
    ids.add(id);
    if (!Array.isArray(order.items) || !order.items.length || (lines += order.items.length) > 10_000) {
      throw storeError(400, 'invalid-order', 'Include at least one line per order and at most 10,000 lines per import.');
    }
    const items = order.items.map(normalizeItem);
    if (new Set(items.map(item => item.id)).size !== items.length) {
      throw storeError(400, 'duplicate-line', 'A line ID occurs more than once in an order.');
    }
    return { id, customer, items };
  });
}

function rowToItem(row) {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    unit: row.unit,
    quantity: row.quantity,
    status: row.status,
    aliases: JSON.parse(row.aliases),
    nameHi: row.name_hi,
    nameMr: row.name_mr,
  };
}

function sameItem(left, right) {
  return left.name === right.name && left.sku === right.sku && left.unit === right.unit &&
    left.quantity === right.quantity && left.status === right.status &&
    left.nameHi === right.nameHi && left.nameMr === right.nameMr &&
    JSON.stringify(left.aliases) === JSON.stringify(right.aliases);
}

function compareOrder(current, incoming) {
  if (!current) return { status: 'created', order: incoming };
  const byId = new Map(incoming.items.map(item => [item.id, item]));
  let changed = current.customer !== incoming.customer;
  const items = [];
  for (const existing of current.items) {
    const next = byId.get(existing.id);
    byId.delete(existing.id);
    if (!next || sameItem(existing, next)) {
      items.push(existing);
      continue;
    }
    if (existing.status === 'shipped') {
      return { status: 'conflict', message: `Shipped line ${existing.id} differs from the saved order.` };
    }
    changed = true;
    items.push(next);
  }
  if (byId.size) changed = true;
  items.push(...byId.values());
  return { status: changed ? 'updated' : 'unchanged', order: { ...incoming, items } };
}

async function setup(db) {
  const metadata = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_schema'");
  const version = metadata.rows.length
    ? (await db.execute('SELECT version FROM dispatch_schema WHERE id = 1')).rows[0]?.version ?? 0
    : (await db.execute('PRAGMA user_version')).rows[0].user_version;
  if (version > schemaVersion) throw new Error('The database was created by a newer Dispatch Desk version.');
  if (metadata.rows.length && version === schemaVersion) return;
  const schema = `
    CREATE TABLE IF NOT EXISTS dispatch_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS orders (
      workspace_id TEXT NOT NULL, id TEXT NOT NULL, customer TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      PRIMARY KEY (workspace_id, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS order_items (
      workspace_id TEXT NOT NULL, order_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL,
      name TEXT NOT NULL, sku TEXT NOT NULL, unit TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 0 AND 1000000),
      status TEXT NOT NULL CHECK (status IN ('pending', 'shipped')),
      aliases TEXT NOT NULL, name_hi TEXT NOT NULL, name_mr TEXT NOT NULL,
      PRIMARY KEY (workspace_id, order_id, id),
      FOREIGN KEY (workspace_id, order_id) REFERENCES orders (workspace_id, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS order_changes (
      sequence INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, order_id TEXT NOT NULL,
      item_id TEXT NOT NULL, name TEXT NOT NULL, from_quantity INTEGER NOT NULL, to_quantity INTEGER NOT NULL,
      created_at TEXT NOT NULL, actor TEXT NOT NULL,
      FOREIGN KEY (workspace_id, order_id, item_id) REFERENCES order_items (workspace_id, order_id, id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS order_changes_by_order
      ON order_changes (workspace_id, order_id, sequence DESC);
    CREATE TABLE IF NOT EXISTS order_imports (
      workspace_id TEXT NOT NULL, id TEXT NOT NULL, actor TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, committed_at INTEGER,
      data TEXT, result TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user TEXT NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS call_sessions (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace_id TEXT NOT NULL,
      state TEXT NOT NULL, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      lock_token TEXT, lock_until INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS call_sessions_owner ON call_sessions (owner);
    CREATE INDEX IF NOT EXISTS call_sessions_expiry ON call_sessions (expires_at);
    CREATE TABLE IF NOT EXISTS request_limits (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS request_limits_expiry ON request_limits (until_at);
    INSERT INTO dispatch_schema (id, version) VALUES (1, ${schemaVersion})
      ON CONFLICT(id) DO UPDATE SET version = max(dispatch_schema.version, excluded.version);
  `;
  await db.batch(schema.split(';').map(statement => statement.trim()).filter(Boolean), 'write');
}

export async function createStore(path = process.env.DISPATCH_DB_PATH || '.dispatch/dispatch.sqlite', cloud = null) {
  let db;
  if (cloud) {
    db = createClient(cloud);
  } else {
    const filename = path === ':memory:' ? path : resolve(/* turbopackIgnore: true */ path);
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    db = openLocalSqlite(filename);
  }
  try {
    await setup(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const orderById = 'SELECT id, customer, revision FROM orders WHERE workspace_id = ? AND id = ?';
  const itemsByOrder = 'SELECT * FROM order_items WHERE workspace_id = ? AND order_id = ? ORDER BY position, id';
  const changesByOrder = `
    SELECT item_id AS itemId, name, from_quantity AS "from", to_quantity AS "to", created_at AS at, actor
    FROM order_changes WHERE workspace_id = ? AND order_id = ? ORDER BY sequence DESC LIMIT 100
  `;
  const list = `
    SELECT o.id, o.customer, o.revision,
      (SELECT count(*) FROM order_items i WHERE i.workspace_id = o.workspace_id AND i.order_id = o.id
        AND (i.quantity > 0 OR i.status = 'shipped')) AS itemCount
    FROM orders o WHERE o.workspace_id = ?
      AND (instr(lower(o.id), lower(?)) > 0 OR instr(lower(o.customer), lower(?)) > 0)
    ORDER BY o.id COLLATE NOCASE, o.id LIMIT ?
  `;
  const writeOrder = `
    INSERT INTO orders (workspace_id, id, customer, revision) VALUES (?, ?, ?, ?)
    ON CONFLICT (workspace_id, id) DO UPDATE SET customer = excluded.customer, revision = excluded.revision
  `;
  const writeItem = `
    INSERT INTO order_items (workspace_id, order_id, id, position, name, sku, unit, quantity, status, aliases, name_hi, name_mr)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, order_id, id) DO UPDATE SET position = excluded.position,
      name = excluded.name, sku = excluded.sku, unit = excluded.unit, quantity = excluded.quantity,
      status = excluded.status, aliases = excluded.aliases, name_hi = excluded.name_hi, name_mr = excluded.name_mr
  `;
  const insertChange = `
    INSERT INTO order_changes (workspace_id, order_id, item_id, name, from_quantity, to_quantity, created_at, actor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const changeQuantity = 'UPDATE order_items SET quantity = ? WHERE workspace_id = ? AND order_id = ? AND id = ?';
  const incrementRevision = 'UPDATE orders SET revision = revision + 1 WHERE workspace_id = ? AND id = ?';
  const importById = 'SELECT * FROM order_imports WHERE workspace_id = ? AND id = ? AND actor = ?';
  const insertImport = 'INSERT INTO order_imports (workspace_id, id, actor, created_at, expires_at, data, result) VALUES (?, ?, ?, ?, ?, ?, ?)';
  const finishImport = 'UPDATE order_imports SET committed_at = ?, data = NULL WHERE workspace_id = ? AND id = ?';
  const purgeImports = 'DELETE FROM order_imports WHERE committed_at IS NULL AND expires_at <= ?';
  const insertAuth = 'INSERT INTO auth_sessions (workspace_id, user, token_hash, expires_at) VALUES (?, ?, ?, ?)';
  const authByToken = 'SELECT workspace_id AS workspaceId, user, expires_at AS expiresAt FROM auth_sessions WHERE token_hash = ? AND expires_at > ?';
  const deleteAuth = 'DELETE FROM auth_sessions WHERE token_hash = ?';
  const purgeAuth = 'DELETE FROM auth_sessions WHERE expires_at <= ?';
  const callFields = 'id, owner, workspace_id AS workspaceId, state, revision';
  const callMatch = 'id = ? AND owner = ? AND workspace_id = ? AND expires_at > ?';

  const statement = (sql, ...args) => ({ sql, args });

  async function transaction(work) {
    const tx = await db.transaction('write');
    try {
      const result = await work(tx);
      await tx.commit();
      return result;
    } finally {
      tx.close();
    }
  }

  async function getOrder(workspaceId, id, client = db) {
    const queries = [
      statement(orderById, workspaceId, id),
      statement(itemsByOrder, workspaceId, id),
      statement(changesByOrder, workspaceId, id),
    ];
    const [order, items, history] = client === db ? await db.batch(queries, 'read') : await client.batch(queries);
    if (!order.rows.length) return null;
    return {
      ...order.rows[0],
      items: items.rows.map(rowToItem),
      history: history.rows.map(row => ({ ...row })),
    };
  }

  async function getOrdersForImport(tx, workspaceId, ids) {
    const selection = ' WHERE workspace_id = ? AND ';
    const selected = JSON.stringify(ids);
    const [orders, items] = await tx.batch([
      statement('SELECT id, customer, revision FROM orders' + selection + 'id IN (SELECT value FROM json_each(?))', workspaceId, selected),
      statement('SELECT * FROM order_items' + selection + 'order_id IN (SELECT value FROM json_each(?)) ORDER BY position, id', workspaceId, selected),
    ]);
    const byId = new Map(orders.rows.map(row => [row.id, { ...row, items: [] }]));
    for (const row of items.rows) byId.get(row.order_id)?.items.push(rowToItem(row));
    return byId;
  }

  function saveQuantity(workspaceId, orderId, { itemId, quantity, revision, actor, newItem }) {
    if (!validQuantity(quantity)) throw storeError(400, 'invalid-quantity', 'Enter a whole quantity between 0 and 1,000,000.');
    return transaction(async tx => {
      const order = await getOrder(workspaceId, orderId, tx);
      if (!order) throw storeError(404, 'order-not-found', 'The order could not be found.');
      if (order.revision !== revision) throw storeError(409, 'order-stale', 'This order changed. Review it before confirming again.');
      const item = order.items.find(line => line.id === itemId);
      if (newItem) {
        const added = normalizeItem({ ...newItem, id: itemId, quantity, status: 'pending' });
        if (!quantity || item || order.items.some(line =>
          line.name.toLowerCase() === added.name.toLowerCase() ||
          (added.sku && line.sku.toLowerCase() === added.sku.toLowerCase()))) {
          throw storeError(409, 'order-conflict', 'That item already exists or has an invalid quantity. Review the order and try again.');
        }
        await tx.batch([
          statement(writeItem, workspaceId, orderId, added.id, order.items.length, added.name, added.sku, added.unit,
            quantity, added.status, JSON.stringify(added.aliases), added.nameHi, added.nameMr),
          statement(incrementRevision, workspaceId, orderId),
          statement(insertChange, workspaceId, orderId, added.id, added.name, 0, quantity, new Date().toISOString(), actor),
        ]);
        return getOrder(workspaceId, orderId, tx);
      }
      if (!item) throw storeError(404, 'line-not-found', 'The order line could not be found.');
      if (item.status === 'shipped') throw storeError(409, 'line-shipped', 'This line has shipped and its quantity cannot change.');
      if (item.quantity === quantity) return order;
      await tx.batch([
        statement(changeQuantity, quantity, workspaceId, orderId, item.id),
        statement(incrementRevision, workspaceId, orderId),
        statement(insertChange, workspaceId, orderId, item.id, item.name, item.quantity, quantity, new Date().toISOString(), actor),
      ]);
      return getOrder(workspaceId, orderId, tx);
    });
  }

  function previewImport(workspaceId, actor, orders) {
    const normalized = normalizeOrders(orders);
    return transaction(async tx => {
      const now = Date.now();
      await tx.execute(statement(purgeImports, now));
      const importId = randomUUID();
      const counts = { created: 0, updated: 0, unchanged: 0, conflicts: 0 };
      const changes = [];
      const data = [];
      const saved = await getOrdersForImport(tx, workspaceId, normalized.map(order => order.id));
      for (const order of normalized) {
        const current = saved.get(order.id);
        const compared = compareOrder(current, order);
        counts[compared.status === 'conflict' ? 'conflicts' : compared.status]++;
        changes.push({ id: order.id, status: compared.status, ...(compared.message ? { message: compared.message } : {}) });
        data.push({ order, revision: current?.revision ?? null });
      }
      const result = { importId, counts, changes };
      await tx.execute(statement(insertImport, workspaceId, importId, actor, now, now + importLifetime, JSON.stringify(data), JSON.stringify(result)));
      return result;
    });
  }

  function commitImport(workspaceId, actor, importId) {
    return transaction(async tx => {
      const [job] = (await tx.execute(statement(importById, workspaceId, importId, actor))).rows;
      if (!job) throw storeError(404, 'import-not-found', 'This import preview could not be found.');
      const result = JSON.parse(job.result);
      if (job.committed_at !== null) return result;
      if (job.expires_at <= Date.now()) throw storeError(409, 'import-expired', 'This preview expired. Upload the file to review it again.');
      if (result.counts.conflicts) throw storeError(409, 'import-conflict', 'Resolve the order conflicts and preview the file again.');
      const preview = JSON.parse(job.data);
      const saved = await getOrdersForImport(tx, workspaceId, preview.map(({ order }) => order.id));
      const entries = preview.map(({ order, revision }) => {
        const current = saved.get(order.id);
        if ((current?.revision ?? null) !== revision) {
          throw storeError(409, 'import-stale', 'An order changed since the preview. Upload the file to review the latest orders.');
        }
        const compared = compareOrder(current, order);
        if (compared.status === 'conflict') throw storeError(409, 'import-conflict', compared.message);
        return { current, ...compared };
      });
      const at = new Date().toISOString();
      const writes = [];
      for (const { current, status, order } of entries) {
        if (status === 'unchanged') continue;
        writes.push(statement(writeOrder, workspaceId, order.id, order.customer, (current?.revision ?? 0) + 1));
        const previous = new Map(current?.items.map(item => [item.id, item]));
        for (const [position, item] of order.items.entries()) {
          writes.push(statement(writeItem, workspaceId, order.id, item.id, position, item.name, item.sku, item.unit, item.quantity,
            item.status, JSON.stringify(item.aliases), item.nameHi, item.nameMr));
          const before = previous.get(item.id);
          if (before && before.quantity !== item.quantity) {
            writes.push(statement(insertChange, workspaceId, order.id, item.id, item.name, before.quantity, item.quantity, at, actor));
          }
        }
      }
      writes.push(statement(finishImport, Date.now(), workspaceId, importId));
      for (let i = 0; i < writes.length; i += 200) await tx.batch(writes.slice(i, i + 200));
      return result;
    });
  }

  function decodeCall(row) {
    return row ? { ...row, state: JSON.parse(row.state) } : null;
  }

  async function getCall(id, actor) {
    if (!id) return null;
    const result = await db.execute(statement(`SELECT ${callFields} FROM call_sessions WHERE ${callMatch}`,
      id, actor.sessionId, actor.workspaceId, Date.now()));
    return decodeCall(result.rows[0]);
  }

  async function createCall(actor, state) {
    const now = Date.now();
    const call = { id: randomUUID(), owner: actor.sessionId, workspaceId: actor.workspaceId, state, revision: 0 };
    await db.batch([
      statement('DELETE FROM call_sessions WHERE expires_at <= ?', now),
      statement('INSERT INTO call_sessions (id, owner, workspace_id, state, revision, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        call.id, call.owner, call.workspaceId, JSON.stringify(state), call.revision, now + callLifetime),
    ], 'write');
    return call;
  }

  async function lockCall(id, actor) {
    const now = Date.now();
    const lock = randomUUID();
    const result = await db.execute(statement(`UPDATE call_sessions SET lock_token = ?, lock_until = ?, expires_at = ?
      WHERE ${callMatch} AND lock_until <= ? RETURNING ${callFields}`,
      lock, now + lockLifetime, now + callLifetime, id, actor.sessionId, actor.workspaceId, now, now));
    const call = decodeCall(result.rows[0]);
    return call ? { ...call, lock } : null;
  }

  async function saveCall(call) {
    const result = await db.execute(statement(`UPDATE call_sessions SET state = ?, revision = ?, expires_at = ?,
      lock_token = NULL, lock_until = 0 WHERE id = ? AND lock_token = ?`,
    JSON.stringify(call.state), call.revision, Date.now() + callLifetime, call.id, call.lock));
    if (!result.rowsAffected) throw storeError(409, 'session-stale', 'The call changed. Review the latest order and try again.');
  }

  async function rateLimit(key, max, windowMs) {
    const now = Date.now();
    const [, result] = await db.batch([
      statement('DELETE FROM request_limits WHERE until_at <= ?', now),
      statement(`INSERT INTO request_limits (key, count, until_at) VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`, key, now + windowMs, max),
    ], 'write');
    return result.rows.length > 0;
  }

  return {
    close: () => db.close(),
    async listOrders(workspaceId, { query = '', limit = 50 } = {}) {
      const filter = typeof query === 'string' ? query.trim().slice(0, 120) : '';
      const size = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
      return (await db.execute(statement(list, workspaceId, filter, filter, size))).rows.map(row => ({ ...row }));
    },
    getOrder,
    saveQuantity,
    previewImport,
    commitImport,
    getCall,
    createCall,
    lockCall,
    saveCall,
    unlockCall: call => db.execute(statement('UPDATE call_sessions SET lock_token = NULL, lock_until = 0 WHERE id = ? AND lock_token = ?', call.id, call.lock)),
    deleteCalls: owner => db.execute(statement('DELETE FROM call_sessions WHERE owner = ?', owner)),
    rateLimit,
    async getRate(key) {
      const result = await db.execute(statement('SELECT count, until_at AS until FROM request_limits WHERE key = ? AND until_at > ?', key, Date.now()));
      return result.rows[0];
    },
    clearRate: key => db.execute(statement('DELETE FROM request_limits WHERE key = ?', key)),
    createAuthSession(workspaceId, user, tokenHash, expiresAt) {
      return db.batch([statement(purgeAuth, Date.now()), statement(insertAuth, workspaceId, user, tokenHash, expiresAt)], 'write');
    },
    async getAuthSession(tokenHash) {
      const [row] = (await db.execute(statement(authByToken, tokenHash, Date.now()))).rows;
      return row ? { ...row } : null;
    },
    deleteAuthSession: tokenHash => db.execute(statement(deleteAuth, tokenHash)),
  };
}

const storeKey = Symbol.for('dispatch-desk.production-store');

export function getStore() {
  if (!globalThis[storeKey]) {
    const url = process.env.TURSO_DATABASE_URL?.trim();
    const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
    if ((process.env.VERCEL || url || authToken) && (!url || !authToken)) {
      throw storeError(503, 'database-unconfigured', 'Configure the hosted database to open Dispatch Desk.');
    }
    globalThis[storeKey] = createStore(undefined, url ? { url, authToken } : null).catch(error => {
      delete globalThis[storeKey];
      throw error;
    });
  }
  return globalThis[storeKey];
}

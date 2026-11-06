import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const importLifetime = 30 * 60 * 1000;
const maxQuantity = 1_000_000;
const schemaVersion = 1;

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

function setup(db) {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > schemaVersion) throw new Error('The database was created by a newer Dispatch Desk version.');
  if (version === schemaVersion) return;
  db.exec(`
    BEGIN IMMEDIATE;
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
    PRAGMA user_version = 1;
    COMMIT;
  `);
}

export function createStore(path = process.env.DISPATCH_DB_PATH || '.dispatch/dispatch.sqlite') {
  const filename = path === ':memory:' ? path : resolve(/* turbopackIgnore: true */ path);
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  try {
    setup(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const orderById = db.prepare('SELECT id, customer, revision FROM orders WHERE workspace_id = ? AND id = ?');
  const itemsByOrder = db.prepare('SELECT * FROM order_items WHERE workspace_id = ? AND order_id = ? ORDER BY position, id');
  const changesByOrder = db.prepare(`
    SELECT item_id AS itemId, name, from_quantity AS "from", to_quantity AS "to", created_at AS at, actor
    FROM order_changes WHERE workspace_id = ? AND order_id = ? ORDER BY sequence DESC LIMIT 100
  `);
  const list = db.prepare(`
    SELECT o.id, o.customer, o.revision,
      (SELECT count(*) FROM order_items i WHERE i.workspace_id = o.workspace_id AND i.order_id = o.id) AS itemCount
    FROM orders o WHERE o.workspace_id = ?
      AND (instr(lower(o.id), lower(?)) > 0 OR instr(lower(o.customer), lower(?)) > 0)
    ORDER BY o.id COLLATE NOCASE, o.id LIMIT ?
  `);
  const writeOrder = db.prepare(`
    INSERT INTO orders (workspace_id, id, customer, revision) VALUES (?, ?, ?, ?)
    ON CONFLICT (workspace_id, id) DO UPDATE SET customer = excluded.customer, revision = excluded.revision
  `);
  const writeItem = db.prepare(`
    INSERT INTO order_items (workspace_id, order_id, id, position, name, sku, unit, quantity, status, aliases, name_hi, name_mr)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, order_id, id) DO UPDATE SET position = excluded.position,
      name = excluded.name, sku = excluded.sku, unit = excluded.unit, quantity = excluded.quantity,
      status = excluded.status, aliases = excluded.aliases, name_hi = excluded.name_hi, name_mr = excluded.name_mr
  `);
  const insertChange = db.prepare(`
    INSERT INTO order_changes (workspace_id, order_id, item_id, name, from_quantity, to_quantity, created_at, actor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const changeQuantity = db.prepare('UPDATE order_items SET quantity = ? WHERE workspace_id = ? AND order_id = ? AND id = ?');
  const incrementRevision = db.prepare('UPDATE orders SET revision = revision + 1 WHERE workspace_id = ? AND id = ?');
  const importById = db.prepare('SELECT * FROM order_imports WHERE workspace_id = ? AND id = ? AND actor = ?');
  const insertImport = db.prepare('INSERT INTO order_imports (workspace_id, id, actor, created_at, expires_at, data, result) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const finishImport = db.prepare('UPDATE order_imports SET committed_at = ?, data = NULL WHERE workspace_id = ? AND id = ?');
  const purgeImports = db.prepare('DELETE FROM order_imports WHERE committed_at IS NULL AND expires_at <= ?');
  const insertAuth = db.prepare('INSERT INTO auth_sessions (workspace_id, user, token_hash, expires_at) VALUES (?, ?, ?, ?)');
  const authByToken = db.prepare('SELECT workspace_id AS workspaceId, user, expires_at AS expiresAt FROM auth_sessions WHERE token_hash = ? AND expires_at > ?');
  const deleteAuth = db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?');
  const purgeAuth = db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?');

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getOrder(workspaceId, id) {
    const order = orderById.get(workspaceId, id);
    if (!order) return null;
    return {
      ...order,
      items: itemsByOrder.all(workspaceId, id).map(rowToItem),
      history: changesByOrder.all(workspaceId, id).map(row => ({ ...row })),
    };
  }

  function saveQuantity(workspaceId, orderId, { itemId, quantity, revision, actor }) {
    if (!validQuantity(quantity)) throw storeError(400, 'invalid-quantity', 'Enter a whole quantity between 0 and 1,000,000.');
    return transaction(() => {
      const order = getOrder(workspaceId, orderId);
      if (!order) throw storeError(404, 'order-not-found', 'The order could not be found.');
      if (order.revision !== revision) throw storeError(409, 'order-stale', 'This order changed. Review it before confirming again.');
      const item = order.items.find(line => line.id === itemId);
      if (!item) throw storeError(404, 'line-not-found', 'The order line could not be found.');
      if (item.status === 'shipped') throw storeError(409, 'line-shipped', 'This line has shipped and its quantity cannot change.');
      if (item.quantity === quantity) return order;
      changeQuantity.run(quantity, workspaceId, orderId, item.id);
      incrementRevision.run(workspaceId, orderId);
      insertChange.run(workspaceId, orderId, item.id, item.name, item.quantity, quantity, new Date().toISOString(), actor);
      return getOrder(workspaceId, orderId);
    });
  }

  function previewImport(workspaceId, actor, orders) {
    const normalized = normalizeOrders(orders);
    return transaction(() => {
      const now = Date.now();
      purgeImports.run(now);
      const importId = randomUUID();
      const counts = { created: 0, updated: 0, unchanged: 0, conflicts: 0 };
      const changes = [];
      const data = [];
      for (const order of normalized) {
        const current = getOrder(workspaceId, order.id);
        const compared = compareOrder(current, order);
        counts[compared.status === 'conflict' ? 'conflicts' : compared.status]++;
        changes.push({ id: order.id, status: compared.status, ...(compared.message ? { message: compared.message } : {}) });
        data.push({ order, revision: current?.revision ?? null });
      }
      const result = { importId, counts, changes };
      insertImport.run(workspaceId, importId, actor, now, now + importLifetime, JSON.stringify(data), JSON.stringify(result));
      return result;
    });
  }

  function commitImport(workspaceId, actor, importId) {
    return transaction(() => {
      const job = importById.get(workspaceId, importId, actor);
      if (!job) throw storeError(404, 'import-not-found', 'This import preview could not be found.');
      const result = JSON.parse(job.result);
      if (job.committed_at !== null) return result;
      if (job.expires_at <= Date.now()) throw storeError(409, 'import-expired', 'This preview expired. Upload the file to review it again.');
      if (result.counts.conflicts) throw storeError(409, 'import-conflict', 'Resolve the order conflicts and preview the file again.');
      const entries = JSON.parse(job.data).map(({ order, revision }) => {
        const current = getOrder(workspaceId, order.id);
        if ((current?.revision ?? null) !== revision) {
          throw storeError(409, 'import-stale', 'An order changed since the preview. Upload the file to review the latest orders.');
        }
        const compared = compareOrder(current, order);
        if (compared.status === 'conflict') throw storeError(409, 'import-conflict', compared.message);
        return { current, ...compared };
      });
      const at = new Date().toISOString();
      for (const { current, status, order } of entries) {
        if (status === 'unchanged') continue;
        writeOrder.run(workspaceId, order.id, order.customer, (current?.revision ?? 0) + 1);
        const previous = new Map(current?.items.map(item => [item.id, item]));
        for (const [position, item] of order.items.entries()) {
          writeItem.run(workspaceId, order.id, item.id, position, item.name, item.sku, item.unit, item.quantity,
            item.status, JSON.stringify(item.aliases), item.nameHi, item.nameMr);
          const before = previous.get(item.id);
          if (before && before.quantity !== item.quantity) {
            insertChange.run(workspaceId, order.id, item.id, item.name, before.quantity, item.quantity, at, actor);
          }
        }
      }
      finishImport.run(Date.now(), workspaceId, importId);
      return result;
    });
  }

  return {
    close: () => db.close(),
    listOrders(workspaceId, { query = '', limit = 50 } = {}) {
      const filter = typeof query === 'string' ? query.trim().slice(0, 120) : '';
      const size = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
      return list.all(workspaceId, filter, filter, size).map(row => ({ ...row }));
    },
    getOrder,
    saveQuantity,
    previewImport,
    commitImport,
    createAuthSession(workspaceId, user, tokenHash, expiresAt) {
      purgeAuth.run(Date.now());
      insertAuth.run(workspaceId, user, tokenHash, expiresAt);
    },
    getAuthSession(tokenHash) {
      const row = authByToken.get(tokenHash, Date.now());
      return row ? { ...row } : null;
    },
    deleteAuthSession: tokenHash => { deleteAuth.run(tokenHash); },
  };
}

const storeKey = Symbol.for('dispatch-desk.production-store');

export function getStore() {
  return (globalThis[storeKey] ??= createStore());
}

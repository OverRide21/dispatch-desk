import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createClient } from '@libsql/client/web';
import { openLocalSqlite } from './sqlite.mjs';
import { normalizeOrderDetails, orderDetails, stages } from './order-details.mjs';
import { editLockReason, stockUnitFamily } from './order-policies.mjs';
import { createVoiceUsage, setupVoiceUsage } from './voice-usage.mjs';
import { adjustStock, createCatalog, setupCatalog } from './catalog.mjs';
import {
  cancelShipment, dispatchDueShipments, extendShippingHold, holdLockedCall, scheduleShipment, setShippingHold, setupShipping, shippingHoldUntil,
} from './shipping.mjs';

const importLifetime = 30 * 60 * 1000;
const maxQuantity = 1_000_000;
const schemaVersion = 3;
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

function receiptBlocks(requests) {
  if (!Array.isArray(requests)) return [];
  const clean = (value, limit) => typeof value === 'string'
    ? value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, limit) : '';
  return requests.slice(0, 50).flatMap(request => {
    if (!['shipped', 'packed', 'cutoff', 'stock'].includes(request?.reason)) return [];
    return [{
      itemId: clean(request.itemId, 100), name: clean(request.name, 180), reason: request.reason,
      ...(validQuantity(request.requested) ? { requested: request.requested } : {}),
      ...(validQuantity(request.available) ? { available: request.available } : {}),
    }];
  });
}

function itemDetails(item, inferStage = false) {
  return normalizeOrderDetails(item, {
    quantity: item.quantity,
    status: item.status,
    readQuantity: value => validQuantity(value) ? value : null,
    report: (_field, message) => { throw storeError(400, 'invalid-order-details', message); },
    inferStage,
  });
}

function finalizeItem(item) {
  const details = itemDetails(item, true);
  const resolved = { ...item, ...details };
  for (const field of Object.keys(details)) {
    if (details[field] === null) delete resolved[field];
  }
  return resolved;
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
    ...itemDetails(item),
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
    ...(row.details ? JSON.parse(row.details) : {}),
  };
}

function sameLineFields(left, right) {
  return left.name === right.name && left.sku === right.sku && left.unit === right.unit &&
    left.quantity === right.quantity &&
    left.nameHi === right.nameHi && left.nameMr === right.nameMr &&
    JSON.stringify(left.aliases) === JSON.stringify(right.aliases);
}

const stageRank = item => stages.indexOf(item.status === 'shipped' ? 'shipped' : item.fulfillmentStage ?? 'pending');

function checkSubstitutes(items) {
  const bySku = new Map();
  for (const item of items) {
    if (!item.sku) continue;
    const sku = item.sku.toLowerCase();
    const matches = bySku.get(sku) ?? [];
    matches.push(item);
    bySku.set(sku, matches);
  }
  for (const item of items) {
    if (!item.substituteSku) continue;
    const candidates = bySku.get(item.substituteSku.toLowerCase());
    if (candidates?.length !== 1 || candidates[0].id === item.id ||
        stockUnitFamily(candidates[0].unit) !== stockUnitFamily(item.unit)) {
      return `Line ${item.id} needs a distinct substitute SKU on the same order with a matching unit.`;
    }
  }
  return null;
}

function compareOrder(current, incoming) {
  if (!current) {
    const items = incoming.items.map(finalizeItem);
    const message = checkSubstitutes(items);
    return message ? { status: 'conflict', message } : { status: 'created', order: { ...incoming, items } };
  }
  if (current.source === 'storefront') {
    const existing = new Map(current.items.map(item => [item.id, item]));
    const invalid = incoming.items.some(line => {
      const original = existing.get(line.id);
      return !original || !sameLineFields(original, line) ||
        ['availableQuantity', 'backorderAllowed', 'substituteSku', 'backorderQuantity']
          .some(field => line[field] !== undefined && line[field] !== original[field]) ||
        (stageRank(line) >= 2 && original.backorderQuantity > 0);
    });
    if (current.customer !== incoming.customer || invalid) {
      return { status: 'conflict', message: 'Use Dispatch Desk to edit storefront order lines. Imports can advance fulfillment without changing quantities or stock policy.' };
    }
  }
  const byId = new Map(incoming.items.map(item => [item.id, item]));
  let changed = current.customer !== incoming.customer;
  const items = [];
  const now = Date.now();
  for (const existing of current.items) {
    const update = byId.get(existing.id);
    byId.delete(existing.id);
    if (!update) {
      items.push(existing);
      continue;
    }
    const merged = { ...orderDetails(existing), ...update };
    if (update.status === 'shipped' && existing.status !== 'shipped') merged.fulfillmentStage = 'shipped';
    else if (!update.fulfillmentStage && update.packedAt && stageRank(existing) < 2) merged.fulfillmentStage = 'packed';
    else if (!update.fulfillmentStage && update.pickedAt && stageRank(existing) < 1) merged.fulfillmentStage = 'picked';
    let next;
    try {
      next = finalizeItem(merged);
    } catch (error) {
      if (error.code !== 'invalid-order-details') throw error;
      return { status: 'conflict', message: `Line ${existing.id}. ${error.message}` };
    }
    const sameFields = sameLineFields(existing, next);
    const backorderIncreased = (next.backorderQuantity ?? 0) > (existing.backorderQuantity ?? 0);
    const lock = editLockReason(existing, now);
    if (stageRank(next) < stageRank(existing) || (lock && (!sameFields || backorderIncreased))) {
      return { status: 'conflict', message: `Line ${existing.id} cannot be changed or moved back to an earlier fulfillment stage.` };
    }
    changed ||= !sameFields || existing.status !== next.status ||
      JSON.stringify(orderDetails(existing)) !== JSON.stringify(orderDetails(next));
    items.push(next);
  }
  if (byId.size) changed = true;
  items.push(...[...byId.values()].map(finalizeItem));
  const message = checkSubstitutes(items);
  if (message) return { status: 'conflict', message };
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
    CREATE TABLE IF NOT EXISTS order_item_details (
      workspace_id TEXT NOT NULL, order_id TEXT NOT NULL, id TEXT NOT NULL, details TEXT NOT NULL CHECK (json_valid(details)),
      PRIMARY KEY (workspace_id, order_id, id),
      FOREIGN KEY (workspace_id, order_id, id) REFERENCES order_items (workspace_id, order_id, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS order_changes (
      sequence INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, order_id TEXT NOT NULL,
      item_id TEXT NOT NULL, name TEXT NOT NULL, from_quantity INTEGER NOT NULL, to_quantity INTEGER NOT NULL,
      created_at TEXT NOT NULL, actor TEXT NOT NULL,
      FOREIGN KEY (workspace_id, order_id, item_id) REFERENCES order_items (workspace_id, order_id, id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS order_changes_by_order
      ON order_changes (workspace_id, order_id, sequence DESC);
    CREATE TABLE IF NOT EXISTS order_receipts (
      workspace_id TEXT NOT NULL, order_id TEXT NOT NULL, id TEXT NOT NULL,
      revision INTEGER NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)),
      PRIMARY KEY (workspace_id, order_id, id),
      UNIQUE (workspace_id, order_id, revision),
      FOREIGN KEY (workspace_id, order_id) REFERENCES orders (workspace_id, id)
    ) STRICT;
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
    await setupVoiceUsage(db);
    await setupCatalog(db);
    await setupShipping(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const storefrontSource = `EXISTS (SELECT 1 FROM storefront_orders s
    WHERE s.workspace_id = orders.workspace_id AND s.order_id = orders.id) AS storefront`;
  const orderById = `SELECT id, customer, revision, ${storefrontSource} FROM orders WHERE workspace_id = ? AND id = ?`;
  const selectItems = 'SELECT i.*, d.details FROM order_items i LEFT JOIN order_item_details d USING (workspace_id, order_id, id)';
  const itemsByOrder = `
    SELECT i.*, d.details, p.free_stock AS catalog_stock, p.backorder_allowed AS catalog_backorder,
      p.substitute_sku AS catalog_substitute
    FROM order_items i
    LEFT JOIN order_item_details d USING (workspace_id, order_id, id)
    LEFT JOIN storefront_orders s ON s.workspace_id = i.workspace_id AND s.order_id = i.order_id
    LEFT JOIN catalog_products p ON p.workspace_id = s.workspace_id AND p.sku = i.sku
    WHERE i.workspace_id = ? AND i.order_id = ? ORDER BY i.position, i.id
  `;
  const changesByOrder = `
    SELECT item_id AS itemId, name, from_quantity AS "from", to_quantity AS "to", created_at AS at, actor
    FROM order_changes WHERE workspace_id = ? AND order_id = ? ORDER BY sequence DESC LIMIT 100
  `;
  const list = `
    SELECT o.id, o.customer, o.revision,
      EXISTS (SELECT 1 FROM storefront_orders s WHERE s.workspace_id = o.workspace_id AND s.order_id = o.id) AS storefront,
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
  const writeDetails = `
    INSERT INTO order_item_details (workspace_id, order_id, id, details) VALUES (?, ?, ?, ?)
    ON CONFLICT (workspace_id, order_id, id) DO UPDATE SET details = excluded.details
  `;
  const writeReceipt = 'INSERT INTO order_receipts (workspace_id, order_id, id, revision, payload) VALUES (?, ?, ?, ?, ?)';
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

  const catalog = createCatalog(db, transaction, (tx, workspaceId, orderId, customer, lines) => tx.batch([
    statement(writeOrder, workspaceId, orderId, customer, 1),
    ...lines.map(({ product, quantity }, position) => statement(writeItem,
      workspaceId, orderId, product.sku, position, product.name, product.sku, product.unit, quantity,
      'pending', '[]', product.nameHi, product.nameMr)),
  ]));

  async function getOrder(workspaceId, id, client = db) {
    const queries = [
      statement(orderById, workspaceId, id),
      statement(itemsByOrder, workspaceId, id),
      statement(changesByOrder, workspaceId, id),
    ];
    const [order, items, history] = client === db ? await db.batch(queries, 'read') : await client.batch(queries);
    if (!order.rows.length) return null;
    const { storefront, ...header } = order.rows[0];
    const skus = new Set(items.rows.map(row => row.sku));
    return {
      ...header,
      ...(storefront ? { source: 'storefront' } : {}),
      items: items.rows.map(row => {
        const item = rowToItem(row);
        if (row.catalog_stock == null) return item;
        const allocated = item.quantity - (item.backorderQuantity ?? 0);
        return {
          ...item,
          availableQuantity: Math.min(maxQuantity, allocated + row.catalog_stock),
          backorderAllowed: Boolean(row.catalog_backorder),
          ...(skus.has(row.catalog_substitute) ? { substituteSku: row.catalog_substitute } : {}),
        };
      }),
      history: history.rows.map(row => ({ ...row })),
    };
  }

  async function getOrdersForImport(tx, workspaceId, ids) {
    const selection = ' WHERE workspace_id = ? AND ';
    const selected = JSON.stringify(ids);
    const [orders, items] = await tx.batch([
      statement(`SELECT id, customer, revision, ${storefrontSource} FROM orders` + selection + 'id IN (SELECT value FROM json_each(?))', workspaceId, selected),
      statement(selectItems + ' WHERE i.workspace_id = ? AND i.order_id IN (SELECT value FROM json_each(?)) ORDER BY i.position, i.id', workspaceId, selected),
    ]);
    const byId = new Map(orders.rows.map(({ storefront, ...row }) => [
      row.id, { ...row, ...(storefront ? { source: 'storefront' } : {}), items: [] },
    ]));
    for (const row of items.rows) byId.get(row.order_id)?.items.push(rowToItem(row));
    return byId;
  }

  function saveQuantity(workspaceId, orderId, { itemId, quantity, revision, actor, newItem, backorderQuantity, updates, receipt }) {
    const changes = updates ?? [{ itemId, to: quantity, newItem, backorderQuantity }];
    if (!Array.isArray(changes) || (updates && (changes.length !== 2 || newItem || changes.some(change => change?.newItem))) ||
        new Set(changes.map(change => change?.itemId)).size !== changes.length) {
      throw storeError(400, 'invalid-change', 'Review the proposed order changes and try again.');
    }
    if (!changes.every(change => validQuantity(change?.to))) {
      throw storeError(400, 'invalid-quantity', 'Enter a whole quantity between 0 and 1,000,000.');
    }
    return transaction(async tx => {
      const order = await getOrder(workspaceId, orderId, tx);
      if (!order) throw storeError(404, 'order-not-found', 'The order could not be found.');
      if (order.revision !== revision) throw storeError(409, 'order-stale', 'This order changed. Review it before confirming again.');
      const items = new Map(order.items.map(item => [item.id, item]));
      if (updates) {
        const [primary, replacement] = changes;
        const first = items.get(primary.itemId);
        const second = items.get(replacement.itemId);
        if (!first?.substituteSku || !second?.sku ||
            first.substituteSku.toLowerCase() !== second.sku.toLowerCase() ||
            stockUnitFamily(first.unit) !== stockUnitFamily(second.unit) ||
            primary.to !== first.availableQuantity || !validQuantity(second.availableQuantity) ||
            replacement.to <= second.quantity || second.backorderQuantity ||
            (primary.backorderQuantity ?? 0) !== 0 || (replacement.backorderQuantity ?? 0) !== 0) {
          throw storeError(409, 'invalid-substitution', 'The approved substitute or its available quantity changed. Review the order and try again.');
        }
      }
      const now = Date.now();
      const at = new Date(now).toISOString();
      const writes = [];
      const savedChanges = [];
      for (const change of changes) {
        let item = items.get(change.itemId);
        if (change.newItem) {
          let candidate = change.newItem;
          if (order.source === 'storefront') {
            const identifier = normalizeString(candidate.sku || candidate.name, 180, 'catalog item').toLowerCase();
            const products = await catalog.listProducts(workspaceId, tx);
            const skuMatch = products.find(product => product.sku.toLowerCase() === identifier);
            const matches = skuMatch ? [skuMatch] : products.filter(product => [product.name, product.nameHi, product.nameMr]
              .some(value => value.toLowerCase() === identifier));
            if (matches.length !== 1 || typeof candidate.unit !== 'string' ||
                stockUnitFamily(matches[0].unit) !== stockUnitFamily(candidate.unit)) {
              throw storeError(409, 'catalog-item-required', 'Use a catalog SKU and its selling unit to add an item to a storefront order.');
            }
            const { sku, name, nameHi, nameMr, unit, stock } = matches[0];
            candidate = { sku, name, nameHi, nameMr, unit, availableQuantity: Math.min(maxQuantity, stock) };
          }
          const added = finalizeItem(normalizeItem({ ...candidate, id: change.itemId, quantity: 0, status: 'pending' }));
          if (!change.to || item || order.items.some(line =>
            line.name.toLowerCase() === added.name.toLowerCase() ||
            (added.sku && line.sku.toLowerCase() === added.sku.toLowerCase()))) {
            throw storeError(409, 'order-conflict', 'That item already exists or has an invalid quantity. Review the order and try again.');
          }
          item = added;
        }
        if (!item) throw storeError(404, 'line-not-found', 'The order line could not be found.');
        if (change.from !== undefined && change.from !== item.quantity) {
          throw storeError(409, 'order-stale', 'This order changed. Review it before confirming again.');
        }
        const lock = editLockReason(item, now);
        if (lock) {
          const reasons = {
            shipped: 'This line has shipped and its quantity cannot change.',
            packed: 'This line is packed and its quantity cannot change.',
            cutoff: 'The edit cutoff has passed and this line cannot change.',
          };
          throw storeError(409, 'line-' + lock, reasons[lock]);
        }
        const previousBackorder = item.backorderQuantity ?? 0;
        const outstanding = change.backorderQuantity ?? Math.min(previousBackorder, change.to);
        if (!validQuantity(outstanding) || outstanding > change.to ||
            (outstanding > previousBackorder && (!item.backorderAllowed || !validQuantity(item.availableQuantity) ||
              outstanding !== change.to - item.availableQuantity)) ||
            (validQuantity(item.availableQuantity) && change.to - outstanding > item.availableQuantity)) {
          throw storeError(409, 'stock-unavailable', 'There is not enough available stock for this change. Review the order and try again.');
        }
        if (item.quantity === change.to && previousBackorder === outstanding) continue;
        const details = orderDetails(item);
        if (order.source === 'storefront') {
          const delta = (item.quantity - previousBackorder) - (change.to - outstanding);
          await adjustStock(tx, workspaceId, item.sku, delta);
          for (const key of ['availableQuantity', 'backorderAllowed', 'substituteSku']) delete details[key];
        }
        if (previousBackorder !== outstanding) details.backorderQuantity = outstanding;
        writes.push(change.newItem
          ? statement(writeItem, workspaceId, orderId, item.id, order.items.length, item.name, item.sku, item.unit,
            change.to, item.status, JSON.stringify(item.aliases), item.nameHi, item.nameMr)
          : statement(changeQuantity, change.to, workspaceId, orderId, item.id));
        if (Object.keys(details).length) writes.push(statement(writeDetails, workspaceId, orderId, item.id, JSON.stringify(details)));
        if (order.source === 'storefront' && change.to === 0) writes.push(cancelShipment(workspaceId, orderId, item.id));
        if (order.source === 'storefront' && change.to > 0 && item.quantity === 0) {
          writes.push(scheduleShipment(workspaceId, orderId, item.id, now));
        }
        writes.push(statement(insertChange, workspaceId, orderId, item.id, item.name, item.quantity, change.to, at, actor));
        savedChanges.push({
          itemId: item.id, name: item.name, unit: item.unit, from: item.quantity, to: change.to,
          ...(item.nameHi ? { nameHi: item.nameHi } : {}),
          ...(item.nameMr ? { nameMr: item.nameMr } : {}),
          ...(outstanding || previousBackorder ? { backorderQuantity: outstanding } : {}),
        });
      }
      if (!savedChanges.length) return order;
      writes.push(statement(incrementRevision, workspaceId, orderId));
      let savedReceipt;
      if (receipt) {
        savedReceipt = {
          id: randomUUID(), orderId, revision: revision + 1, at, actor,
          language: ['en-IN', 'hi-IN', 'mr-IN'].includes(receipt.language) ? receipt.language : 'en-IN',
          changes: savedChanges, blockedRequests: receiptBlocks(receipt.blockedRequests),
        };
        writes.push(statement(writeReceipt, workspaceId, orderId, savedReceipt.id, savedReceipt.revision, JSON.stringify(savedReceipt)));
      }
      await tx.batch(writes);
      const saved = await getOrder(workspaceId, orderId, tx);
      return savedReceipt ? { ...saved, receipt: savedReceipt } : saved;
    });
  }

  async function getOrderReceipts(workspaceId, orderId, { id, limit = 100 } = {}) {
    const selection = 'SELECT payload FROM order_receipts WHERE workspace_id = ? AND order_id = ?';
    const query = id
      ? statement(selection + ' AND id = ?', workspaceId, orderId, id)
      : statement(selection + ' ORDER BY revision DESC LIMIT ?', workspaceId, orderId,
        Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 100);
    return (await db.execute(query)).rows.map(row => JSON.parse(row.payload));
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
          const details = orderDetails(item);
          const before = previous.get(item.id);
          if (Object.keys(details).length || (before && Object.keys(orderDetails(before)).length)) {
            writes.push(statement(writeDetails, workspaceId, order.id, item.id, JSON.stringify(details)));
          }
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
    const prefix = ['guest', 'shopper'].includes(actor.role) ? `${actor.role}-` : '';
    const call = { id: prefix + randomUUID(), owner: actor.sessionId, workspaceId: actor.workspaceId, state, revision: 0 };
    await db.batch([
      statement('DELETE FROM call_sessions WHERE expires_at <= ?', now),
      statement('INSERT INTO call_sessions (id, owner, workspace_id, state, revision, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        call.id, call.owner, call.workspaceId, JSON.stringify(state), call.revision, now + callLifetime),
    ], 'write');
    return call;
  }

  async function lockCall(id, actor) {
    if (!id) return null;
    const now = Date.now();
    const lock = randomUUID();
    const [result] = await db.batch([
      statement(`UPDATE call_sessions SET lock_token = ?, lock_until = ?, expires_at = ?
        WHERE ${callMatch} AND lock_until <= ? RETURNING ${callFields}`,
      lock, now + lockLifetime, now + callLifetime, id, actor.sessionId, actor.workspaceId, now, now),
      holdLockedCall(id, lock, now),
    ], 'write');
    const call = decodeCall(result.rows[0]);
    return call ? { ...call, lock } : null;
  }

  async function saveCall(call) {
    const now = Date.now();
    const save = statement(`UPDATE call_sessions SET state = ?, revision = ?, expires_at = ?,
      lock_token = NULL, lock_until = 0 WHERE id = ? AND lock_token = ?`,
    JSON.stringify(call.state), call.revision, now + callLifetime, call.id, call.lock);
    const extendHold = call.state.order.source === 'storefront' && (call.state.pending || call.state.stockOffer);
    const result = extendHold
      ? (await db.batch([extendShippingHold(call.id, call.lock, now), save], 'write'))[1]
      : await db.execute(save);
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
    ...catalog,
    dispatchDueShipments: now => dispatchDueShipments(transaction, now),
    setShippingHold: (call, active) => setShippingHold(db, call, active),
    shippingHoldUntil: (workspaceId, orderId) => shippingHoldUntil(db, workspaceId, orderId),
    async listOrders(workspaceId, { query = '', limit = 50 } = {}) {
      const filter = typeof query === 'string' ? query.trim().slice(0, 120) : '';
      const size = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
      return (await db.execute(statement(list, workspaceId, filter, filter, size))).rows.map(({ storefront, ...row }) => ({
        ...row, ...(storefront ? { source: 'storefront' } : {}),
      }));
    },
    getOrder,
    getOrderReceipts,
    saveQuantity,
    voiceUsage: createVoiceUsage(db),
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

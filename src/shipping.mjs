import { randomInt } from 'node:crypto';

const statement = (sql, ...args) => ({ sql, args });
const holdDuration = 60_000;

export function setupShipping(db) {
  return db.batch([
    `CREATE TABLE IF NOT EXISTS storefront_shipments (
      workspace_id TEXT NOT NULL, order_id TEXT NOT NULL, item_id TEXT NOT NULL, due_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, order_id, item_id),
      FOREIGN KEY (workspace_id, order_id, item_id) REFERENCES order_items (workspace_id, order_id, id)
    ) STRICT`,
    'CREATE INDEX IF NOT EXISTS storefront_shipments_due ON storefront_shipments (due_at)',
    `CREATE TABLE IF NOT EXISTS storefront_shipping_holds (
      call_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, order_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
      FOREIGN KEY (call_id) REFERENCES call_sessions (id) ON DELETE CASCADE
    ) STRICT`,
    'CREATE INDEX IF NOT EXISTS storefront_shipping_holds_order ON storefront_shipping_holds (workspace_id, order_id)',
  ], 'write');
}

export function scheduleShipment(workspaceId, orderId, itemId, now) {
  return statement(`INSERT INTO storefront_shipments (workspace_id, order_id, item_id, due_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, order_id, item_id) DO NOTHING`,
  workspaceId, orderId, itemId, now + randomInt(120_000, 300_001));
}

export const cancelShipment = (workspaceId, orderId, itemId) =>
  statement('DELETE FROM storefront_shipments WHERE workspace_id = ? AND order_id = ? AND item_id = ?', workspaceId, orderId, itemId);

export async function setShippingHold(client, call, active, now = Date.now()) {
  if (call.state.order.source !== 'storefront') return;
  await client.execute(statement(`
    INSERT INTO storefront_shipping_holds (call_id, workspace_id, order_id, expires_at)
    SELECT id, workspace_id, ?, ? FROM call_sessions WHERE id = ? AND expires_at > ?
    ON CONFLICT (call_id) DO UPDATE SET expires_at = excluded.expires_at`,
  call.state.order.id, active ? now + holdDuration : 0, call.id, now));
}

export function holdLockedCall(callId, lock, now) {
  return statement(`INSERT INTO storefront_shipping_holds (call_id, workspace_id, order_id, expires_at)
    SELECT id, workspace_id, json_extract(state, '$.order.id'), ? FROM call_sessions
    WHERE id = ? AND lock_token = ? AND json_extract(state, '$.order.source') = 'storefront'
    ON CONFLICT (call_id) DO UPDATE SET expires_at = excluded.expires_at`,
  now + holdDuration, callId, lock);
}

export function extendShippingHold(callId, lock, now) {
  return statement(`UPDATE storefront_shipping_holds SET expires_at = ?
    WHERE call_id = ? AND expires_at > 0 AND EXISTS (
      SELECT 1 FROM call_sessions WHERE id = ? AND lock_token = ?
    )`, now + holdDuration, callId, callId, lock);
}

const orderHolds = `FROM storefront_shipping_holds h JOIN call_sessions c ON c.id = h.call_id
  WHERE h.workspace_id = ? AND h.order_id = ? AND c.expires_at > ?`;

export async function shippingHoldUntil(db, workspaceId, orderId) {
  const now = Date.now();
  const [{ expiresAt }] = (await db.execute(statement(`
    SELECT max(max(h.expires_at, c.lock_until)) AS expiresAt ${orderHolds}`, workspaceId, orderId, now))).rows;
  return expiresAt > now ? expiresAt : null;
}

export function dispatchDueShipments(transaction, now = Date.now()) {
  return transaction(async tx => {
    const { rows } = await tx.execute(statement(`
      SELECT s.workspace_id AS workspaceId, s.order_id AS orderId, s.item_id AS itemId, i.quantity, i.status
      FROM storefront_shipments s
      JOIN order_items i ON i.workspace_id = s.workspace_id AND i.order_id = s.order_id AND i.id = s.item_id
      LEFT JOIN order_item_details d ON d.workspace_id = i.workspace_id AND d.order_id = i.order_id AND d.id = i.id
      WHERE s.due_at <= ? AND (
        i.quantity = 0 OR i.status = 'shipped' OR (
          coalesce(json_extract(d.details, '$.backorderQuantity'), 0) = 0 AND NOT EXISTS (
            SELECT 1 FROM storefront_shipping_holds h JOIN call_sessions c ON c.id = h.call_id
            WHERE h.workspace_id = s.workspace_id AND h.order_id = s.order_id
              AND c.expires_at > ? AND max(h.expires_at, c.lock_until) > ?
          )
        )
      ) ORDER BY s.due_at LIMIT 100`, now, now, now));
    const shippedAt = new Date(now).toISOString();
    const orders = new Map();
    const writes = [];
    let shipped = 0;
    for (const { workspaceId, orderId, itemId, status, quantity } of rows) {
      writes.push(cancelShipment(workspaceId, orderId, itemId));
      if (status === 'shipped' || quantity === 0) continue;
      shipped++;
      orders.set(JSON.stringify([workspaceId, orderId]), [workspaceId, orderId]);
      writes.push(
        statement(`UPDATE order_items SET status = 'shipped' WHERE workspace_id = ? AND order_id = ? AND id = ?`,
          workspaceId, orderId, itemId),
        statement(`INSERT INTO order_item_details (workspace_id, order_id, id, details)
          VALUES (?, ?, ?, json_object('fulfillmentStage', 'shipped', 'shippedAt', ?))
          ON CONFLICT (workspace_id, order_id, id) DO UPDATE SET
          details = json_patch(order_item_details.details, excluded.details)`, workspaceId, orderId, itemId, shippedAt),
      );
    }
    for (const args of orders.values()) {
      writes.push(statement('UPDATE orders SET revision = revision + 1 WHERE workspace_id = ? AND id = ?', ...args));
    }
    if (writes.length) await tx.batch(writes);
    return shipped;
  });
}

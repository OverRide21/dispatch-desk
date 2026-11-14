import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { catalogCategories, defaultCatalogCategory } from './catalog-categories.mjs';
import { stockUnitFamily } from './order-policies.mjs';
import { scheduleShipment } from './shipping.mjs';

export const catalogQuantityLimit = 1_000_000;
const priceLimit = 100_000_000;
const statement = (sql, ...args) => ({ sql, args });
const validRequestId = /^[a-z\d_-]{16,128}$/iu;

function catalogError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function field(value, limit, label, optional = false) {
  if (optional && (value == null || value === '')) return '';
  const result = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  if (!result || result.length > limit || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(result)) {
    throw catalogError(400, 'invalid-catalog-field', `Enter a valid ${label}.`);
  }
  return result;
}

export function catalogSku(value) {
  const sku = field(value, 100, 'SKU').toUpperCase();
  if (!/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}_.-]{0,99}$/u.test(sku)) {
    throw catalogError(400, 'invalid-catalog-field', 'Use letters, digits, dots, underscores, or hyphens in the SKU.');
  }
  return sku;
}

function wholeQuantity(quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > catalogQuantityLimit) {
    throw catalogError(400, 'invalid-stock-quantity', 'Enter a whole quantity from 1 to 1,000,000.');
  }
  return quantity;
}

const productColumns = `sku, name, name_hi AS nameHi, name_mr AS nameMr, unit, category,
  price_paise AS pricePaise, free_stock AS stock, backorder_allowed AS backorderAllowed, substitute_sku AS substituteSku`;

function toProduct(row) {
  return { ...row, backorderAllowed: Boolean(row.backorderAllowed) };
}

export async function setupCatalog(db) {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS catalog_products (
      workspace_id TEXT NOT NULL, sku TEXT NOT NULL, name TEXT NOT NULL,
      name_hi TEXT NOT NULL, name_mr TEXT NOT NULL, unit TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '${defaultCatalogCategory}',
      price_paise INTEGER NOT NULL CHECK (price_paise BETWEEN 0 AND 100000000),
      free_stock INTEGER NOT NULL DEFAULT 0 CHECK (free_stock BETWEEN 0 AND 9007199254740991),
      backorder_allowed INTEGER NOT NULL CHECK (backorder_allowed IN (0,1)),
      substitute_sku TEXT NOT NULL,
      PRIMARY KEY (workspace_id, sku)
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS storefront_orders (
      workspace_id TEXT NOT NULL, order_id TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, response TEXT NOT NULL CHECK (json_valid(response)),
      PRIMARY KEY (workspace_id, order_id), UNIQUE (workspace_id, request_id),
      FOREIGN KEY (workspace_id, order_id) REFERENCES orders (workspace_id, id)
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS catalog_stock_receipts (
      workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, sku TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0), response TEXT NOT NULL CHECK (json_valid(response)),
      PRIMARY KEY (workspace_id, request_id),
      FOREIGN KEY (workspace_id, sku) REFERENCES catalog_products (workspace_id, sku)
    ) STRICT`,
  ], 'write');
  const hasCategory = async client => (await client.execute('PRAGMA table_info(catalog_products)'))
    .rows.some(column => column.name === 'category');
  if (await hasCategory(db)) return;

  const tx = await db.transaction('write');
  try {
    if (!(await hasCategory(tx))) {
      await tx.execute(`ALTER TABLE catalog_products ADD COLUMN category TEXT NOT NULL DEFAULT '${defaultCatalogCategory}'`);
    }
    await tx.commit();
  } finally {
    tx.close();
  }
}

export function createCatalog(db, transaction, writeOrder) {
  async function listProducts(workspaceId, client = db) {
    const result = await client.execute(statement(
      `SELECT ${productColumns} FROM catalog_products WHERE workspace_id = ? ORDER BY name COLLATE NOCASE, sku`, workspaceId));
    return result.rows.map(toProduct);
  }

  async function saveProduct(workspaceId, input) {
    const sku = catalogSku(input?.sku);
    const name = field(input.name, 180, 'product name');
    const nameHi = field(input.nameHi, 180, 'Hindi product name', true);
    const nameMr = field(input.nameMr, 180, 'Marathi product name', true);
    const unit = field(input.unit, 50, 'selling unit');
    const { category, pricePaise, backorderAllowed = false } = input;
    const substituteSku = input.substituteSku == null || input.substituteSku === '' ? '' : catalogSku(input.substituteSku);
    if (!Number.isSafeInteger(pricePaise) || pricePaise < 0 || pricePaise > priceLimit) {
      throw catalogError(400, 'invalid-product-price', 'Enter a product price from ₹0 to ₹10,00,000.');
    }
    if (typeof backorderAllowed !== 'boolean') {
      throw catalogError(400, 'invalid-catalog-field', 'Choose whether this product accepts backorders.');
    }
    if (category !== undefined && !catalogCategories.includes(category)) {
      throw catalogError(400, 'invalid-catalog-field', 'Choose a catalog category.');
    }
    return transaction(async tx => {
      const [existing] = (await tx.execute(statement(
        'SELECT unit, category FROM catalog_products WHERE workspace_id = ? AND sku = ?', workspaceId, sku))).rows;
      if (existing && stockUnitFamily(existing.unit) !== stockUnitFamily(unit)) {
        throw catalogError(409, 'catalog-unit-conflict', 'Use a new SKU to sell this product in a different unit.');
      }
      if (substituteSku) {
        const [substitute] = (await tx.execute(statement(
          'SELECT unit FROM catalog_products WHERE workspace_id = ? AND sku = ?', workspaceId, substituteSku))).rows;
        if (substituteSku === sku || !substitute || stockUnitFamily(substitute.unit) !== stockUnitFamily(unit)) {
          throw catalogError(400, 'invalid-product-substitute', 'Choose a different catalog SKU with the same selling unit.');
        }
      }
      const [saved] = (await tx.execute(statement(`
        INSERT INTO catalog_products
          (workspace_id, sku, name, name_hi, name_mr, unit, category, price_paise, backorder_allowed, substitute_sku)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, sku) DO UPDATE SET name = excluded.name, name_hi = excluded.name_hi,
          name_mr = excluded.name_mr, unit = excluded.unit, category = excluded.category, price_paise = excluded.price_paise,
          backorder_allowed = excluded.backorder_allowed, substitute_sku = excluded.substitute_sku
        RETURNING ${productColumns}
      `, workspaceId, sku, name, nameHi, nameMr, unit, category ?? existing?.category ?? defaultCatalogCategory,
      pricePaise, Number(backorderAllowed), substituteSku))).rows;
      return toProduct(saved);
    });
  }

  async function addStock(workspaceId, value, amount, requestId) {
    const sku = catalogSku(value);
    const quantity = wholeQuantity(amount);
    async function receive(client) {
      const [saved] = (await client.execute(statement(`
        UPDATE catalog_products SET free_stock = free_stock + ? WHERE workspace_id = ? AND sku = ?
        RETURNING ${productColumns}
      `, quantity, workspaceId, sku))).rows;
      if (!saved) throw catalogError(404, 'product-not-found', 'Add the product to the catalog before receiving stock.');
      return toProduct(saved);
    }
    if (requestId == null) return receive(db);
    if (typeof requestId !== 'string' || !validRequestId.test(requestId)) {
      throw catalogError(400, 'invalid-stock-reference', 'Enter a valid stock receipt reference.');
    }
    return transaction(async tx => {
      const [existing] = (await tx.execute(statement(`
        SELECT sku, quantity, response FROM catalog_stock_receipts WHERE workspace_id = ? AND request_id = ?
      `, workspaceId, requestId))).rows;
      if (existing) {
        if (existing.sku !== sku || existing.quantity !== quantity) {
          throw catalogError(409, 'stock-adjustment-conflict', 'This stock receipt reference has already been used.');
        }
        return JSON.parse(existing.response);
      }
      const result = await receive(tx);
      await tx.execute(statement(`
        INSERT INTO catalog_stock_receipts (workspace_id, request_id, sku, quantity, response) VALUES (?, ?, ?, ?, ?)
      `, workspaceId, requestId, sku, quantity, JSON.stringify(result)));
      return result;
    });
  }

  async function placeShopOrder(workspaceId, input) {
    const customer = field(input?.customer, 180, 'customer or shop name');
    const requestId = field(input?.requestId, 128, 'checkout reference');
    if (!validRequestId.test(requestId) || !Array.isArray(input.items) ||
        input.items.length < 1 || input.items.length > 50) {
      throw catalogError(400, 'invalid-cart', 'Choose between 1 and 50 products to place an order.');
    }
    const items = input.items.map(item => ({ sku: catalogSku(item?.sku), quantity: wholeQuantity(item?.quantity) }))
      .sort((left, right) => left.sku < right.sku ? -1 : left.sku > right.sku ? 1 : 0);
    if (new Set(items.map(item => item.sku)).size !== items.length) {
      throw catalogError(400, 'invalid-cart', 'Combine matching products into one cart line.');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ customer, items })).digest('hex');
    return transaction(async tx => {
      const [existing] = (await tx.execute(statement(
        'SELECT fingerprint, response FROM storefront_orders WHERE workspace_id = ? AND request_id = ?', workspaceId, requestId))).rows;
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw catalogError(409, 'checkout-conflict', 'This checkout reference has already been used for another order.');
        }
        const placed = JSON.parse(existing.response);
        if (!placed.accessKey) {
          placed.accessKey = randomBytes(32).toString('base64url');
          await tx.execute(statement('UPDATE storefront_orders SET response = ? WHERE workspace_id = ? AND request_id = ?',
            JSON.stringify(placed), workspaceId, requestId));
        }
        return placed;
      }
      const products = new Map((await listProducts(workspaceId, tx)).map(product => [product.sku, product]));
      const lines = items.map(({ sku, quantity }) => {
        const product = products.get(sku);
        if (!product || product.stock < quantity) {
          throw catalogError(409, 'stock-unavailable', product
            ? `Only ${product.stock} ${product.unit} of ${product.name} are available. Refresh the cart and try again.`
            : 'A product is no longer in the catalog. Refresh the cart and try again.');
        }
        return { product, quantity };
      });
      const orderId = 'SHOP-' + randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
      const responseItems = lines.map(({ product: { sku, name, unit, pricePaise }, quantity }) => ({ sku, name, unit, pricePaise, quantity }));
      const totalPaise = responseItems.reduce((total, item) => total + item.quantity * item.pricePaise, 0);
      if (!Number.isSafeInteger(totalPaise)) {
        throw catalogError(400, 'invalid-cart-total', 'The cart total exceeds the supported amount.');
      }
      const response = { orderId, customer, items: responseItems, totalPaise, accessKey: randomBytes(32).toString('base64url') };
      const cartSkus = new Set(items.map(item => item.sku));
      const alternates = new Set(lines.map(({ product }) => product.substituteSku).filter(sku => sku && !cartSkus.has(sku)));
      const orderLines = [...lines, ...[...alternates].map(sku => ({ product: products.get(sku), quantity: 0 }))];
      for (const { product, quantity } of lines) await adjustStock(tx, workspaceId, product.sku, -quantity);
      await writeOrder(tx, workspaceId, orderId, customer, orderLines);
      await tx.execute(statement(`
        INSERT INTO storefront_orders (workspace_id, order_id, request_id, fingerprint, response) VALUES (?, ?, ?, ?, ?)
      `, workspaceId, orderId, requestId, fingerprint, JSON.stringify(response)));
      const orderedAt = Date.now();
      await tx.batch(lines.map(({ product }) => scheduleShipment(workspaceId, orderId, product.sku, orderedAt)));
      return response;
    });
  }

  async function canAccessShopOrder(workspaceId, orderId, accessKey) {
    if (typeof orderId !== 'string' || !/^SHOP-[A-F0-9]{16}$/u.test(orderId) ||
      typeof accessKey !== 'string' || !/^[\w-]{43}$/u.test(accessKey)) return false;
    const { rows } = await db.execute(statement(`SELECT 1 FROM storefront_orders
      WHERE workspace_id = ? AND order_id = ? AND json_extract(response, '$.accessKey') = ?`, workspaceId, orderId, accessKey));
    return rows.length > 0;
  }

  return { listProducts, saveProduct, addStock, placeShopOrder, canAccessShopOrder };
}

export async function adjustStock(client, workspaceId, sku, delta) {
  if (!delta) return;
  const { rows } = await client.execute(statement(`
    UPDATE catalog_products SET free_stock = free_stock + ?
    WHERE workspace_id = ? AND sku = ? AND free_stock + ? >= 0
    RETURNING free_stock
  `, delta, workspaceId, sku, delta));
  if (!rows.length) {
    throw catalogError(409, 'stock-unavailable', 'Available stock changed. Review the order and try again.');
  }
}

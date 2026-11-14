'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { catalogCategories, defaultCatalogCategory } from '../../src/catalog-categories.mjs';
import { jsonRequest, saveStoreOrder, workspaceRequest } from '../components/workspace-api.js';
import styles from './shop.module.css';

const cartKey = 'dispatch-shop-cart';
const pendingKey = 'dispatch-shop-pending';
const orderKey = 'dispatch-shop-order';
const maxQuantity = 1_000_000;
const maxCartLines = 50;
const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 });
const rupees = paise => currency.format(paise / 100);
const packshots = new Map([
  ['KM-RICE', 'rice'], ['KM-ATTA', 'atta'], ['KM-DAL', 'dal'], ['KM-SUGAR', 'sugar'],
  ['KM-OIL', 'oil'], ['KM-CHAI', 'chai'], ['KM-CHIPS', 'chips'], ['KM-SOAP', 'soap'],
]);

function readStorage(key, fallback) {
  try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function writeStorage(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* The shop also works with storage disabled. */ }
}

async function checkoutSignature(payload) {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function BagIcon({ size = 22 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 8h14l1.5 12h-17L5 8Zm4 2V6a3 3 0 0 1 6 0v4" />
  </svg>;
}

function ShopHeader({ itemCount, showCart }) {
  return (
    <header className={styles.header}>
      <Link href="/shop" className="wordmark"><span className={styles.mark}><BagIcon /></span>Kirana Market</Link>
      <div className={styles.headerLinks}>
        <Link className={styles.deskLink} href="/">Dispatch Desk</Link>
        {showCart && <a href="#shop-cart" className={styles.cartShortcut}><BagIcon size={18} /> Cart <span>{itemCount}</span></a>}
      </div>
    </header>
  );
}

function ProductCard({ product, count, disabled, eager, onAdd }) {
  const image = packshots.get(product.sku);
  const unavailable = product.stock <= 0;
  const atLimit = count >= Math.min(product.stock, maxQuantity);
  return (
    <li className={styles.product}>
      <div className={styles.productImage}>
        {image ? <Image src={`/shop/products/${image}.webp`} alt="" width={340} height={340}
          loading={eager ? 'eager' : 'lazy'} unoptimized /> : <BagIcon size={46} />}
      </div>
      <div className={styles.productInfo}>
        <span className={styles.productCategory}>{product.category ?? defaultCatalogCategory}</span>
        <h3>{product.name}</h3>
        <span className={unavailable ? styles.unavailable : styles.meta}>
          {unavailable ? 'Out of stock' : `${product.stock} in stock`}
        </span>
        <div className={styles.productPrice}>
          <strong>{rupees(product.pricePaise)}</strong>
          <button type="button" className={styles.add} aria-label={`Add ${product.name} to cart`}
            onClick={() => onAdd(product)} disabled={disabled || unavailable || atLimit}>
            {unavailable ? 'Sold out' : atLimit ? 'All in cart' : count > 0 ? `Add · ${count}` : 'Add'}
          </button>
        </div>
      </div>
    </li>
  );
}

export default function Shop() {
  const [catalog, setCatalog] = useState({ products: null, error: null });
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [cart, setCart] = useState([]);
  const [hydrated, setHydrated] = useState(false);
  const [customer, setCustomer] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const [orderId, setOrderId] = useState('');
  const [retryPending, setRetryPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const submitting = useRef(false);
  const pending = useRef(null);
  const successHeading = useRef(null);

  useEffect(() => {
    const savedCart = readStorage(cartKey, []);
    if (Array.isArray(savedCart)) {
      const validLines = savedCart.filter(line => typeof line?.sku === 'string' &&
        typeof line.quantity === 'string' && /^\d{0,7}$/u.test(line.quantity));
      setCart([...new Map(validLines.map(line => [line.sku, line])).values()].slice(0, maxCartLines));
    }
    pending.current = readStorage(pendingKey, null);
    setRetryPending(Boolean(pending.current?.id && pending.current.signature));
    const savedOrder = readStorage(orderKey, '');
    if (typeof savedOrder === 'string') setOrderId(savedOrder);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) writeStorage(cartKey, cart);
  }, [cart, hydrated]);

  useEffect(() => {
    const controller = new AbortController();
    workspaceRequest('/api/shop', { signal: controller.signal })
      .then(({ products }) => {
        if (!controller.signal.aborted) setCatalog({ products, error: null });
      })
      .catch(error => {
        if (!controller.signal.aborted) setCatalog({ products: null, error });
      });
    return () => controller.abort();
  }, [catalogAttempt]);

  useEffect(() => {
    if (orderId) successHeading.current?.focus();
  }, [orderId]);

  const products = catalog.products ?? [];
  const productsBySku = new Map(products.map(product => [product.sku, product]));
  const query = search.trim().normalize('NFC').toLowerCase();
  const categories = new Set(products.map(product => product.category ?? defaultCatalogCategory));
  const shownProducts = products.filter(product =>
    (!category || (product.category ?? defaultCatalogCategory) === category) &&
    [product.name, product.nameHi, product.nameMr, product.sku].some(value => value?.toLowerCase().includes(query)));
  const cartRows = cart.map(line => {
    const product = productsBySku.get(line.sku);
    const quantity = Number(line.quantity);
    const maximum = Math.min(product?.stock ?? 0, maxQuantity);
    return { ...line, product, maximum, valid: Number.isInteger(quantity) && quantity > 0 && quantity <= maximum };
  });
  const hasValidStock = cartRows.every(row => row.valid);
  const itemCount = cartRows.reduce((sum, row) => sum + Number(row.quantity), 0);
  const hasOrderQuantities = cartRows.every(row => Number(row.quantity) > 0 && Number(row.quantity) <= maxQuantity);
  const total = hasValidStock ? cartRows.reduce((sum, row) => sum + row.product.pricePaise * Number(row.quantity), 0) : null;
  const canPlace = Boolean(catalog.products && cartRows.length && hasOrderQuantities && customer.trim() &&
    (hasValidStock || retryPending));

  function refreshCatalog() {
    setCatalog({ products: null, error: null });
    setCatalogAttempt(attempt => attempt + 1);
  }

  function setQuantity(sku, quantity) {
    if (!/^\d{0,7}$/u.test(quantity)) return;
    setCart(lines => lines.some(line => line.sku === sku)
      ? lines.map(line => line.sku === sku ? { sku, quantity } : line)
      : [...lines, { sku, quantity }]);
    setFailure('');
  }

  function add(product) {
    if (cart.length >= maxCartLines && !cart.some(line => line.sku === product.sku)) {
      setNotice('The cart can hold up to 50 different products.');
      return;
    }
    const current = Number(cart.find(line => line.sku === product.sku)?.quantity ?? 0);
    if (current >= Math.min(product.stock, maxQuantity)) return;
    setQuantity(product.sku, String(current + 1));
    setNotice(`${product.name} added to the cart. Cart quantity ${current + 1}.`);
  }

  function remove(row) {
    setCart(lines => lines.filter(line => line.sku !== row.sku));
    setFailure('');
    setNotice(`${row.product?.name ?? row.sku} removed from the cart.`);
  }

  function clearPending() {
    writeStorage(pendingKey, null);
    pending.current = null;
    setRetryPending(false);
  }

  async function placeOrder(event) {
    event.preventDefault();
    if (submitting.current || !canPlace) return;
    submitting.current = true;
    setSaving(true);
    setFailure('');
    const payload = {
      customer: customer.trim().normalize('NFC'),
      items: cartRows.map(row => ({ sku: row.sku, quantity: Number(row.quantity) }))
        .sort((left, right) => left.sku.localeCompare(right.sku)),
    };
    try {
      const signature = await checkoutSignature(payload);
      const isRetry = pending.current?.signature === signature && typeof pending.current.id === 'string';
      if (!isRetry && !hasValidStock) {
        setFailure('To retry an unconfirmed checkout, use the same customer name and quantities. Check stock before placing a different order.');
        return;
      }
      if (!isRetry) {
        pending.current = { signature, id: crypto.randomUUID() };
        writeStorage(pendingKey, pending.current);
      }
      setRetryPending(true);
      const placed = await workspaceRequest('/api/shop', jsonRequest('POST', { ...payload, requestId: pending.current.id }));
      if (typeof placed.orderId !== 'string' || !placed.orderId) throw new Error('Missing order reference');
      try { saveStoreOrder(placed); } catch { /* Checkout can still display the order reference. */ }
      writeStorage(orderKey, placed.orderId);
      writeStorage(cartKey, []);
      clearPending();
      setCart([]);
      setOrderId(placed.orderId);
      setCustomer('');
      refreshCatalog();
    } catch (error) {
      if (error.status === 409) refreshCatalog();
      if (error.status && error.status < 500 && ![408, 429].includes(error.status)) clearPending();
      setFailure(error.status && error.status < 500 ? error.message
        : 'The shop could not confirm the order. Retry with the same customer name and items.');
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  async function copyReference() {
    try {
      await navigator.clipboard.writeText(orderId);
      setCopyStatus('Order reference copied.');
    } catch { setCopyStatus('Select the order reference above to copy it.'); }
  }

  function startOrder() {
    writeStorage(orderKey, null);
    setOrderId('');
    setCopyStatus('');
  }

  return (
    <div className={styles.storefront}>
      <a className="skip-link" href="#main">Skip to main content</a>
      <ShopHeader itemCount={itemCount} showCart={!orderId && catalog.error?.code !== 'shop-disabled'} />
      <main id="main">
        {!orderId && catalog.error?.code !== 'shop-disabled' && <div className={styles.hero}>
          <div>
            <h1>Everyday groceries</h1>
            <p>Stock up on pantry staples, tea, snacks and household essentials.</p>
          </div>
          <label className={styles.search}>
            <span className="sr-only">Search groceries</span>
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 5 5" />
            </svg>
            <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search rice, tea, साखर…" />
          </label>
        </div>}
        {orderId ? (
          <section className={styles.success} aria-labelledby="shop-success">
            <h2 id="shop-success" ref={successHeading} tabIndex={-1}>Order placed</h2>
            <p className={styles.reference}>{orderId}</p>
            <p>Open this order in Dispatch Desk from the same browser tab.</p>
            <div className={styles.successActions}>
              <Link className="action action-primary" href={`/workspace?orderId=${encodeURIComponent(orderId)}`}>Open in Dispatch Desk</Link>
              <button type="button" className="action action-secondary" onClick={copyReference}>Copy reference</button>
              <button type="button" className={styles.textButton} onClick={startOrder}>Start another order</button>
            </div>
            <span className={styles.feedback} role="status">{copyStatus}</span>
          </section>
        ) : catalog.error?.code === 'shop-disabled' ? (
          <section className={styles.unavailableShop} aria-labelledby="shop-unavailable">
            <h2 id="shop-unavailable">Shop unavailable</h2>
            <p className={styles.empty}>{catalog.error.message}</p>
            <Link className="action action-secondary" href="/">Open Dispatch Desk</Link>
          </section>
        ) : (
          <div className={styles.layout}>
            <section className={styles.catalog} aria-labelledby="shop-products">
              <div className={styles.catalogHeader}>
                <h2 id="shop-products">Shop by category</h2>
                {products.length > 0 && <span className={styles.meta} role="status">
                  {shownProducts.length} {shownProducts.length === 1 ? 'product' : 'products'}
                </span>}
              </div>
              {products.length > 0 && <div className={styles.categories} role="group" aria-label="Product categories">
                {['', ...catalogCategories.filter(value => categories.has(value) || value === category)].map(value => (
                  <button type="button" key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>
                    {value || 'All groceries'}
                  </button>
                ))}
              </div>}
              {catalog.error ? <>
                <p className="error-note" role="alert">{catalog.error.message}</p>
                <button type="button" className="action action-secondary" onClick={refreshCatalog}>Retry catalog</button>
              </> : !catalog.products ? <p className={styles.empty} role="status">Loading products…</p>
                : !products.length ? <p className={styles.empty}>The catalog is empty. Products appear here after a Dispatch Desk administrator adds them.</p>
                : !shownProducts.length ? <div className={styles.noMatches}>
                  <p className={styles.empty}>No groceries match these filters.</p>
                  <button type="button" className={styles.textButton} onClick={() => { setSearch(''); setCategory(''); }}>Clear filters</button>
                </div>
                : <ul className={styles.products}>{shownProducts.map((product, index) => <ProductCard key={product.sku}
                  product={product} count={Number(cart.find(line => line.sku === product.sku)?.quantity ?? 0)}
                  disabled={saving || !hydrated} eager={index < 4} onAdd={add} />)}</ul>}
            </section>

            <section className={styles.cart} aria-labelledby="shop-cart">
              <div className={styles.cartHeader}>
                <h2 id="shop-cart" tabIndex={-1}>Your cart</h2>
                <span>{itemCount} {itemCount === 1 ? 'item' : 'items'}</span>
              </div>
              {cartRows.length === 0 ? <div className={styles.emptyCart}><BagIcon size={28} />
                <p>Your cart is empty</p><span>Add groceries to get started.</span>
              </div>
                : <ul className={styles.cartRows}>{cartRows.map(row => (
                  <li key={row.sku}>
                    <div className={styles.lineName}>
                      <strong>{row.product?.name ?? row.sku}</strong>
                      <button type="button" className={styles.textButton} disabled={saving} onClick={() => remove(row)}
                        aria-label={`Remove ${row.product?.name ?? row.sku} from cart`}>Remove</button>
                    </div>
                    <div className={styles.lineAmount}>
                      <label>
                        <span className="sr-only">Quantity of {row.product?.name ?? row.sku}</span>
                        <input type="number" inputMode="numeric" step="1" min="1" max={row.maximum}
                          value={row.quantity} onChange={event => setQuantity(row.sku, event.target.value)}
                          disabled={saving || row.maximum === 0} aria-invalid={Boolean(catalog.products && !row.valid)} />
                      </label>
                      <span className={styles.meta}>{row.product?.unit}</span>
                      <strong>{row.product ? rupees(row.product.pricePaise * Number(row.quantity)) : '—'}</strong>
                    </div>
                    {catalog.products && !row.valid && <p className={styles.lineError}>
                      {row.maximum ? `Choose a quantity from 1 to ${row.maximum}.` : 'This product is unavailable. Remove it to continue.'}
                    </p>}
                  </li>
                ))}</ul>}
              <div className={styles.cartTotal}><span>Order total</span><strong>{total === null ? '—' : rupees(total)}</strong></div>
              <form className={styles.checkout} onSubmit={placeOrder}>
                <label>Your name
                  <input type="text" autoComplete="name" value={customer} maxLength={180} required disabled={saving || !cartRows.length}
                    onChange={event => { setCustomer(event.target.value); setFailure(''); }} />
                </label>
                {retryPending && !failure && <p className={styles.empty}>Use the same customer name and quantities to retry an unconfirmed order.</p>}
                {failure && <p className="error-note" role="alert">{failure}</p>}
                <button type="submit" className="action action-primary" disabled={!canPlace || saving}>
                  {saving ? 'Placing order…' : retryPending && !hasValidStock ? 'Retry order' : 'Place order'}
                </button>
              </form>
            </section>
          </div>
        )}
        <p className="sr-only" role="status">{notice}</p>
      </main>
    </div>
  );
}

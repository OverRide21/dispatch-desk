'use client';

import { useEffect, useRef, useState } from 'react';
import { catalogCategories, defaultCatalogCategory } from '../../src/catalog-categories.mjs';
import { jsonRequest, workspaceRequest } from './workspace-api.js';
import styles from './catalog.module.css';

const catalogPath = '/api/catalog';
const units = ['bags', 'boxes', 'kg', 'litres', 'pieces', 'bottles', 'packets'];
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

function parsePrice(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/u.test(text)) throw new Error('Enter a price with up to two decimal places.');
  const [rupees, paise = ''] = text.split('.');
  const amount = Number(rupees) * 100 + Number(paise.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) throw new Error('Enter a smaller price.');
  return amount;
}

function ProductForm({ product, products, busy, onCancel, onSave }) {
  const [unit, setUnit] = useState(product?.unit ?? 'bags');

  function submit(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    onSave(fields, unit);
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <h3>{product ? `Edit ${product.name}` : 'Add a product'}</h3>
      <div className={styles.fields}>
        <label>SKU<input name="sku" defaultValue={product?.sku} required maxLength={100} readOnly={Boolean(product)} disabled={busy} /></label>
        <label>Product name<input name="name" defaultValue={product?.name} required maxLength={180} disabled={busy} /></label>
        <label>Hindi name<input name="nameHi" defaultValue={product?.nameHi} maxLength={180} disabled={busy} /></label>
        <label>Marathi name<input name="nameMr" defaultValue={product?.nameMr} maxLength={180} disabled={busy} /></label>
        <label>Category<select name="category" defaultValue={product?.category ?? defaultCatalogCategory} disabled={busy}>
          {catalogCategories.map(category => <option key={category}>{category}</option>)}
        </select></label>
        <label>Unit<select value={unit} onChange={event => setUnit(event.target.value)} disabled={busy}>
          {[...new Set([...units, unit])].map(value => <option key={value}>{value}</option>)}
        </select></label>
        <label>Price per unit (₹)<input name="price" type="number" min="0" step="0.01" required inputMode="decimal"
          defaultValue={product ? (product.pricePaise / 100).toFixed(2) : undefined} disabled={busy} /></label>
        <label>Approved substitute<select key={unit} name="substituteSku" disabled={busy}
          defaultValue={unit === product?.unit ? product.substituteSku ?? '' : ''}>
          <option value="">No substitute</option>
          {products.filter(candidate => candidate.sku !== product?.sku && candidate.unit === unit)
            .map(candidate => <option key={candidate.sku} value={candidate.sku}>{candidate.name} · {candidate.sku}</option>)}
        </select></label>
        <label className={styles.checkbox}><input name="backorderAllowed" type="checkbox" defaultChecked={product?.backorderAllowed}
          disabled={busy} /> Allow backorders in Dispatch Desk</label>
      </div>
      <div className={styles.actions}>
        <button className="action action-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save product'}</button>
        <button className="action action-secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

export default function Catalog({ onUnauthorized }) {
  const [products, setProducts] = useState(null);
  const [editing, setEditing] = useState(null);
  const [stockSku, setStockSku] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const restock = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    workspaceRequest(catalogPath, { signal: controller.signal })
      .then(({ products }) => { if (!controller.signal.aborted) setProducts(products); })
      .catch(failure => {
        if (controller.signal.aborted) return;
        if (failure.status === 401) onUnauthorized();
        else setError(failure.message);
      });
    return () => controller.abort();
  }, [attempt, onUnauthorized]);

  async function updateProduct(method, payload, message) {
    if (busy) return false;
    setBusy(method);
    setError('');
    setNotice('');
    try {
      const { product } = await workspaceRequest(catalogPath, jsonRequest(method, payload));
      setProducts(current => [...current.filter(item => item.sku !== product.sku), product]
        .sort((left, right) => left.name.localeCompare(right.name) || left.sku.localeCompare(right.sku)));
      setNotice(message(product));
      return true;
    } catch (failure) {
      if (failure.status === 401) onUnauthorized();
      else setError(failure.message);
      return false;
    } finally {
      setBusy('');
    }
  }

  async function saveProduct(fields, unit) {
    const value = name => String(fields.get(name) ?? '').trim();
    let pricePaise;
    try {
      pricePaise = parsePrice(value('price'));
    } catch (error) {
      setError(error.message);
      return;
    }
    const saved = await updateProduct('PUT', {
      sku: value('sku'), name: value('name'), nameHi: value('nameHi'), nameMr: value('nameMr'), unit, pricePaise,
      category: value('category'), substituteSku: value('substituteSku'), backorderAllowed: fields.has('backorderAllowed'),
    }, product => `${product.name} saved.`);
    if (saved) setEditing(null);
  }

  async function addStock(event, sku) {
    event.preventDefault();
    if (busy) return;
    const quantity = Number(new FormData(event.currentTarget).get('quantity'));
    if (restock.current?.sku !== sku || restock.current.quantity !== quantity) {
      restock.current = { sku, quantity, requestId: crypto.randomUUID() };
    }
    const saved = await updateProduct('PATCH', restock.current,
      product => `Added ${quantity} ${product.unit} of ${product.name}. ${product.stock} available.`);
    if (saved) {
      restock.current = null;
      setStockSku(null);
    }
  }

  return (
    <section className={`workspace-panel ${styles.catalog}`} aria-labelledby="catalog-title">
      <div className={styles.heading}>
        <div><h2 id="catalog-title">Catalog and stock</h2><p>Set up products for the storefront and add the quantities available to sell.</p></div>
        {products && <button className="action action-primary" type="button" disabled={Boolean(busy)} onClick={() => {
          setEditing({}); setStockSku(null); setError(''); setNotice('');
        }}>Add product</button>}
      </div>
      {notice && <p className="workspace-notice" role="status">{notice}</p>}
      {error && <p className="error-note" role="alert">{error}</p>}
      {!products && (error
        ? <button className="action action-secondary" type="button" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Retry catalog</button>
        : <p role="status">Loading catalog…</p>)}
      {editing && <ProductForm key={editing.sku ?? 'new'} product={editing.sku ? editing : null} products={products}
        busy={Boolean(busy)} onCancel={() => setEditing(null)} onSave={saveProduct} />}
      {products?.length === 0 && !editing && <p className={styles.note}>Add a product first, then use Add stock to put it on sale.</p>}
      {products?.length > 0 && <ul className={styles.products}>
        {products.map(product => <li key={product.sku}>
          <div className={styles.product}>
            <div><strong>{product.name}</strong><span>{product.category} · {product.sku} · {money.format(product.pricePaise / 100)} per {product.unit}</span></div>
            <strong className={styles.stock}>{product.stock} available</strong>
            <div className={styles.actions}>
              <button className="action action-secondary" type="button" aria-label={`Edit ${product.name}`} disabled={Boolean(busy)}
                onClick={() => { setEditing(product); setStockSku(null); setError(''); setNotice(''); }}>Edit</button>
              <button className="action action-secondary" type="button" aria-label={`Add stock for ${product.name}`}
                aria-expanded={stockSku === product.sku} disabled={Boolean(busy)} onClick={() => {
                  setStockSku(stockSku === product.sku ? null : product.sku); setEditing(null); setError(''); setNotice('');
                }}>Add stock</button>
            </div>
          </div>
          {stockSku === product.sku && <form className={styles.addStock} onSubmit={event => addStock(event, product.sku)}>
            <label>Quantity to add<input name="quantity" type="number" inputMode="numeric" min="1" max="1000000" step="1" required disabled={Boolean(busy)} /></label>
            <button className="action action-primary" type="submit" disabled={Boolean(busy)}>{busy ? 'Adding…' : 'Confirm stock addition'}</button>
          </form>}
        </li>)}
      </ul>}
    </section>
  );
}

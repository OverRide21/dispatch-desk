'use client';

import { useEffect, useState } from 'react';
import { workspaceRequest } from './workspace-api.js';
import styles from './order-extras.module.css';

const stages = { pending: 'Awaiting pick', picked: 'Picked', packed: 'Packed', shipped: 'Shipped' };
const milestoneFields = [
  ['pickedAt', 'Picked'], ['packedAt', 'Packed'], ['shippedAt', 'Shipped'],
  ['editCutoffAt', 'Edit cutoff'], ['deliveryEta', 'Estimated delivery'],
];
const dateFormat = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function Timestamp({ value }) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return <time dateTime={date.toISOString()}>{dateFormat.format(date)}</time>;
}

export function ShipmentTimeline({ items }) {
  if (!items.length) return null;
  return (
    <details className={styles.section}>
      <summary>Shipment timeline</summary>
      <ul className={styles.lines}>
        {items.map(item => {
          const milestones = milestoneFields.filter(([field]) => item[field]);
          return <li key={item.id}>
            <div className={styles.lineHead}><strong>{item.name}</strong>
              <span>{stages[item.status === 'shipped' ? 'shipped' : item.fulfillmentStage] ?? stages.pending}</span></div>
            {milestones.length ? <dl className={styles.milestones}>
              {milestones.map(([field, label]) => <div key={field}><dt>{label}</dt><dd><Timestamp value={item[field]} /></dd></div>)}
            </dl> : <p className={styles.note}>No milestone times recorded.</p>}
          </li>;
        })}
      </ul>
    </details>
  );
}

export function StockOptions({ offer, disabled, onChoose, language }) {
  return (
    <section className={styles.stock} aria-labelledby="stock-options-title">
      <h3 id="stock-options-title">Stock options for {offer.name}</h3>
      <p><strong>{offer.requested}</strong> requested · <strong>{offer.available}</strong> available {offer.unit}</p>
      {offer.options.length > 0 && <div className={styles.options} lang={language}>
        {offer.options.map(option => <button key={option.type} type="button" className="action action-secondary"
          disabled={disabled} onClick={() => onChoose(option)}>{option.label}</button>)}
      </div>}
    </section>
  );
}

function receiptLink(orderId, receiptId, language) {
  const params = new URLSearchParams({ orderId, receiptId });
  if (language) params.set('language', language);
  return '/api/orders/receipts?' + params;
}

export function ReceiptHistory({ orderId, revision, receipt, onUnauthorized }) {
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [language, setLanguage] = useState('');

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    workspaceRequest('/api/orders/receipts?' + new URLSearchParams({ orderId }), { signal: controller.signal })
      .then(({ receipts }) => { if (!controller.signal.aborted) setResult({ revision, attempt, receipts }); })
      .catch(error => {
        if (controller.signal.aborted) return;
        if (error.status === 401) onUnauthorized();
        else setResult({ revision, attempt, error: error.message });
      });
    return () => controller.abort();
  }, [expanded, orderId, revision, attempt, onUnauthorized]);

  const current = result && result.revision === revision && result.attempt === attempt ? result : null;
  return (
    <div className={styles.section}>
      {receipt && <a className={styles.newReceipt} href={receiptLink(orderId, receipt.id, '')} target="_blank" rel="noopener">
        Open latest change receipt
      </a>}
      <details onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary>Change receipts</summary>
        {expanded && (!current ? <p className={styles.note} role="status">Loading receipts…</p>
          : current.error ? <p className={styles.note} role="alert">{current.error}{' '}
            <button type="button" className="action action-secondary" onClick={() => setAttempt(value => value + 1)}>Try again</button>
          </p> : current.receipts.length === 0 ? <p className={styles.note}>Receipts appear after you confirm a change.</p>
            : <>
              <label className={styles.receiptLanguage}>Print in
                <select value={language} onChange={event => setLanguage(event.target.value)}>
                  <option value="">Use receipt language</option>
                  <option value="mr-IN">English + मराठी</option>
                  <option value="hi-IN">English + हिन्दी</option>
                </select>
              </label>
              <ul className={styles.lines}>
                {current.receipts.map(entry => <li className={styles.lineHead} key={entry.id}>
                  <span><Timestamp value={entry.at} /> · {entry.changes.length} {entry.changes.length === 1 ? 'line' : 'lines'}</span>
                  <a href={receiptLink(orderId, entry.id, language)} target="_blank" rel="noopener">Open receipt</a>
                </li>)}
              </ul>
            </>)}
      </details>
    </div>
  );
}

'use client';

import { useId, useState } from 'react';
import { jsonRequest, workspaceRequest } from './workspace-api.js';

const columns = [
  ['orderId', 'Order reference', true],
  ['customer', 'Customer reference', true],
  ['lineId', 'Line ID', true],
  ['name', 'Item name', false],
  ['sku', 'SKU', false],
  ['quantity', 'Quantity', true],
  ['unit', 'Unit', true],
  ['status', 'Dispatch status', true],
  ['aliases', 'Spoken aliases', false],
  ['nameHi', 'Hindi item name', false],
  ['nameMr', 'Marathi item name', false],
];

const formatNames = { csv: 'CSV', xlsx: 'Excel', json: 'JSON' };

function uploadRequest(phase, file, { sheet, mapping } = {}) {
  const query = new URLSearchParams({ phase });
  const headers = { 'X-Filename': encodeURIComponent(file.name) };
  if (sheet) query.set('sheet', sheet);
  if (mapping) headers['X-Column-Mapping'] = encodeURIComponent(JSON.stringify(mapping));
  return workspaceRequest('/api/imports?' + query, { method: 'POST', headers, body: file });
}

function ImportPreview({ report }) {
  const errors = report.errors ?? [];
  const counts = report.counts ?? {};
  const changes = report.changes ?? [];
  return (
    <section className="import-preview" aria-labelledby="import-preview-title">
      <h3 id="import-preview-title">Review import</h3>
      <dl className="import-counts">
        <div><dt>New</dt><dd>{counts.created ?? 0}</dd></div>
        <div><dt>Updated</dt><dd>{counts.updated ?? 0}</dd></div>
        <div><dt>Unchanged</dt><dd>{counts.unchanged ?? 0}</dd></div>
        <div><dt>Conflicts</dt><dd>{counts.conflicts ?? 0}</dd></div>
        <div><dt>Errors</dt><dd>{errors.length}</dd></div>
      </dl>
      {errors.length > 0 && <>
        <p className="workspace-hint">Correct these rows and upload the file again.</p>
        <ul className="import-results" aria-label="Import validation errors">
          {errors.slice(0, 50).map((error, index) => (
            <li key={index}><strong>{error.row != null ? `Row ${error.row}` : 'File'}{error.field ? ` · ${error.field}` : ''}</strong><span>{error.message}</span></li>
          ))}
        </ul>
        {errors.length > 50 && <p className="workspace-hint">Showing the first 50 of {errors.length} errors.</p>}
      </>}
      {changes.length > 0 && <>
        <ul className="import-results" aria-label="Orders in this import">
          {[...changes].sort((left, right) => Number(right.status === 'conflict') - Number(left.status === 'conflict')).slice(0, 50).map((change, index) => (
            <li key={`${change.id}-${index}`}><strong>{change.id}</strong><span className="import-change-status">{change.status}{change.message && ` · ${change.message}`}</span></li>
          ))}
        </ul>
        {changes.length > 50 && <p className="workspace-hint">Showing the first 50 of {changes.length} orders.</p>}
      </>}
    </section>
  );
}

export default function OrderImport({ maxFileBytes = 5 * 1024 * 1024, onComplete, onUnauthorized }) {
  const maxFileSize = `${maxFileBytes / (1024 * 1024)} MiB`;
  const [file, setFile] = useState(null);
  const [inspection, setInspection] = useState(null);
  const [mapping, setMapping] = useState({});
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const id = useId();
  const isTabular = Boolean(inspection?.columns?.length);
  const canCommit = Boolean(report?.importId && !report.errors?.length && !report.counts?.conflicts);

  function reportError(failure) {
    if (failure.status === 401) onUnauthorized();
    else setError(failure.message);
  }

  async function inspect(upload, sheet) {
    setReport(null);
    setError('');
    setBusy('inspect');
    try {
      const data = await uploadRequest('inspect', upload, { sheet });
      setInspection(data);
      setMapping(data.mapping ?? {});
    } catch (failure) {
      setInspection(null);
      setMapping({});
      reportError(failure);
    } finally {
      setBusy('');
    }
  }

  async function changeFile(event) {
    const selected = event.target.files?.[0];
    setInspection(null);
    setReport(null);
    setMapping({});
    setError('');
    setFile(null);
    if (!selected) return;
    if (selected.size > maxFileBytes) {
      setError(`Choose a file no larger than ${maxFileSize}.`);
      return;
    }
    setFile(selected);
    await inspect(selected);
  }

  async function preview(event) {
    event.preventDefault();
    if (!file || busy) return;
    setError('');
    setReport(null);
    setBusy('preview');
    try {
      const selected = Object.fromEntries(Object.entries(mapping).filter(([, column]) => Boolean(column)));
      setReport(await uploadRequest('preview', file, { sheet: inspection.sheet, mapping: isTabular ? selected : undefined }));
    } catch (failure) {
      reportError(failure);
    } finally {
      setBusy('');
    }
  }

  async function commit() {
    if (busy || !canCommit) return;
    setError('');
    setBusy('commit');
    try {
      const result = await workspaceRequest('/api/imports?phase=commit', jsonRequest('POST', { importId: report.importId }));
      onComplete(result);
    } catch (failure) {
      if (failure.status === 409) setReport(null);
      reportError(failure);
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="workspace-panel import-panel" aria-labelledby="import-title">
      <div className="import-heading">
        <div><h2 id="import-title">Import orders</h2><p className="workspace-hint">Choose a CSV, Excel, or JSON file up to {maxFileSize}.</p></div>
        <nav className="template-links" aria-label="Download import templates">
          {Object.entries(formatNames).map(([format, label]) => (
            <a key={format} href={`/api/imports/template?format=${format}`} download>{label} template</a>
          ))}
        </nav>
      </div>
      {error && <div className="error-note" role="alert">{error}</div>}
      <form className="import-form" onSubmit={preview}>
        <label className="import-file-label" htmlFor="order-import-file">
          Order file
          <input id="order-import-file" type="file" accept=".csv,.xlsx,.json" disabled={Boolean(busy)} onChange={changeFile} />
        </label>
        {file && busy === 'inspect' && <p className="workspace-hint" role="status">Reading {file.name}…</p>}
        {file && !busy && !inspection && <button className="action action-secondary" type="button" onClick={() => void inspect(file)}>Try reading again</button>}
        {inspection && <>
          {inspection.sheets?.length > 1 && <label htmlFor={id + '-sheet'}>Worksheet
            <select id={id + '-sheet'} value={inspection.sheet} disabled={Boolean(busy)}
              onChange={(event) => void inspect(file, event.target.value)}>
              {inspection.sheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}
            </select>
          </label>}
          {isTabular && <fieldset disabled={Boolean(busy)}>
            <legend>Match file columns</legend>
            <p className="workspace-hint">Select the column for each order field. Include an item name or SKU.</p>
            <div className="mapping-grid">
              {columns.map(([key, label, required]) => <label key={key} htmlFor={id + key}>
                {label}{required && <span aria-hidden="true"> *</span>}
                <select id={id + key} value={mapping[key] ?? ''} required={required} onChange={(event) => {
                  setMapping((previous) => ({ ...previous, [key]: event.target.value }));
                  setReport(null);
                }}>
                  <option value="">{required ? 'Choose a column' : 'Leave unmapped'}</option>
                  {inspection.columns.map((column) => <option key={column} value={column}>{column}</option>)}
                </select>
              </label>)}
            </div>
          </fieldset>}
          <button className="action action-secondary" type="submit" disabled={Boolean(busy)}>
            {busy === 'preview' ? 'Preparing preview…' : 'Preview import'}
          </button>
        </>}
      </form>
      {report && <>
        <ImportPreview report={report} />
        <button className="action action-primary" type="button" disabled={!canCommit || Boolean(busy)} onClick={commit}>
          {busy === 'commit' ? 'Importing…' : 'Confirm import'}
        </button>
      </>}
    </section>
  );
}

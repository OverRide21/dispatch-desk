'use client';

import { useEffect, useState } from 'react';
import { jsonRequest, workspaceRequest } from './workspace-api.js';
import styles from './voice-usage.module.css';

const path = '/api/voice/usage';
const format = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });
const metrics = [
  ['transcriptionSeconds', 'Transcription', 'seconds'],
  ['synthesisCharacters', 'Playback', 'characters'],
];

function amount(value, unit) {
  return `${format.format(value)} ${unit}`;
}

export default function VoiceUsage({ sessionId, canEdit = false, onUnauthorized }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!open) return;
    let active;
    function load() {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      setLoading(true);
      setError('');
      workspaceRequest(path, {
        signal: controller.signal,
        headers: sessionId ? { 'X-Session-Id': sessionId } : undefined,
      }).then(value => {
        if (!controller.signal.aborted) setSummary(value);
      }).catch(failure => {
        if (controller.signal.aborted) return;
        if (failure.status === 401) onUnauthorized?.();
        else setError(failure.message);
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }
    load();
    window.addEventListener('dispatch-voice-usage', load);
    return () => {
      active?.abort();
      window.removeEventListener('dispatch-voice-usage', load);
    };
  }, [open, onUnauthorized, refresh, sessionId]);

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    const fields = new FormData(event.currentTarget);
    const limits = Object.fromEntries(metrics.map(([key]) => {
      const value = String(fields.get(key) ?? '').trim();
      return [key, value ? Number(value) : null];
    }));
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const value = await workspaceRequest(path, jsonRequest('PATCH', limits));
      setSummary(current => ({ ...value, call: current?.call ?? null }));
      setEditing(false);
      setNotice('Daily voice budget saved.');
      setRefresh(current => current + 1);
    } catch (failure) {
      if (failure.status === 401) onUnauthorized?.();
      else setError(failure.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className={styles.panel} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className={styles.heading}>Voice usage</summary>
      <div className={styles.body} aria-busy={loading}>
        {error && <p className="error-note" role="alert">{error}</p>}
        {notice && <p className={styles.note} role="status">{notice}</p>}
        {loading && !summary && <p className={styles.note} role="status">Loading voice usage…</p>}
        {summary && (
          <dl className={styles.metrics}>
            {metrics.map(([key, label, unit]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>
                  <strong>{amount(summary.today[key], unit)}</strong>
                  <span>{summary.limits[key] === null ? 'No daily limit' : `Daily limit ${amount(summary.limits[key], unit)}`}</span>
                  {summary.call && <span>This call used {amount(summary.call[key], unit)}</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {summary && <p className={styles.note}>Workspace totals reset at midnight UTC. Each Gnani request attempt counts toward the budget.</p>}
        {editing && canEdit && summary ? (
          <form className={styles.form} onSubmit={save}>
            <p className={styles.note}>Leave a limit blank for unlimited usage. Enter 0 to pause that type of voice request.</p>
            {metrics.map(([key, label, unit]) => (
              <label key={key}>
                {label} limit ({unit} per day)
                <input name={key} type="number" inputMode="numeric" min="0" max="1000000000" step="1"
                  defaultValue={summary.limits[key] ?? ''} disabled={saving} />
              </label>
            ))}
            <div className={styles.actions}>
              <button className="action action-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save budget'}</button>
              <button className="action action-secondary" type="button" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className={styles.actions}>
            <button className="action action-secondary" type="button" disabled={loading}
              onClick={() => setRefresh(current => current + 1)}>Refresh usage</button>
            {canEdit && summary && <button className="action action-secondary" type="button" onClick={() => {
              setNotice('');
              setEditing(true);
            }}>Edit daily budget</button>}
          </div>
        )}
      </div>
    </details>
  );
}

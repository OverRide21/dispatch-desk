'use client';

import { useCallback, useEffect, useState } from 'react';
import OrderImport from './order-import.jsx';
import { jsonRequest, workspaceRequest } from './workspace-api.js';

function WorkspaceMark() {
  return (
    <svg aria-hidden="true" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round">
      <path d="M3.5 12h2.2m2.1-4.3v8.6m4.2-12v15.4m4.2-12v8.6m2.1-4.3h2.2" />
    </svg>
  );
}

function WorkspaceError({ children }) {
  return children && <div className="error-note" role="alert">{children}</div>;
}

function SignIn({ configured, onSignIn, notice }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function signIn(event) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    setError('');
    setBusy(true);
    try {
      const { user } = await workspaceRequest('/api/auth', jsonRequest('POST', {
        username: String(fields.get('username')),
        password: String(fields.get('password')),
      }));
      onSignIn(user);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="access-main">
      <div className="intro">
        <h1>Order support, <em>by voice.</em></h1>
        <p>Sign in to find orders, review changes, and continue a conversation.</p>
      </div>
      <form className="workspace-panel signin-form" onSubmit={signIn}>
        <h2>Sign in</h2>
        <WorkspaceError>{error || notice}</WorkspaceError>
        {!configured && <p className="workspace-hint">Sign-in needs to be configured. Ask your workspace administrator to finish setup.</p>}
        <label>Username<input id="username" name="username" type="text" autoComplete="username" maxLength={120} disabled={busy || !configured} required /></label>
        <label>Password<input id="password" name="password" type="password" autoComplete="current-password" maxLength={256} disabled={busy || !configured} required /></label>
        <button className="action action-primary" type="submit" disabled={busy || !configured}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}

function OrderList({ user, maxImportBytes, onOpen, onUnauthorized }) {
  const [input, setInput] = useState('');
  const [search, setSearch] = useState({ query: '', revision: 0 });
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importNotice, setImportNotice] = useState('');
  const canImport = user.role === 'admin';

  useEffect(() => {
    const controller = new AbortController();
    workspaceRequest('/api/orders?' + new URLSearchParams({ q: search.query }), { signal: controller.signal })
      .then(({ orders }) => { if (!controller.signal.aborted) setResults(orders); })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure.status === 401) onUnauthorized();
        else setError(failure.message);
      });
    return () => controller.abort();
  }, [search, onUnauthorized]);

  function loadOrders(query) {
    setResults(null);
    setError('');
    setSearch((previous) => ({ query, revision: previous.revision + 1 }));
  }

  function searchOrders(event) {
    event.preventDefault();
    loadOrders(input.trim());
  }

  return (
    <main id="main">
      <div className="intro order-intro">
        <div>
          <h1>Find an <em>order.</em></h1>
          <p>Open an order to talk through changes in Marathi, Hindi, or English.</p>
        </div>
        {canImport && <button className="action action-primary" type="button" aria-expanded={showImport}
          onClick={() => setShowImport((visible) => !visible)}>{showImport ? 'Close import' : 'Import orders'}</button>}
      </div>
      {showImport && canImport && <OrderImport maxFileBytes={maxImportBytes} onUnauthorized={onUnauthorized} onComplete={({ counts }) => {
        setShowImport(false);
        setImportNotice(`Import complete. ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged.`);
        setInput('');
        loadOrders('');
      }} />}
      {importNotice && <p className="workspace-notice" role="status">{importNotice}</p>}
      <section className="workspace-panel order-list" aria-labelledby="orders-title">
        <div className="order-list-head">
          <h2 id="orders-title">Orders</h2>
          <form className="order-search" role="search" onSubmit={searchOrders}>
            <label htmlFor="order-search" className="sr-only">Search by order reference</label>
            <input id="order-search" type="search" value={input} maxLength={120}
              placeholder="Search by order reference" onChange={(event) => setInput(event.target.value)} />
            <button className="action action-secondary" type="submit">Search</button>
          </form>
        </div>
        <WorkspaceError>{error}</WorkspaceError>
        {error ? <button type="button" className="action action-secondary" onClick={() => loadOrders(search.query)}>Try again</button>
          : results === null ? <p className="workspace-hint" role="status">Loading orders…</p>
          : results.length === 0 ? <div className="orders-empty">
            <h3>{search.query ? 'No matching orders' : 'No orders yet'}</h3>
            <p>{search.query ? 'Check the order reference and search again.' : canImport
              ? 'Import an order file to make it available for calls.' : 'Ask your workspace administrator to import orders.'}</p>
            {search.query && <button type="button" className="action action-secondary" onClick={() => { setInput(''); loadOrders(''); }}>Show all orders</button>}
          </div> : <ul className="order-results">
            {results.map((order) => (
              <li key={order.id}>
                <button type="button" className="order-result" onClick={() => onOpen(order.id)} aria-label={`Open order ${order.id}`}>
                  <span><strong>{order.id}</strong><span>{order.customer}</span></span>
                  <span>{order.itemCount} {order.itemCount === 1 ? 'item' : 'items'} <span aria-hidden="true">→</span></span>
                </button>
              </li>
            ))}
          </ul>}
      </section>
    </main>
  );
}

export default function DispatchWorkspace({ OrderCall }) {
  const [auth, setAuth] = useState(null);
  const [error, setError] = useState('');
  const [authAttempt, setAuthAttempt] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const [orderId, setOrderId] = useState('');
  const onUnauthorized = useCallback(() => {
    setOrderId('');
    setAuth((previous) => ({ ...previous, user: null }));
    setError('Your sign-in expired. Sign in to continue.');
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    workspaceRequest('/api/auth', { signal: controller.signal })
      .then((status) => { if (!controller.signal.aborted) setAuth(status); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [authAttempt]);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setError('');
    setOrderId('');
    try {
      await workspaceRequest('/api/auth', { method: 'DELETE' });
      setAuth((previous) => ({ ...previous, user: null }));
    } catch (failure) {
      if (failure.status === 401) setAuth((previous) => ({ ...previous, user: null }));
      else setError(failure.message);
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="dispatch">
      <a className="skip-link" href="#main">Skip to main content</a>
      <header className="site-header">
        <a className="wordmark" href="#main" onClick={() => setOrderId('')}><span><WorkspaceMark /></span>Dispatch Desk</a>
        {auth?.user && <div className="header-actions">
          <span className="account-name">{auth.user.name}</span>
          <button className="action action-secondary" type="button" disabled={signingOut} onClick={signOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>}
      </header>
      {!auth ? <main className="intro" id="main">
        {error ? <><WorkspaceError>{error}</WorkspaceError><button className="action action-secondary" type="button"
          onClick={() => { setError(''); setAuthAttempt((value) => value + 1); }}>Try again</button></>
          : <p role="status">Connecting to Dispatch Desk…</p>}
      </main> : !auth.user ? <SignIn configured={auth.configured} notice={error} onSignIn={(user) => {
        setError('');
        setAuth((previous) => ({ ...previous, user }));
      }} /> : <>
        <WorkspaceError>{error}</WorkspaceError>
        {signingOut ? <main className="intro" id="main"><p role="status">Signing out…</p></main>
          : orderId ? <OrderCall key={orderId} orderId={orderId} onUnauthorized={onUnauthorized} onBack={() => setOrderId('')} />
          : <OrderList user={auth.user} maxImportBytes={auth.maxImportBytes} onOpen={setOrderId} onUnauthorized={onUnauthorized} />}
      </>}
    </div>
  );
}

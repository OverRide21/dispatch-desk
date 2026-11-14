'use client';

import { useEffect, useRef, useState } from 'react';
import DispatchWorkspace from './dispatch-workspace.jsx';
import { editLockReason } from '../../src/order-policies.mjs';
import { ReceiptHistory, ShipmentTimeline, StockOptions } from './order-extras.jsx';
import { prompts, useDispatch } from './use-dispatch.js';
import VoiceUsage from './voice-usage.jsx';

const glyphs = {
  mark: <><path d="M3.5 12h2.2m2.1-4.3v8.6m4.2-12v15.4m4.2-12v8.6m2.1-4.3h2.2" /></>,
  mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5.5 11.5v1a6.5 6.5 0 0 0 13 0v-1M12 19v2m-3 0h6" /></>,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  arrow: <path d="M4 12h15m-5-5 5 5-5 5" />,
  check: <path d="m5 12 4 4L19 6" />,
  lock: <><rect x="6" y="10.5" width="12" height="10" rx="2" /><path d="M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5M12 14.5v2" /></>,
  send: <path d="m5 12 14-7-4.5 14-3.1-5.5L5 12Zm6.4 1.5 3-3" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  box: <path d="m12 3 8.5 4.5v9L12 21l-8.5-4.5v-9L12 3Zm8.5 4.5L12 12 3.5 7.5M12 12v9M8 5.2l8.4 4.5" />,
};

function Icon({ name, size = 20 }) {
  return (
    <svg aria-hidden="true" className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
      {glyphs[name]}
    </svg>
  );
}

const wave = [25, 53, 38, 82, 100, 65, 42, 63, 25];
const replyProviderLabels = {
  auto: 'Automatic routing',
  groq: 'Groq · Qwen 27B',
  ollama: 'Local · Qwen 4B',
  'ollama-hari': 'Local · Hari 4B (8-bit)',
  rules: 'Fast · Local order engine',
};
const interpretationLabels = { ...replyProviderLabels, sarvam: 'Sarvam 105B', 'order-data': 'Order lookup', controls: 'Dispatch Desk controls' };

function VoiceStage({ model, meter, desk }) {
  const canSpeak = Boolean(model.session?.voiceEnabled && model.voiceReady);
  const interrupted = model.callActive && model.notice === 'Agent audio interrupted.';
  const voiceError = model.error?.area === 'voice';
  const turnBusy = model.busy && model.notice === 'Checking the order.';
  const state = model.startingMic || turnBusy
    ? 'processing'
    : voiceError ? 'error' : interrupted ? 'interrupted' : model.audioState;

  let label = 'Ready';
  if (!model.session) {
    label = model.error ? 'Connection interrupted' : 'Connecting';
  } else if (model.startingMic) {
    label = 'Opening microphone';
  } else if (state === 'processing') {
    label = 'Checking the order';
  } else if (voiceError) {
    label = 'Voice needs attention';
  } else if (!canSpeak) {
    label = model.session.voiceEnabled ? 'Getting voice ready' : 'Text support';
  } else if (state === 'speaking') {
    label = 'Agent speaking';
  } else if (interrupted) {
    label = 'Listening again';
  } else if (model.callActive) {
    label = 'Listening';
  }

  return (
    <section className="voice-stage" id="voice-stage" data-state={state} data-voice-enabled={Boolean(model.session?.voiceEnabled)} aria-label="Voice controls">
      <div className="stage-state">
        <span className="call-state" role="status"><span className="status-dot" />{label}</span>
        <div className="voice-meter" ref={meter} hidden={!model.callActive} aria-hidden="true">
          {wave.map((height, index) => <span key={index} style={{ '--bar': height / 100, '--phase': index % 7 }} />)}
        </div>
      </div>
      <div className="stage-controls">
        <label className="stage-language" htmlFor="language">
          <span className="sr-only">Conversation language</span>
          <select id="language" value={model.language} disabled={!model.session || model.startingMic || model.busy || model.audioState === 'processing'} onChange={(event) => desk.current?.setLanguage(event.target.value)}>
            <option value="mr-IN" lang="mr">मराठी</option>
            <option value="hi-IN" lang="hi">हिन्दी</option>
            <option value="en-IN">English</option>
          </select>
        </label>
        {model.session?.voiceEnabled && <button className="action action-mic" id="mic" type="button" aria-pressed={model.callActive}
          disabled={!canSpeak || model.startingMic || (model.busy && !model.callActive)}
          onClick={() => desk.current?.toggleVoice()}>
          <Icon name={model.callActive ? 'stop' : 'mic'} size={18} />
          <span>{model.startingMic ? 'Opening mic…' : model.callActive ? 'End call' : 'Start voice'}</span>
        </button>}
      </div>
    </section>
  );
}

function ErrorNote({ error, recover }) {
  if (!error) return null;
  return <div className="error-note" role="alert">
    <span>{error.text}</span>
    {error.recovery && <button type="button" onClick={recover}>{error.recovery}</button>}
  </div>;
}

function Conversation({ model, desk }) {
  const [draft, setDraft] = useState('');
  const thread = useRef(null);
  const input = useRef(null);
  const follow = useRef(true);
  const version = useRef(0);
  const messages = model.session?.messages;
  const turns = messages?.filter((message) => message.role === 'caller').length ?? 0;
  const modelName = model.replyProvider === 'ollama-hari' ? 'Hari 4B' : 'Qwen 4B';
  const accepting = Boolean(model.session && !model.shippingOrder && !model.busy && !model.startingMic && model.audioState !== 'processing');

  useEffect(() => {
    const element = thread.current;
    const scroll = () => { follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 12; };
    element.addEventListener('scroll', scroll, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (follow.current) element.scrollTop = element.scrollHeight;
    });
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      element.removeEventListener('scroll', scroll);
    };
  }, []);

  useEffect(() => {
    follow.current = true;
    thread.current.scrollTop = thread.current.scrollHeight;
  }, [messages]);

  async function send(event) {
    event.preventDefault();
    const submittedVersion = version.current;
    if (await desk.current?.submit(draft)) {
      if (version.current === submittedVersion) setDraft('');
    }
  }

  async function confirmChange(event) {
    const button = event.currentTarget;
    if (await desk.current?.submit(prompts[model.language].confirm)) {
      if (document.activeElement === button || document.activeElement === document.body) {
        input.current?.focus({ preventScroll: true });
      }
    }
  }

  return (
    <section className="conversation" aria-labelledby="transcript-title">
      <div className="conversation-head">
        <h2 id="transcript-title">Conversation</h2>
        <span className="turn-count">{turns} {turns === 1 ? 'turn' : 'turns'}</span>
      </div>
      {model.session && <div className="reply-settings">
        <label htmlFor="reply-provider">Reply provider</label>
        <select id="reply-provider" value={model.replyProvider} disabled={model.busy || model.startingMic || model.audioState === 'processing'}
          onChange={(event) => desk.current?.setReplyProvider(event.target.value)}>
          {Object.entries(replyProviderLabels).map(([provider, label]) => (
            <option key={provider} value={provider} disabled={!model.session.replyProviders.includes(provider)}>
              {label}{model.session.replyProviders.includes(provider) ? '' : ' (unavailable)'}
            </option>
          ))}
        </select>
        {model.replyProvider !== 'auto' && <>
          <label htmlFor="interpretation-mode">Interpretation</label>
          <select id="interpretation-mode" value={model.interpretationMode}
            disabled={model.busy || model.startingMic || model.audioState === 'processing'}
            onChange={event => desk.current?.setInterpretationMode(event.target.value)}>
            <option value="parser">Built-in parser</option>
            <option value="llm" disabled={model.replyProvider === 'rules'}>LLM · selected model</option>
          </select>
        </>}
        {model.replyProvider === 'auto' && <span>The order desk handles lookups and confirmations. A hosted model interprets other requests.</span>}
        {model.replyProvider === 'rules' && <span>Select a model to enable LLM interpretation.</span>}
        {model.interpretationMode === 'llm' && model.replyProvider === 'groq' &&
          <span>Groq receives the request text and order line details.</span>}
        {model.modelStatus && <span role="status">
          {model.modelStatus === 'warming' ? `Warming up ${modelName}…`
            : model.modelStatus === 'ready' ? `${modelName} is warmed up and ready.`
            : `${modelName} could not warm up. Check Ollama, then retry.`}
        </span>}
        {model.modelStatus === 'unavailable' && <button className="action action-secondary" type="button"
          onClick={() => void desk.current?.retryModel()}>Retry warm-up</button>}
        {(model.replyProvider === 'auto' || model.interpretationMode === 'llm') && interpretationLabels[model.interpretationSource] &&
          <span>Last handled by {interpretationLabels[model.interpretationSource]}</span>}
        {model.replyProvider !== 'auto' && model.interpretationMode === 'parser' && model.replySource &&
          <span>Last reply from {replyProviderLabels[model.replySource]}</span>}
        {model.typedReplyMs !== null && <span>Last typed reply · {model.typedReplyMs} ms</span>}
      </div>}
      <ol className="transcript" id="transcript" ref={thread} data-has-turns={turns > 0} role="log" aria-labelledby="transcript-title" aria-live="polite" aria-relevant="additions text" tabIndex={0}>
        {messages?.length ? messages.map((message, index) => {
          const caller = message.role === 'caller';
          return <li className={caller ? 'turn turn-caller' : 'turn turn-agent'} key={index}>
            {!caller && <div className="agent-mark"><Icon name="mark" size={16} /></div>}
            <div className="turn-content">
              <span>{caller ? 'You' : 'Dispatch Desk'}</span>
              <p lang={message.language}>{message.text}</p>
            </div>
          </li>;
        }) : <li className="thread-empty">{model.session ? 'Say or type what you’d like to change.' : 'Your conversation will appear here.'}</li>}
      </ol>
      <p className="sr-only" role="status" id="turn-status">{model.notice}</p>
      {model.session?.pending && <div className="confirmation-actions">
        <button id="confirm-change" type="button" className="action action-primary" disabled={!accepting} onClick={confirmChange}>
          Confirm change <Icon name="arrow" size={16} />
        </button>
      </div>}
      <ErrorNote error={model.error?.area === 'composer' ? model.error : null} recover={() => desk.current?.connect()} />
      <form className="composer" id="message-form" onSubmit={send}>
        <label className="sr-only" htmlFor="message">Type an order request</label>
        <input id="message" name="message" ref={input} value={draft} placeholder={prompts[model.language].placeholder} lang={model.language} autoComplete="off" maxLength={500}
          disabled={!model.session} required onChange={(event) => {
            version.current += 1;
            setDraft(event.target.value);
            if (event.target.value.trim()) desk.current?.holdShipping();
          }} />
        <button className="action action-send" id="send" type="submit" disabled={!accepting || !draft.trim()}>
          {model.busy && model.replyProvider === 'ollama-hari' ? 'Waiting for Hari…' : 'Send'} <Icon name="send" size={18} />
        </button>
      </form>
    </section>
  );
}

const lockLabels = { shipped: 'Shipped', packed: 'Packed', cutoff: 'Cutoff passed' };

function OrderTicket({ model, desk, onUnauthorized, guest }) {
  const [adding, setAdding] = useState(false);
  const session = model.session;
  const order = model.shippingOrder ?? session?.order;
  const items = order?.items.filter(item => item.quantity > 0 || item.status === 'shipped') ?? [];
  const pending = session?.pending;
  const stockOffer = session?.stockOffer;
  const history = session?.history ?? [];
  const latest = history[0];
  const shipped = items.filter(item => editLockReason(item) === 'shipped').length;
  const ticketState = pending ? 'pending' : latest ? 'saved' : 'idle';
  const action = pending ?? latest;
  const actionRows = (pending ? pending.updates : session?.receipt?.changes) ?? (action ? [action] : []);
  const accepting = Boolean(order && !model.shippingOrder && !model.busy && !model.startingMic && model.audioState !== 'processing');

  async function addItem(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const submitted = await desk.current?.proposeItem({ type: 'add', name: String(fields.get('name')).trim(),
      quantity: Number(fields.get('quantity')), unit: String(fields.get('unit')) });
    if (submitted) setAdding(false);
  }

  return (
    <aside className="ticket" id="order-record" aria-labelledby="ticket-title" data-state={ticketState}>
      <div className="ticket-head">
        <h2 id="ticket-title"><Icon name="box" size={22} /> Order ticket</h2>
        <span className="ticket-status">{order ? shipped === 0 ? 'Open' : shipped === items.length ? 'Shipped' : 'Partially shipped' : 'Loading'}</span>
      </div>
      <div className="ticket-identity">
        <span className="ticket-id" id="order-id">{order?.id ?? '—'}</span>
        <span className="ticket-customer" id="order-customer">{order?.customer ?? 'Loading customer…'}</span>
        {order?.source === 'storefront' && <span className="change-note" role="status">
          {model.shippingHeld && shipped < items.length ? 'Shipping paused while this order is being edited.' : ''}
        </span>}
      </div>
      {model.shippingOrder && <div className="order-table-wrap">
        <p className="change-note">The order changed. Refresh before editing again.</p>
        <button type="button" className="action action-secondary" disabled={model.busy}
          onClick={() => void desk.current?.connect()}>Refresh order</button>
      </div>}
      <div className="order-table-wrap">
        {order && <div className="ticket-actions">
          <button className="action action-secondary" type="button" aria-expanded={adding} disabled={!accepting}
            onClick={() => {
              if (!adding) desk.current?.holdShipping();
              setAdding(!adding);
            }}>{adding ? 'Close add item' : 'Add item'}</button>
        </div>}
        {adding && order && <form className="add-item-form" onSubmit={addItem} onChange={() => desk.current?.holdShipping()}>
          <label className="add-item-name">{order.source === 'storefront' ? 'Catalog name or SKU' : 'Item name'}
            <input name="name" required maxLength={180} disabled={!accepting} /></label>
          <label>Quantity<input name="quantity" type="number" min="1" max="1000000" step="1" required disabled={!accepting} /></label>
          <label>Unit<select name="unit" defaultValue="pieces" disabled={!accepting}>
            {['pieces', 'bags', 'boxes', 'kg', 'litres', 'bottles', 'packets'].map(unit => <option key={unit}>{unit}</option>)}
          </select></label>
          <button className="action action-primary" type="submit" disabled={!accepting}>Review addition</button>
        </form>}
        <table className="order-table">
          <thead><tr><th scope="col">Item</th><th scope="col">Quantity</th><th scope="col">Dispatch</th></tr></thead>
          <tbody id="order-items">
            {items.length ? items.map((item) => {
              const locked = editLockReason(item);
              return <tr key={item.id} data-item={item.id}>
              <th scope="row">{item.name}</th>
              <td className={history.some((entry) => entry.itemId === item.id) ? 'updated-quantity' : undefined}>
                {item.quantity} {item.unit}
                {item.backorderQuantity > 0 && <small className="order-quantity-note">{item.backorderQuantity} backordered</small>}
              </td>
              <td><span className={locked ? 'row-status row-shipped' : 'row-status row-editable'}>
                {locked && <Icon name="lock" size={15} />}{locked ? lockLabels[locked] : item.fulfillmentStage === 'picked' ? 'Picked · Editable' : 'Editable'}
              </span>{!locked && <button className="remove-item" type="button" disabled={!accepting}
                aria-label={`Remove ${item.name}`} onClick={() => void desk.current?.proposeItem({ type: 'remove', itemId: item.id, name: item.name })}>
                Remove
              </button>}</td>
            </tr>;
            }) : <tr><td colSpan={3}>{order ? 'No items on this order.' : 'Loading order items…'}</td></tr>}
          </tbody>
        </table>
      </div>
      <ShipmentTimeline items={items} />
      {stockOffer && <StockOptions offer={stockOffer} disabled={!accepting} language={model.language}
        onChoose={option => void desk.current?.chooseStock(option)} />}
      <div className="ticket-perforation" aria-hidden="true" />
      <div className="ticket-change" id="pending" aria-live="polite">
        <div className="change-title">
          <Icon name={ticketState === 'saved' ? 'check' : 'clock'} size={18} />
          <h3>{pending ? 'Awaiting confirmation' : latest ? 'Change saved' : 'Proposed change'}</h3>
        </div>
        {actionRows.length ? <>
          {actionRows.map(row => {
            const unit = row.unit ?? row.newItem?.unit ?? order?.items.find(item => item.id === row.itemId)?.unit;
            return <div key={row.itemId}>
              <p className="change-item">{row.from === 0 ? (pending ? 'Add ' : 'Added ') : row.to === 0 ? (pending ? 'Remove ' : 'Removed ') : ''}{row.name}</p>
              <div className="change-values">
                <span><small>Before</small><strong>{row.from}</strong></span>
                <Icon name="arrow" size={24} />
                <span><small>{pending ? 'Proposed' : 'Saved'}</small><strong>{row.to}</strong></span>
                {unit && <span className="change-unit">{unit}</span>}
              </div>
              {row.backorderQuantity > 0 && <p className="change-note">{row.backorderQuantity} {unit} on backorder.</p>}
              {row.from === row.to && row.backorderQuantity === 0 && <p className="change-note">
                {pending ? 'Allocate the remaining backorder from stock.' : 'Backorder allocated from stock.'}
              </p>}
            </div>;
          })}
          {pending && <button className="action action-primary ticket-confirm" type="button" disabled={!accepting}
            onClick={() => void desk.current?.submit(prompts[model.language].confirm)}>
            {actionRows.length > 1 ? 'Confirm both item changes' : 'Confirm item change'}
          </button>}
        </> : <p className="change-note">Proposed edits will appear here before you confirm them.</p>}
      </div>
      <section className="ticket-history" aria-labelledby="history-title" id="change-log">
        <div className="history-head">
          <h3 id="history-title">Change log</h3>
          <span id="history-count">{history.length} {history.length === 1 ? 'change' : 'changes'}</span>
        </div>
        <div id="history">
          {history.length ? <ol className="history-list">{history.map((entry, index) => {
            const time = new Date(entry.at);
            return <li key={`${entry.at}-${index}`}>
              <strong>{entry.from === 0 ? 'Added ' : entry.to === 0 ? 'Removed ' : ''}{entry.name}{entry.actor && <small className="history-actor">{entry.actor}</small>}</strong><span>{entry.from} <Icon name="arrow" size={14} /> {entry.to}</span>
              {!Number.isNaN(time.valueOf()) && <time dateTime={time.toISOString()}>
                {time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </time>}
            </li>;
          })}</ol> : <p className="change-note">Confirmed edits appear here.</p>}
        </div>
      </section>
      {order && !guest && <ReceiptHistory orderId={order.id} revision={order.revision} receipt={session.receipt} onUnauthorized={onUnauthorized} />}
    </aside>
  );
}

function OrderCall({ orderId, onUnauthorized, onBack, guest = false }) {
  const { model, meter, desk } = useDispatch(orderId, onUnauthorized, guest);
  const { pending, stockOffer, receipt, history } = model.session ?? {};
  const recentChange = pending ?? history?.[0];
  const changeCount = pending?.updates?.length ?? receipt?.changes.length ?? 0;

  return (
    <>
      <main className="dispatch-main" id="main">
        <div className="intro">
          {onBack && <button className="action action-secondary back-to-orders" type="button" onClick={onBack}>← All orders</button>}
          <h1>Talk through an <em>order change.</em></h1>
          <p>{guest ? 'Sample order. Try an update by voice or text, then confirm the change.' : <>
            Order <strong>{orderId}</strong>. Add or remove items, update a quantity, and confirm each change.</>}</p>
        </div>
        <div className="call-layout">
          <div className="call-column">
            <VoiceStage model={model} meter={meter} desk={desk} />
            <ErrorNote error={model.error?.area === 'voice' ? model.error : null} recover={() => desk.current?.connect()} />
            {(stockOffer || recentChange) && <a className="ticket-jump" href="#order-record" data-state={stockOffer || pending ? 'pending' : 'saved'}>
              <span>{stockOffer ? 'Stock options' : pending ? 'Proposed' : 'Saved'}{' '}
                <strong>{stockOffer ? stockOffer.name : changeCount > 1
                  ? `${changeCount} item changes` : `${recentChange.name}: ${recentChange.from} → ${recentChange.to}`}</strong>
              </span>
              <Icon name="arrow" size={18} />
            </a>}
            <Conversation model={model} desk={desk} />
            {model.session?.voiceEnabled && !guest && <VoiceUsage sessionId={model.session.sessionId} onUnauthorized={onUnauthorized} />}
          </div>
          <OrderTicket model={model} desk={desk} onUnauthorized={onUnauthorized} guest={guest} />
        </div>
      </main>
      <footer className="site-footer"><Icon name="lock" size={16} /> Packed items, shipped items, and items past their cutoff are locked. Edits are applied after you confirm them.</footer>
    </>
  );
}

export default function CallDesk({ workspace = false }) {
  if (workspace) return <DispatchWorkspace OrderCall={OrderCall} />;
  return <div className="dispatch">
    <a className="skip-link" href="#main">Skip to main content</a>
    <header className="site-header">
      <a className="wordmark" href="/"><span><Icon name="mark" /></span>Dispatch Desk</a>
      <div className="header-actions">
        <a className="action action-secondary" href="/dispatch-desk-pitch.pdf">Solution pitch</a>
        <a className="action action-secondary" href="/workspace">Workspace</a>
      </div>
    </header>
    <OrderCall guest />
  </div>;
}

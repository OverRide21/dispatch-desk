'use client';

import { useEffect, useRef, useState } from 'react';
import DispatchWorkspace from './dispatch-workspace.jsx';
import { prompts, useDispatch } from './use-dispatch.js';

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

const wave = [9, 15, 23, 12, 29, 42, 56, 34, 19, 36, 69, 49, 26, 43, 64, 90, 60, 31, 49, 76, 100, 64, 38, 61, 82, 48, 30, 45, 66, 44, 26, 52, 33, 18, 30, 43, 27, 16, 24, 13, 8];

function VoiceStage({ model, meter, desk }) {
  const canSpeak = Boolean(model.session?.voiceEnabled && model.voiceReady);
  const interrupted = model.callActive && model.notice === 'Agent audio interrupted.';
  const voiceError = model.error?.area === 'voice';
  const turnBusy = model.busy && model.notice === 'Checking the order.';
  const state = model.startingMic || turnBusy
    ? 'processing'
    : voiceError ? 'error' : interrupted ? 'interrupted' : model.audioState;

  let label = 'Ready to listen';
  let description = 'Speak in the selected language.';
  if (!model.session) {
    label = model.error ? 'Connection interrupted' : 'Connecting';
    description = model.error ? 'Reconnect to open this order.' : 'Getting this order ready.';
  } else if (model.startingMic) {
    label = 'Opening microphone';
    description = 'Allow microphone access to start your call.';
  } else if (state === 'processing') {
    label = 'Checking the order';
    description = 'The desk is reviewing your request.';
  } else if (voiceError) {
    label = 'Voice needs attention';
    description = 'Check the message below. You can also continue by text.';
  } else if (!canSpeak) {
    label = model.session.voiceEnabled ? 'Getting voice ready' : 'Text support';
    description = 'Type an order request below.';
  } else if (state === 'speaking') {
    label = 'Agent speaking';
    description = 'You can interrupt to make a correction.';
  } else if (interrupted) {
    label = 'You interrupted';
    description = 'Go ahead. The desk is listening.';
  } else if (model.callActive) {
    label = 'Listening';
  }

  return (
    <section className="voice-stage" id="voice-stage" data-state={state} data-voice-enabled={Boolean(model.session?.voiceEnabled)} aria-label="Voice controls">
      <div className="stage-top">
        <span className="call-state" role="status"><span className="status-dot" />{label}</span>
        <label className="stage-language" htmlFor="language">
          <span className="sr-only">Conversation language</span>
          <select id="language" value={model.language} disabled={!model.session || model.startingMic || model.busy || model.audioState === 'processing'} onChange={(event) => desk.current?.setLanguage(event.target.value)}>
            <option value="mr-IN" lang="mr">मराठी</option>
            <option value="hi-IN" lang="hi">हिन्दी</option>
            <option value="en-IN">English</option>
          </select>
        </label>
      </div>
      <div className="voice-meter" ref={meter} aria-hidden="true">
        {wave.map((height, index) => <span key={index} style={{ '--bar': height / 100, '--phase': index % 7 }} />)}
      </div>
      <div className="stage-actions">
        {model.session?.voiceEnabled && <button className="action action-mic" id="mic" type="button" aria-pressed={model.callActive}
          disabled={!canSpeak || model.startingMic || (model.busy && !model.callActive)}
          onClick={() => desk.current?.toggleVoice()}>
          <Icon name={model.callActive ? 'stop' : 'mic'} size={23} />
          <span>{model.startingMic ? 'Opening mic…' : model.callActive ? 'End call' : 'Start voice'}</span>
        </button>}
      </div>
      <p id="voice-label" className="stage-hint">{description}</p>
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
  const accepting = Boolean(model.session && !model.busy && !model.startingMic && model.audioState !== 'processing');

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
          disabled={!model.session} required onChange={(event) => { version.current += 1; setDraft(event.target.value); }} />
        <button className="action action-send" id="send" type="submit" disabled={!accepting || !draft.trim()}>
          Send <Icon name="send" size={18} />
        </button>
      </form>
    </section>
  );
}

function OrderTicket({ session }) {
  const order = session?.order;
  const pending = session?.pending;
  const history = session?.history ?? [];
  const latest = history[0];
  const shipped = order?.items.filter((item) => item.status === 'shipped').length ?? 0;
  const ticketState = pending ? 'pending' : latest ? 'saved' : 'idle';
  const quantityUnit = order?.items.find((item) => item.id === (pending ?? latest)?.itemId)?.unit;
  const action = pending ?? latest;

  return (
    <aside className="ticket" id="order-record" aria-labelledby="ticket-title" data-state={ticketState}>
      <div className="ticket-head">
        <h2 id="ticket-title"><Icon name="box" size={22} /> Order ticket</h2>
        <span className="ticket-status">{order ? shipped === 0 ? 'Open' : shipped === order.items.length ? 'Shipped' : 'Partially shipped' : 'Loading'}</span>
      </div>
      <div className="ticket-identity">
        <span className="ticket-id" id="order-id">{order?.id ?? '—'}</span>
        <span className="ticket-customer" id="order-customer">{order?.customer ?? 'Loading customer…'}</span>
      </div>
      <div className="order-table-wrap">
        <table className="order-table">
          <thead><tr><th scope="col">Item</th><th scope="col">Quantity</th><th scope="col">Dispatch</th></tr></thead>
          <tbody id="order-items">
            {order ? order.items.map((item) => <tr key={item.id} data-item={item.id}>
              <th scope="row">{item.name}</th>
              <td className={history.some((entry) => entry.itemId === item.id) ? 'updated-quantity' : undefined}>
                {item.quantity} {item.unit}
              </td>
              <td><span className={item.status === 'shipped' ? 'row-status row-shipped' : 'row-status row-editable'}>
                {item.status === 'shipped' && <Icon name="lock" size={15} />}{item.status === 'shipped' ? 'Shipped' : 'Editable'}
              </span></td>
            </tr>) : <tr><td colSpan={3}>Loading order items…</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="ticket-perforation" aria-hidden="true" />
      <div className="ticket-change" id="pending" aria-live="polite">
        <div className="change-title">
          <Icon name={ticketState === 'saved' ? 'check' : 'clock'} size={18} />
          <h3>{pending ? 'Awaiting confirmation' : latest ? 'Change saved' : 'Proposed change'}</h3>
        </div>
        {action ? <>
          <p className="change-item">{action.name}</p>
          <div className="change-values">
            <span><small>Before</small><strong>{action.from}</strong></span>
            <Icon name="arrow" size={24} />
            <span><small>{pending ? 'Proposed' : 'Saved'}</small><strong>{action.to}</strong></span>
            {quantityUnit && <span className="change-unit">{quantityUnit}</span>}
          </div>
          <p className="change-note">{pending ? 'The order updates after you confirm.' : 'The updated quantity is on the order.'}</p>
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
              <strong>{entry.name}{entry.actor && <small className="history-actor">{entry.actor}</small>}</strong><span>{entry.from} <Icon name="arrow" size={14} /> {entry.to}</span>
              {!Number.isNaN(time.valueOf()) && <time dateTime={time.toISOString()}>
                {time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </time>}
            </li>;
          })}</ol> : <p className="change-note">Confirmed edits appear here.</p>}
        </div>
      </section>
    </aside>
  );
}

function OrderCall({ orderId, onUnauthorized, onBack }) {
  const { model, meter, desk } = useDispatch(orderId, onUnauthorized);
  const recentChange = model.session?.pending ?? model.session?.history?.[0];

  return (
    <>
      <main className="dispatch-main" id="main">
        <div className="intro">
          <button className="action action-secondary back-to-orders" type="button" onClick={onBack}>← All orders</button>
          <h1>Talk through an <em>order change.</em></h1>
          <p>Order <strong>{orderId}</strong>. Ask about the order, correct a quantity, then confirm the edit.</p>
        </div>
        <div className="call-layout">
          <div className="call-column">
            <VoiceStage model={model} meter={meter} desk={desk} />
            <ErrorNote error={model.error?.area === 'voice' ? model.error : null} recover={() => desk.current?.connect()} />
            {recentChange && <a className="ticket-jump" href="#order-record" data-state={model.session.pending ? 'pending' : 'saved'}>
              <span>{model.session.pending ? 'Proposed' : 'Saved'} <strong>{recentChange.name}: {recentChange.from} → {recentChange.to}</strong></span>
              <Icon name="arrow" size={18} />
            </a>}
            <Conversation model={model} desk={desk} />
          </div>
          <OrderTicket session={model.session} />
        </div>
      </main>
      <footer className="site-footer"><Icon name="lock" size={16} /> Shipped items are locked. Edits are applied after you confirm them.</footer>
    </>
  );
}

export default function CallDesk() {
  return <DispatchWorkspace OrderCall={OrderCall} />;
}

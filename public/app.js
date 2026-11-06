const id = (name) => document.getElementById(name);
const ui = Object.fromEntries([
  'reset', 'workspace-error', 'mode', 'voice-stage', 'voice-bars', 'voice-label',
  'voice-description', 'mic', 'mic-icon', 'mic-text', 'turn-count', 'transcript',
  'turn-status', 'composer-error', 'language', 'message-form', 'message', 'send', 'sample-buttons',
  'order-status', 'order-id', 'order-customer', 'order-items', 'pending',
  'history-count', 'history',
].map((name) => [name, id(name)]));

const samples = {
  'mr-IN': {
    request: 'तांदळाच्या बारा पिशव्या करा आणि साखर रद्द करा.',
    correct: 'बारा नाही, दहा करा.',
    confirm: 'हो, बदल करा.',
    example: 'उदा. तांदळाच्या बारा पिशव्या करा',
  },
  'hi-IN': {
    request: 'चावल की बारह बोरियाँ कर दो और चीनी रद्द करो।',
    correct: 'बारह नहीं, दस कर दो।',
    confirm: 'हाँ, कर दो।',
    example: 'जैसे, चावल की बारह बोरियाँ कर दो',
  },
  'en-IN': {
    request: 'Change rice to twelve and cancel sugar.',
    correct: 'Twelve no, ten.',
    confirm: 'Confirm.',
    example: 'e.g. Change rice to twelve bags',
  },
};

let current = null;
let sessionId = readStored('dispatch-desk-session');
let voice = null;
let voiceFailed = false;
let callActive = false;
let startingMic = false;
let audioState = 'idle';
let audioVersion = 0;
let busy = false;
let displayedMessages = [];
let followTranscript = true;

function readStored(key) {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

function writeStored(key, value) {
  try { window.sessionStorage.setItem(key, value); } catch { /* Storage may be disabled. */ }
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function announce(message) {
  ui['turn-status'].textContent = message;
}

function showError(message, retry, location = 'workspace-error') {
  const banner = ui[location];
  banner.replaceChildren(document.createTextNode(message));
  if (retry) {
    const button = node('button', '', 'Try again');
    button.type = 'button';
    button.addEventListener('click', retry, { once: true });
    banner.append(button);
  }
  banner.hidden = false;
}

function clearError() {
  for (const location of ['workspace-error', 'composer-error']) {
    ui[location].hidden = true;
    ui[location].replaceChildren();
  }
}

async function request(path, data) {
  const headers = new Headers();
  if (sessionId) headers.set('X-Session-Id', sessionId);
  if (data !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: 'no-store',
  });
  const content = await response.json().catch(() => null);
  if (!response.ok || !content) {
    const detail = content?.error ?? content?.message;
    const error = new Error(typeof detail === 'string' ? detail : 'The workspace could not complete that request. Try again.');
    error.status = response.status;
    throw error;
  }
  return content;
}

function renderControls() {
  const ready = Boolean(current);
  const voiceEnabled = Boolean(current?.voiceEnabled && !voiceFailed);
  const acceptingText = ready && !busy && audioState !== 'processing';
  ui.mode.classList.toggle('pill-live', voiceEnabled);
  ui.mode.textContent = !ready ? 'Connecting' : voiceEnabled ? 'Gnani voice' : 'Text demo';
  ui.reset.disabled = !ready || busy || startingMic;
  ui.message.disabled = !ready;
  ui.send.disabled = !acceptingText;
  ui.language.disabled = !ready;
  for (const button of ui['sample-buttons'].querySelectorAll('button')) {
    button.disabled = !acceptingText || (button.dataset.sample !== 'request' && !current?.pending);
  }

  ui.mic.disabled = !voiceEnabled || !voice || startingMic;
  ui.mic.setAttribute('aria-pressed', String(callActive));
  ui['mic-icon'].setAttribute('href', callActive ? '#i-stop' : '#i-mic');
  ui['mic-text'].textContent = startingMic ? 'Opening mic…' : callActive ? 'End voice' : 'Start voice';

  let state = audioState;
  let title = 'Ready for a voice call';
  let description = 'Start the microphone and speak in Hindi or Marathi.';
  if (!ready) {
    state = 'idle';
    title = 'Connecting to workspace';
    description = 'Getting your demo order ready.';
  } else if (!voiceEnabled) {
    state = 'idle';
    title = 'Text demo mode';
    description = voiceFailed ? 'Voice could not load. You can keep working by text.' : 'Voice is unconfigured. Type or try the sample conversation.';
  } else if (startingMic) {
    state = 'processing';
    title = 'Opening microphone';
    description = 'Allow microphone access to continue.';
  } else if (state === 'processing' || (busy && callActive && state !== 'speaking')) {
    state = 'processing';
    title = 'Processing your request';
    description = 'The agent is checking the order.';
  } else if (state === 'speaking') {
    title = 'Agent is speaking';
    description = 'Speak at any time to make a correction.';
  } else if (callActive) {
    state = 'listening';
    title = 'Listening';
    description = current.voiceAutoLanguage === false ? 'Speak in the selected language.' : 'Speak naturally in Hindi or Marathi.';
  } else {
    state = 'idle';
  }

  ui['voice-stage'].dataset.state = state;
  if (ui['voice-label'].textContent !== title) ui['voice-label'].textContent = title;
  if (ui['voice-description'].textContent !== description) ui['voice-description'].textContent = description;
}

function renderTranscript(messages = []) {
  const container = ui.transcript;
  const isPrefix = displayedMessages.length <= messages.length && displayedMessages.every((entry, index) => {
    const next = messages[index];
    return entry.role === next.role && entry.text === next.text && entry.language === next.language;
  });
  const start = isPrefix ? displayedMessages.length : 0;
  if (!isPrefix || start === 0) container.replaceChildren();

  for (const message of messages.slice(start)) {
    const caller = message.role === 'caller';
    const row = node('li', caller ? 'turn caller' : 'turn agent');
    if (!caller) {
      const avatar = node('span', 'turn-avatar');
      avatar.append(icon('headset'));
      row.append(avatar);
    }
    const body = node('div', 'turn-body');
    const content = node('p', 'turn-message', message.text);
    if (message.language) content.lang = message.language;
    body.append(node('p', 'turn-author', caller ? 'You' : 'Dispatch agent'), content);
    row.append(body);
    container.append(row);
  }
  if (!messages.length) container.append(node('li', 'transcript-empty', 'Ask about the order or start with a sample below.'));
  if (start < messages.length) {
    followTranscript = true;
    container.scrollTop = container.scrollHeight;
  }
  displayedMessages = messages.slice();
  const turns = messages.filter((message) => message.role === 'caller').length;
  ui['turn-count'].textContent = `${turns} ${turns === 1 ? 'turn' : 'turns'}`;
}

function renderOrder(order, pending, history) {
  ui['order-id'].textContent = order.id;
  ui['order-customer'].textContent = order.customer;
  const shipped = order.items.filter((item) => item.status === 'shipped').length;
  ui['order-status'].textContent = shipped === 0 ? 'Open' : shipped === order.items.length ? 'Shipped' : 'Partially shipped';
  ui['order-items'].replaceChildren(...order.items.map((item) => {
    const row = node('tr');
    const unit = item.quantity === 1 ? item.unit.replace(/s$/u, '') : item.unit;
    const amount = node('td', history.some((entry) => entry.itemId === item.id) ? 'quantity-change' : '', `${item.quantity} ${unit}`);
    const dispatch = node('td');
    const itemStatus = node('span', `pill status-item ${item.status === 'shipped' ? 'shipped' : 'pending'}`);
    if (item.status === 'shipped') itemStatus.append(icon('lock'));
    itemStatus.append(document.createTextNode(item.status === 'shipped' ? 'Shipped' : 'Editable'));
    dispatch.append(itemStatus);
    row.append(node('td', '', item.name), amount, dispatch);
    return row;
  }));

  ui.pending.classList.toggle('has-change', Boolean(pending));
  const pendingTitle = node('div', 'pending-label');
  pendingTitle.append(icon('clock'), node('strong', '', pending ? 'Awaiting confirmation' : 'Pending change'));
  const details = node('div');
  if (pending) {
    const change = node('div', 'pending-change');
    change.append(node('span', '', pending.name), node('span', '', String(pending.from)), icon('arrow'), node('strong', '', String(pending.to)));
    details.append(change, node('p', 'empty-note', 'Confirm the new quantity to update the order.'));
  } else {
    details.append(node('p', 'empty-note', 'Proposed edits appear here before you confirm them.'));
  }
  ui.pending.replaceChildren(pendingTitle, details);

  ui['history-count'].textContent = `${history.length} ${history.length === 1 ? 'change' : 'changes'}`;
  if (!history.length) {
    ui.history.replaceChildren(node('p', 'empty-note', 'Confirmed edits will be recorded here.'));
    return;
  }
  ui.history.replaceChildren(...history.map((entry) => {
    const row = node('div', 'history-entry');
    const content = node('div');
    const timestamp = new Date(entry.at);
    const time = node('time', '', Number.isNaN(timestamp.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp));
    if (!Number.isNaN(timestamp.getTime())) time.dateTime = timestamp.toISOString();
    content.append(node('strong', '', `${entry.name}: ${entry.from} → ${entry.to}`), time);
    row.append(icon('check'), content);
    return row;
  }));
}

function render(snapshot) {
  sessionId = snapshot.sessionId;
  writeStored('dispatch-desk-session', sessionId);
  current = snapshot;
  renderTranscript(snapshot.messages);
  renderOrder(snapshot.order, snapshot.pending, snapshot.history ?? []);
  renderControls();
}

function changeLanguage(value) {
  if (!Object.hasOwn(samples, value)) return;
  ui.language.value = value;
  ui.message.placeholder = samples[value].example;
  writeStored('dispatch-desk-language', value);
}

function stopPlayback() {
  audioVersion += 1;
  voice?.stopSpeaking();
}

async function submitTurn(text, language, source) {
  const value = text.trim();
  if (busy || !current || !value || (source !== 'voice' && audioState === 'processing')) return false;
  if (source !== 'voice') stopPlayback();
  const version = audioVersion;
  busy = true;
  clearError();
  announce('Checking the order.');
  renderControls();

  try {
    const snapshot = await request('/api/turn', { text: value, language });
    render(snapshot);
    announce('Response received.');
    if (callActive && version === audioVersion && snapshot.reply) {
      voice?.speak(snapshot.reply, snapshot.language ?? language).catch((error) => {
        if (error.name !== 'AbortError') showError(error.message);
      });
    }
    return true;
  } catch (error) {
    showError(error.message, error.status === 409 ? connect : undefined, source === 'voice' ? 'workspace-error' : 'composer-error');
    return false;
  } finally {
    busy = false;
    renderControls();
  }
}

async function initVoice() {
  if (voice || !current?.voiceEnabled) return;
  try {
    const { createVoice } = await import('./voice.js');
    voice = createVoice({
      getSessionId: () => sessionId,
      onUtterance: ({ text, language }) => {
        if (!callActive) return;
        if (Object.hasOwn(samples, language)) changeLanguage(language);
        return submitTurn(text, Object.hasOwn(samples, language) ? language : ui.language.value, 'voice');
      },
      onState: (state) => {
        audioState = state;
        renderControls();
      },
      onError: (message) => showError(typeof message === 'string' ? message : message.message),
      onLevel: (level) => {
        const bounded = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
        ui['voice-bars'].style.setProperty('--voice-scale', String(0.5 + bounded * 0.7));
      },
      onInterrupt: () => {
        audioVersion += 1;
        announce('Agent audio interrupted.');
      },
    });
  } catch {
    voiceFailed = true;
    showError('Voice controls could not load. You can continue by text.');
  }
  renderControls();
}

function endVoice() {
  callActive = false;
  stopPlayback();
  voice?.stopListening();
  audioState = 'idle';
  ui['voice-bars'].style.removeProperty('--voice-scale');
  renderControls();
}

async function toggleVoice() {
  if (!voice || startingMic) return;
  if (callActive) {
    endVoice();
    announce('Voice call ended.');
    return;
  }
  startingMic = true;
  const version = audioVersion;
  clearError();
  renderControls();
  try {
    await voice.prepare?.();
    if (version !== audioVersion) return;
    callActive = true;
    await voice.startListening(current.voiceAutoLanguage === false ? ui.language.value : 'indic-auto');
    if (!callActive) return;
    announce('Voice call started.');
  } catch (error) {
    endVoice();
    showError(error.message || 'Microphone access failed. You can continue by text.');
  } finally {
    startingMic = false;
    renderControls();
  }
}

async function connect() {
  clearError();
  try {
    render(await request('/api/session'));
    await initVoice();
  } catch (error) {
    showError(error.message, connect);
  }
}

async function reset() {
  if (!current || busy) return;
  busy = true;
  endVoice();
  clearError();
  try {
    render(await request('/api/reset', {}));
    ui.message.value = '';
    announce('Demo order reset.');
  } catch (error) {
    showError(error.message, error.status === 409 ? connect : undefined);
  } finally {
    busy = false;
    renderControls();
  }
}

ui['message-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = ui.message.value;
  if (await submitTurn(text, ui.language.value, 'typed') && ui.message.value === text) ui.message.value = '';
});

ui['sample-buttons'].addEventListener('click', (event) => {
  const button = event.target.closest('button[data-sample]');
  if (!button || button.disabled) return;
  const language = ui.language.value;
  submitTurn(samples[language][button.dataset.sample], language, 'sample');
});

ui.language.addEventListener('change', () => {
  changeLanguage(ui.language.value);
  if (callActive && current.voiceAutoLanguage === false) {
    voice.startListening(ui.language.value).catch((error) => showError(error.message));
  }
});
ui.mic.addEventListener('click', toggleVoice);
ui.reset.addEventListener('click', reset);
ui.transcript.addEventListener('scroll', () => {
  const { scrollHeight, scrollTop, clientHeight } = ui.transcript;
  followTranscript = scrollHeight - scrollTop - clientHeight < 8;
}, { passive: true });
new ResizeObserver(() => {
  if (followTranscript) ui.transcript.scrollTop = ui.transcript.scrollHeight;
}).observe(ui.transcript);
window.addEventListener('pagehide', () => {
  if (callActive || startingMic) endVoice();
});

const links = [...document.querySelectorAll('.nav-link')];
function updateNavigation() {
  const active = links.find((link) => link.hash === location.hash) ?? links[0];
  for (const link of links) {
    link.classList.toggle('is-current', link === active);
    if (link === active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

window.addEventListener('hashchange', updateNavigation);
updateNavigation();
changeLanguage(readStored('dispatch-desk-language') ?? 'mr-IN');
connect();

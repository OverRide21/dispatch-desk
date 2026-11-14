'use client';

import { useEffect, useRef, useState } from 'react';

export const prompts = {
  'mr-IN': { confirm: 'हो, बदल करा.', placeholder: 'ऑर्डरमध्ये काय बदलायचं आहे?' },
  'hi-IN': { confirm: 'हाँ, कर दो।', placeholder: 'ऑर्डर में क्या बदलना है?' },
  'en-IN': { confirm: 'Confirm.', placeholder: 'Ask about this order or request a change' },
};

const initial = {
  session: null,
  language: 'mr-IN',
  voiceReady: false,
  callActive: false,
  startingMic: false,
  audioState: 'idle',
  busy: false,
  error: null,
  notice: '',
  replyProvider: null,
  interpretationMode: 'parser',
  interpretationSource: null,
  modelStatus: null,
  replySource: null,
  typedReplyMs: null,
  shippingHeld: false,
  shippingOrder: null,
};
const replyPreferenceKey = 'dispatch-desk-reply-mode';
const interpretationPreferenceKey = 'dispatch-desk-interpretation';
const modelPath = '/api/session/model';
const isLocalModel = provider => provider === 'ollama' || provider === 'ollama-hari';

export function readPreference(key) {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

export function savePreference(key, value) {
  try { window.sessionStorage.setItem(key, value); } catch { /* Storage can be disabled. */ }
}

function createDesk(render, meter, orderId, onUnauthorized, guest, accessKey) {
  let model = initial;
  let sessionId;
  let voice;
  let playbackVersion = 0;
  let shippingSequence = 0;
  let lastHoldRequest = 0;
  let shippingTouched = false;
  let modelRequest;
  let modelQueue = Promise.resolve();
  let lastModelCheck = 0;
  const lifecycle = new AbortController();

  function update(changes) {
    if (lifecycle.signal.aborted) return;
    model = { ...model, ...changes };
    render(model);
  }

  function applySnapshot(session) {
    const newCall = sessionId !== session.sessionId;
    if (newCall) releaseShipping();
    sessionId = session.sessionId;
    const preferred = model.replyProvider ?? readPreference(replyPreferenceKey);
    const replyProvider = session.replyProviders.includes(preferred) ? preferred
      : session.defaultReplyProvider ?? session.replyProviders[0];
    const providerChanged = replyProvider !== model.replyProvider;
    const interpretationMode = replyProvider === 'rules' ? 'parser'
      : !model.session && readPreference(interpretationPreferenceKey) === 'llm' ? 'llm' : model.interpretationMode;
    update({
      session, replyProvider, replySource: session.replySource ?? null,
      interpretationMode, interpretationSource: session.interpretationSource ?? null,
      ...(newCall ? { shippingHeld: false } : {}),
      ...(newCall || session.order.revision >= model.shippingOrder?.revision ? { shippingOrder: null } : {}),
    });
    if (providerChanged) startModel(replyProvider);
    if (newCall && session.order.source === 'storefront') void syncShipping();
  }

  async function syncShipping(method = 'GET', keepalive = false) {
    const session = model.session;
    if (!sessionId || session?.order.source !== 'storefront') return;
    const id = sessionId;
    const sequence = ++shippingSequence;
    try {
      const response = await fetch('/api/session/shipping?' + new URLSearchParams({ revision: session.order.revision }), {
        method, keepalive, headers: { 'X-Session-Id': id }, cache: 'no-store',
        ...(keepalive ? {} : { signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(10_000)]) }),
      });
      if (!response.ok) return;
      const { holdUntil, order } = await response.json();
      if (id !== sessionId || sequence !== shippingSequence) return;
      update({
        shippingHeld: holdUntil > Date.now(),
        ...(!model.busy && order?.revision > model.session?.order.revision ? { shippingOrder: order } : {}),
      });
    } catch { /* A disconnected tab's shipping hold expires on the server. */ }
  }

  function holdShipping() {
    if (model.session?.order.source !== 'storefront' || Date.now() - lastHoldRequest < 5_000) return;
    lastHoldRequest = Date.now();
    shippingTouched = true;
    void syncShipping('POST');
  }

  function releaseShipping() {
    if (!shippingTouched) return;
    shippingTouched = false;
    lastHoldRequest = 0;
    void syncShipping('DELETE', true);
  }

  const shippingTimer = setInterval(() => {
    if (document.hidden) return;
    if (model.callActive) holdShipping();
    else void syncShipping();
  }, 10_000);

  function report(error, area) {
    if (lifecycle.signal.aborted) return;
    if (error.status === 401 && onUnauthorized) {
      endVoice('');
      onUnauthorized();
      return;
    }
    const needsRefresh = ['order-stale', 'order-conflict', 'line-shipped', 'line-packed', 'line-cutoff',
      'stock-unavailable', 'invalid-substitution'].includes(error.code);
    if (needsRefresh) {
      endVoice('');
      releaseShipping();
      sessionId = undefined;
      update({ session: null });
    }
    update({ error: {
      text: error.message || String(error),
      area,
      recovery: needsRefresh || error.code === 'session-stale' ? 'Refresh order'
        : error.code === 'session-expired' || !model.session ? 'Reconnect' : null,
    } });
  }

  async function request(path, data, signal) {
    const timeoutMs = path === modelPath ? 50_000 : data?.replyProvider === 'ollama-hari' ? 55_000 : 15_000;
    const audio = data?.audio;
    const headers = new Headers();
    if (sessionId) headers.set('X-Session-Id', sessionId);
    if (audio) {
      headers.set('Content-Type', 'audio/wav');
      headers.set('X-Language', data.language);
      headers.set('X-Reply-Provider', data.replyProvider);
    } else if (data !== undefined) headers.set('Content-Type', 'application/json');
    if (data !== undefined && Number.isInteger(model.session?.revision)) {
      headers.set('X-Session-Revision', String(model.session.revision));
    }
    const response = await fetch(path, {
      method: data === undefined ? 'GET' : 'POST',
      headers,
      body: audio ?? (data === undefined ? undefined : JSON.stringify(data)),
      cache: 'no-store',
      signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(audio ? 40_000 : timeoutMs), ...(signal ? [signal] : [])]),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) {
      throw Object.assign(new Error(body?.error ?? 'The order desk could not complete that request. Try again.'), {
        status: response.status,
        code: body?.code,
      });
    }
    return body;
  }

  function setLanguage(language) {
    if (!Object.hasOwn(prompts, language) || model.language === language) return;
    savePreference('dispatch-desk-language', language);
    update({ language });
    if (model.callActive) {
      stopPlayback();
      void voice.startListening(language).catch((error) => report(error, 'voice'));
    }
  }

  function setReplyProvider(replyProvider) {
    if (model.busy || replyProvider === model.replyProvider || !model.session?.replyProviders.includes(replyProvider)) return;
    savePreference(replyPreferenceKey, replyProvider);
    if (replyProvider === 'rules') savePreference(interpretationPreferenceKey, 'parser');
    update({ replyProvider, interpretationSource: null, replySource: null,
      ...(replyProvider === 'rules' ? { interpretationMode: 'parser' } : {}) });
    startModel(replyProvider);
  }

  function setInterpretationMode(interpretationMode) {
    if (model.busy || model.replyProvider === 'auto' || !['parser', 'llm'].includes(interpretationMode) ||
        interpretationMode === 'llm' && model.replyProvider === 'rules') return;
    savePreference(interpretationPreferenceKey, interpretationMode);
    update({ interpretationMode, interpretationSource: null });
  }

  function startModel(provider) {
    modelRequest = null;
    lastModelCheck = 0;
    update({ modelStatus: isLocalModel(provider) ? 'warming' : null });
    if (isLocalModel(provider)) void checkModel();
  }

  function checkModel() {
    const provider = model.replyProvider;
    if (!isLocalModel(provider)) return Promise.resolve(true);
    if (modelRequest) return modelRequest.result;

    if (model.modelStatus !== 'ready') update({ modelStatus: 'warming' });
    const pending = {};
    modelRequest = pending;
    pending.result = modelQueue
      .then(() => {
        if (modelRequest !== pending || lifecycle.signal.aborted) return null;
        lastModelCheck = Date.now();
        return request(modelPath, { provider });
      })
      .then(result => {
        if (modelRequest !== pending) return false;
        const status = result?.ready === true && result.provider === provider ? 'ready' : 'unavailable';
        if (model.modelStatus !== status) update({ modelStatus: status });
        return status === 'ready';
      })
      .catch(error => {
        if (modelRequest === pending) {
          if (error.status === 401) report(error, 'composer');
          else update({ modelStatus: 'unavailable' });
        }
        return false;
      })
      .finally(() => {
        if (modelRequest === pending) modelRequest = null;
      });
    modelQueue = pending.result;
    return pending.result;
  }

  function maintainModel() {
    if (Date.now() - lastModelCheck >= 30_000) void checkModel();
  }

  const modelTimer = setInterval(maintainModel, 60_000);

  function stopPlayback() {
    playbackVersion += 1;
    voice?.stopSpeaking();
  }

  function endVoice(notice = 'Voice call ended.') {
    update({ callActive: false, startingMic: false, audioState: 'idle', notice });
    stopPlayback();
    voice?.stopListening();
    meter.current?.style.removeProperty('--voice-level');
  }

  async function submit(text, source = 'typed', itemAction, stockAction, recording) {
    const message = text.trim();
    if ((!message && !recording) || !model.session || model.busy ||
      (source !== 'voice' && (model.startingMic || model.audioState === 'processing'))) return false;
    if (source !== 'voice') stopPlayback();
    if (model.session.order.source === 'storefront') shippingTouched = true;
    const version = playbackVersion;
    const language = model.language;
    const started = performance.now();
    const warming = isLocalModel(model.replyProvider) && model.modelStatus !== 'ready';
    update({ busy: true, error: null, notice: warming ? 'Waiting for the selected model to warm up.' :
      model.replyProvider === 'ollama-hari' ? 'Waiting for Hari.' : 'Checking the order.' });
    try {
      if (warming && !await checkModel()) return false;
      if (lifecycle.signal.aborted || recording?.signal.aborted || source === 'voice' && !model.callActive) return false;
      const session = await request('/api/turn', recording ? { audio: recording.audio, language, replyProvider: model.replyProvider }
        : { text: message, language, replyProvider: model.replyProvider, interpretationMode: model.interpretationMode, itemAction, stockAction }, recording?.signal);
      const replyMs = Math.round(performance.now() - started);
      applySnapshot(session);
      if (!model.callActive && !session.pending && !session.stockOffer) releaseShipping();
      else if (!model.callActive) void syncShipping();
      update({ notice: 'Response received.', ...(source === 'typed' ? { typedReplyMs: replyMs } : {}) });
      if (model.callActive && version === playbackVersion && session.reply) {
        void voice?.speak(session.reply, session.language ?? language);
      }
      return true;
    } catch (error) {
      if (!recording?.signal.aborted) report(error, source === 'voice' ? 'voice' : 'composer');
      return false;
    } finally {
      update({ busy: false });
    }
  }

  function proposeItem(itemAction) {
    const { type, name, quantity, unit } = itemAction;
    const language = model.language;
    const messages = type === 'add'
      ? { 'en-IN': `Add ${quantity} ${unit} of ${name}.`, 'hi-IN': `${name} जोड़ें (${quantity} ${unit})।`, 'mr-IN': `${name} टाका (${quantity} ${unit}).` }
      : { 'en-IN': `Remove ${name}.`, 'hi-IN': `${name} हटाएँ।`, 'mr-IN': `${name} काढा.` };
    return submit(messages[language], 'typed', itemAction);
  }

  function chooseStock(option) {
    return submit(option.label, 'typed', undefined, { type: option.type });
  }

  async function connect() {
    if (model.busy) return;
    endVoice('');
    update({ busy: true, error: null });
    try {
      const session = guest || accessKey ? await request('/api/session', { language: model.language,
        ...(accessKey ? { storeOrderId: orderId, accessKey } : {}),
      }) : await request('/api/session?' + new URLSearchParams({
        orderId, language: model.language,
      }));
      applySnapshot(session);
      if (!session.voiceEnabled || voice) return;
      const { createVoice } = await import('../../public/voice.js');
      if (lifecycle.signal.aborted) return;
      voice = createVoice({
        getSessionId: () => sessionId,
        onRecording: (recording) => {
          if (model.callActive && ['rules', 'auto'].includes(model.replyProvider)) return submit('', 'voice', undefined, undefined, recording);
        },
        onUtterance: ({ text }) => {
          if (!model.callActive) return;
          return submit(text, 'voice');
        },
        onState: (audioState) => update({ audioState, ...(audioState === 'idle' ? { callActive: false } : {}) }),
        onError: (error) => report(error, 'voice'),
        onLevel: (level) => meter.current?.style.setProperty('--voice-level', String(0.58 + Math.max(0, Math.min(1, level)) * 0.9)),
        onInterrupt: () => {
          playbackVersion += 1;
          update({ notice: 'Agent audio interrupted.' });
        },
      });
      update({ voiceReady: true });
    } catch (error) {
      report(error, 'voice');
    } finally {
      update({ busy: false });
    }
  }

  async function toggleVoice() {
    if (model.callActive) {
      endVoice();
      if (!model.session?.pending && !model.session?.stockOffer) releaseShipping();
      return;
    }
    if (!voice || model.startingMic || model.busy) return;
    const version = playbackVersion;
    holdShipping();
    update({ startingMic: true, error: null });
    try {
      await voice.prepare();
      if (version !== playbackVersion || lifecycle.signal.aborted) return;
      update({ callActive: true });
      await voice.startListening(model.language);
      if (version === playbackVersion) update({ notice: 'Voice call started.' });
    } catch (error) {
      if (version === playbackVersion) {
        endVoice('');
        report(error, 'voice');
      }
    } finally {
      update({ startingMic: false });
    }
  }

  return {
    connect, submit, proposeItem, chooseStock, setLanguage, setReplyProvider, toggleVoice, endVoice, holdShipping, releaseShipping,
    maintainModel, retryModel: checkModel, setInterpretationMode,
    dispose() {
      releaseShipping();
      clearInterval(shippingTimer);
      clearInterval(modelTimer);
      lifecycle.abort();
      voice?.dispose();
      meter.current?.style.removeProperty('--voice-level');
    },
  };
}

export function useDispatch(orderId, onUnauthorized, guest = false, accessKey) {
  const [model, setModel] = useState(initial);
  const meter = useRef(null);
  const desk = useRef(null);
  useEffect(() => {
    const controller = createDesk(setModel, meter, orderId, onUnauthorized, guest, accessKey);
    desk.current = controller;
    const storedLanguage = readPreference('dispatch-desk-language');
    if (storedLanguage) controller.setLanguage(storedLanguage);
    void controller.connect();
    const onPageHide = () => { controller.endVoice(); controller.releaseShipping(); };
    const onVisibility = () => { if (!document.hidden) controller.maintainModel(); };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      controller.dispose();
      desk.current = null;
    };
  }, [orderId, onUnauthorized, guest, accessKey]);
  return { model, meter, desk };
}

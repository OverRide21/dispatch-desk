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
  replySource: null,
};

export function readPreference(key) {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

export function savePreference(key, value) {
  try { window.sessionStorage.setItem(key, value); } catch { /* Storage can be disabled. */ }
}

function createDesk(render, meter, orderId, onUnauthorized) {
  let model = initial;
  let sessionId;
  let voice;
  let playbackVersion = 0;
  const lifecycle = new AbortController();

  function update(changes) {
    if (lifecycle.signal.aborted) return;
    model = { ...model, ...changes };
    render(model);
  }

  function applySnapshot(session) {
    sessionId = session.sessionId;
    const preferred = model.replyProvider ?? readPreference('dispatch-desk-reply-provider');
    const replyProvider = session.replyProviders.includes(preferred) ? preferred : session.replyProviders[0];
    update({ session, replyProvider, replySource: session.replySource ?? null });
  }

  function report(error, area) {
    if (lifecycle.signal.aborted) return;
    if (error.status === 401) {
      endVoice('');
      onUnauthorized();
      return;
    }
    if (error.code === 'order-stale' || error.code === 'order-conflict') {
      endVoice('');
      sessionId = undefined;
      update({ session: null });
    }
    update({ error: {
      text: error.message || String(error),
      area,
      recovery: ['session-stale', 'order-stale', 'order-conflict'].includes(error.code) ? 'Refresh order'
        : error.code === 'session-expired' || !model.session ? 'Reconnect' : null,
    } });
  }

  async function request(path, data) {
    const timeoutMs = data?.replyProvider === 'ollama-dhee' ? 55_000 : 15_000;
    const headers = new Headers();
    if (sessionId) headers.set('X-Session-Id', sessionId);
    if (data !== undefined) headers.set('Content-Type', 'application/json');
    if (data !== undefined && Number.isInteger(model.session?.revision)) {
      headers.set('X-Session-Revision', String(model.session.revision));
    }
    const response = await fetch(path, {
      method: data === undefined ? 'GET' : 'POST',
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
      cache: 'no-store',
      signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(timeoutMs)]),
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
    if (model.busy || !model.session?.replyProviders.includes(replyProvider)) return;
    savePreference('dispatch-desk-reply-provider', replyProvider);
    update({ replyProvider });
  }

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

  async function submit(text, source = 'typed', itemAction) {
    const message = text.trim();
    if (!message || !model.session || model.busy ||
      (source !== 'voice' && (model.startingMic || model.audioState === 'processing'))) return false;
    if (source !== 'voice') stopPlayback();
    const version = playbackVersion;
    const language = model.language;
    update({ busy: true, error: null, notice: model.replyProvider === 'ollama-dhee' ? 'Waiting for Dhee.' : 'Checking the order.' });
    try {
      const session = await request('/api/turn', { text: message, language, replyProvider: model.replyProvider, itemAction });
      applySnapshot(session);
      update({ notice: 'Response received.' });
      if (model.callActive && version === playbackVersion && session.reply) {
        void voice?.speak(session.reply, session.language ?? language);
      }
      return true;
    } catch (error) {
      report(error, source === 'voice' ? 'voice' : 'composer');
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

  async function connect() {
    if (model.busy) return;
    endVoice('');
    update({ busy: true, error: null });
    try {
      const session = await request('/api/session?' + new URLSearchParams({ orderId, language: model.language }));
      applySnapshot(session);
      if (!session.voiceEnabled || voice) return;
      const { createVoice } = await import('../../public/voice.js');
      if (lifecycle.signal.aborted) return;
      voice = createVoice({
        getSessionId: () => sessionId,
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
    if (model.callActive) return endVoice();
    if (!voice || model.startingMic || model.busy) return;
    const version = playbackVersion;
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
    connect, submit, proposeItem, setLanguage, setReplyProvider, toggleVoice, endVoice,
    dispose() {
      lifecycle.abort();
      voice?.dispose();
      meter.current?.style.removeProperty('--voice-level');
    },
  };
}

export function useDispatch(orderId, onUnauthorized) {
  const [model, setModel] = useState(initial);
  const meter = useRef(null);
  const desk = useRef(null);
  useEffect(() => {
    const controller = createDesk(setModel, meter, orderId, onUnauthorized);
    desk.current = controller;
    const storedLanguage = readPreference('dispatch-desk-language');
    if (storedLanguage) controller.setLanguage(storedLanguage);
    void controller.connect();
    const onPageHide = () => controller.endVoice();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      controller.dispose();
      desk.current = null;
    };
  }, [orderId, onUnauthorized]);
  return { model, meter, desk };
}

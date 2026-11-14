import { createSession, handleTurn, routeOrderLookup, shouldInterpretTurn, snapshot, transcriptionKeyterms } from './orders.mjs';
import { interpretOrderTurn } from './order-interpretation.mjs';
import { synthesize, transcribe, voiceAvailable } from './gnani.mjs';
import { ollamaEnabled, personalizeReply, warmOllama } from './ollama.mjs';
import { groqEnabled, selectGroqReply } from './groq.mjs';
import { sarvamEnabled, transcribeWithSarvam } from './sarvam.mjs';
import { authenticate, authConfigured, authLogin, authLogout, assertSameOrigin, localAccessEnabled } from './auth.mjs';
import { getStore } from './store.mjs';
import { inspectOrderImport, parseOrderImport, orderTemplate } from './order-import.mjs';
import { renderOrderReceipt } from './order-receipt.mjs';
import { wavDurationMilliseconds } from './voice-usage.mjs';

const locales = new Set(['mr-IN', 'hi-IN', 'en-IN']);
const uploadLimit = (process.env.VERCEL ? 4 : 5) * 1024 * 1024;
const guest = { workspaceId: 'public-sample', user: 'Guest', sessionId: 'public-sample', role: 'guest' };
const shopper = () => ({ workspaceId: process.env.DISPATCH_WORKSPACE_ID?.trim() || 'default',
  user: 'Store customer', sessionId: 'store-customer', role: 'shopper' });
const guestOrder = {
  id: 'SAMPLE-1048', customer: 'Sample order', revision: 0,
  items: [
    { id: 'rice', name: 'Rice', sku: 'RICE', unit: 'bags', quantity: 24, status: 'pending', limit: 50 },
    { id: 'sugar', name: 'Sugar', sku: 'SUGAR', unit: 'bags', quantity: 8, status: 'shipped' },
    { id: 'oil', name: 'Cooking oil', sku: 'OIL', unit: 'cases', quantity: 6, status: 'pending', limit: 20 },
  ],
};
const responseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

class RequestError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: responseHeaders });
}

function discardBody(request) {
  void request.body?.cancel().catch(() => {});
}

async function readBody(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) {
    discardBody(request);
    throw new RequestError(413, 'This request is too large.');
  }
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new RequestError(413, 'This request is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    discardBody(request);
    throw new RequestError(415, 'Send the message as JSON.');
  }

  try {
    return JSON.parse((await readBody(request, 8_192)).toString('utf8'));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'This message could not be read.');
  }

}

function readText(body, limit = 500) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > limit) {
    throw new RequestError(400, `Enter a message between 1 and ${limit} characters.`);
  }
  if (body.language !== undefined && !locales.has(body.language)) {
    throw new RequestError(400, 'Choose Hindi, Marathi, or English.');
  }
  return { text, language: body.language };
}

function replyProviders(guestCall = false) {
  const groq = groqEnabled();
  return [
    'rules',
    ...(sarvamEnabled() || groq ? ['auto'] : []),
    ...(!guestCall && groq ? ['groq'] : []),
    ...(!guestCall ? ['ollama', 'ollama-hari'].filter(ollamaEnabled) : []),
  ];
}

async function styleOrderReply({ provider, ...input }) {
  if (provider === 'ollama' || provider === 'ollama-hari') return personalizeReply({ provider, ...input });
  if (provider === 'groq') {
    const reply = await selectGroqReply(input);
    if (reply) return { reply, source: 'groq' };
  }
  return { reply: input.reply, source: 'rules' };
}

function sessionData(session) {
  const providers = replyProviders(/^(?:guest|shopper)-/u.test(session.id));
  const sarvamSpeech = process.env.DISPATCH_STT_PROVIDER === 'sarvam';
  return {
    sessionId: session.id,
    revision: session.revision,
    voiceEnabled: voiceAvailable() && (!sarvamSpeech || sarvamEnabled()),
    voiceAutoLanguage: sarvamSpeech || process.env.GNANI_STT_MODEL !== 'prisma-v2.5',
    ollamaEnabled: ollamaEnabled(),
    replyProviders: providers,
    defaultReplyProvider: providers.includes('auto') ? 'auto' : 'rules',
    ...snapshot(session.state),
  };
}

function assertRevision(session, request) {
  const revision = request.headers.get('x-session-revision');
  if (revision === null || revision === String(session.revision)) return;
  discardBody(request);
  throw new RequestError(409, 'The call changed in another tab. Review the latest order and try again.', 'session-stale');
}

function reportFailure(operation, status) {
  console.warn(JSON.stringify({ event: 'dispatch_operation_failed', operation, status }));
}

function requestError(error) {
  if (error instanceof RequestError || (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600)) {
    return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
  }
  console.error('Dispatch Desk request failed:', error?.name ?? 'Error');
  return json({ error: 'Something went wrong. Please try again.' }, 500);
}

async function voiceRoute(request, action, { db, actor, session }) {
  const sarvamSpeech = action === 'transcribe' && process.env.DISPATCH_STT_PROVIDER === 'sarvam';
  if (sarvamSpeech ? !sarvamEnabled() : !voiceAvailable()) {
    discardBody(request);
    throw new RequestError(503, `Live voice needs a ${sarvamSpeech ? 'Sarvam' : 'Gnani'} API key. You can still type to the desk.`);
  }
  const cancellation = new AbortController();
  const timeout = AbortSignal.timeout(25_000);
  const signal = AbortSignal.any([request.signal, cancellation.signal, timeout]);
  try {
    if (action === 'transcribe') {
      const language = request.headers.get('x-language');
      if (language && language !== 'indic-auto' && !locales.has(language)) {
        discardBody(request);
        throw new RequestError(400, 'Choose Hindi, Marathi, or English.');
      }
      const input = await readBody(request, 1_048_576);
      const transcriptionMilliseconds = wavDurationMilliseconds(input);
      signal.throwIfAborted();
      await db.voiceUsage.reserve(actor.workspaceId, session.id, { transcriptionMilliseconds });
      if (sarvamSpeech) {
        const keyterms = transcriptionKeyterms(session.state.order.items, language);
        return await transcribeWithSarvam(input, { language, keyterms, signal });
      }
      return await transcribe(input, { language, signal });
    }

    const { text, language } = readText(await readJson(request), 1_500);
    const reply = session.state.messages.at(-1);
    if (reply?.role !== 'agent' || reply.text !== text || reply.language !== language) {
      throw new RequestError(409, 'Only the current desk reply can be played.');
    }
    signal.throwIfAborted();
    await db.voiceUsage.reserve(actor.workspaceId, session.id, { synthesisCharacters: [...text].length });
    const audio = await synthesize(text, { language, signal });
    const headers = { ...responseHeaders, 'Content-Type': audio.contentType };
    if (audio.sampleRate) headers['X-Sample-Rate'] = audio.sampleRate;

    const reader = audio.body.getReader();
    let cancelled = false;
    return new Response(new ReadableStream({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (cancelled) return;
          if (done) {
            reader.releaseLock();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          if (cancelled) return;
          if (!request.signal.aborted) reportFailure('voice.stream', 502);
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        cancelled = true;
        cancellation.abort(reason);
        await reader.cancel(reason).catch(() => {});
        reader.releaseLock();
      },
    }), { headers });
  } catch (error) {
    if (error instanceof RequestError || ['voice-budget-exhausted', 'voice-invalid-wav'].includes(error?.code)) throw error;
    if (request.signal.aborted) {
      throw new RequestError(408, 'The voice request was cancelled.');
    }
    if (timeout.aborted || error?.status === 504) {
      throw new RequestError(504, 'The voice service took too long. Please try again or type your message.');
    }
    const provider = sarvamSpeech ? 'Sarvam' : 'Gnani';
    const failures = {
      429: `${provider} voice is busy. Wait a moment, or type your message.`,
      503: `${provider} voice is unavailable. Check your key, credits, and model access, or use text.`,
    };
    const status = Object.hasOwn(failures, error?.status) ? error.status : 502;
    throw new RequestError(status, failures[status] || `The voice service could not finish this turn. Check the ${provider} key and credits, or use text.`);
  }
}

function publicUser(actor) {
  return actor ? { name: actor.user, role: actor.role } : null;
}

function shopEnabled() {
  return process.env.DISPATCH_STOREFRONT_ENABLED === '1';
}

async function requireOrder(store, workspaceId, id) {
  const order = await store.getOrder(workspaceId, id);
  if (!order) throw new RequestError(404, 'Order not found.');
  return order;
}

function refreshOrder(session, order) {
  if (session.state.order.revision === order.revision) return;
  const { history, ...record } = order;
  Object.assign(session.state, { order: record, history, pending: null, stockOffer: null, focus: null });
  session.revision++;
}

function encodedHeader(request, key, limit) {
  const value = request.headers.get(key);
  if (!value) return undefined;
  if (value.length > limit) throw new RequestError(400, 'An upload header is too long.');
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RequestError(400, 'An upload header could not be read.');
  }
}

export function createDispatchHandlers({
  store = null, identify = authenticate,
  styleReply = styleOrderReply, warmReplyModel = warmOllama, interpret = interpretOrderTurn,
} = {}) {
  const database = () => store ?? getStore();
  const protectedRoute = (action, { sessionRequired = false, guestAllowed = false, lock = false, admin = false, operation } = {}) => async (request) => {
    let db;
    let session;
    try {
      if (request.method !== 'GET') assertSameOrigin(request);
      db = await database();
      const id = request.headers.get('x-session-id');
      const actor = guestAllowed && id?.startsWith('guest-') ? guest
        : guestAllowed && id?.startsWith('shopper-') ? shopper() : await identify(request, db);
      if (!actor) throw new RequestError(401, 'Sign in to continue.', 'sign-in-required');
      if (admin && actor.role !== 'admin') throw new RequestError(403, 'Only administrators can import orders.');
      if (sessionRequired) {
        session = lock ? await db.lockCall(id, actor) : await db.getCall(id, actor);
        if (!session) {
          if (lock && await db.getCall(id, actor)) {
            throw new RequestError(409, 'Wait for the current reply, then try again.', 'session-busy');
          }
          throw new RequestError(409, 'This call has expired. Reopen the order to continue.', 'session-expired');
        }
      }
      return await action(request, { db, actor, session });
    } catch (error) {
      discardBody(request);
      if (operation && error?.status !== 408 && (error?.status >= 409 || !error?.status)) {
        reportFailure(operation, error?.status ?? 500);
      }
      return requestError(error);
    } finally {
      if (session?.lock) await db.unlockCall(session).catch(() => {});
    }
  };
  const publicActor = actor => actor === guest || actor.role === 'shopper';
  const requestLimitKey = (actor, session) => publicActor(actor) ? session.id : actor.sessionId;
  const reserveGuestRequests = async (db, actor, kind) => {
    if (!publicActor(actor)) return;
    if (!await db.rateLimit('public-sample:' + kind, 60, 60_000)) {
      throw new RequestError(429, 'The public sample is busy. Please try again in a minute.');
    }
    if (kind !== 'new-calls' && !await db.rateLimit('public-sample:daily:' + kind, 600, 86_400_000)) {
      throw new RequestError(429, 'The public sample reached its daily AI usage limit. Try Fast mode or return later.');
    }
  };
  const speechRoute = (action) => protectedRoute(async (request, { db, actor, session }) => {
    if (!await db.rateLimit('voice:' + requestLimitKey(actor, session), 40, 60_000)) {
      throw new RequestError(429, 'Voice request limit reached. Wait a moment or continue by text.');
    }
    await reserveGuestRequests(db, actor, 'voice');
    const result = await voiceRoute(request, action, { db, actor, session });
    return action === 'transcribe' ? json(result) : result;
  }, { sessionRequired: true, guestAllowed: true, operation: `voice.${action}` });
  const manageCatalog = action => protectedRoute(async (request, context) => {
    if (context.actor.role !== 'admin') throw new RequestError(403, 'Only administrators can manage stock.');
    return action(request, context);
  }, { operation: 'catalog.manage' });

  return {
    async guestSession(request) {
      try {
        assertSameOrigin(request);
        const { language, storeOrderId, accessKey } = await readJson(request) ?? {};
        if (language !== undefined && !locales.has(language)) throw new RequestError(400, 'Choose Hindi, Marathi, or English.');
        const db = await database();
        if (storeOrderId !== undefined || accessKey !== undefined) {
          const actor = shopper();
          await reserveGuestRequests(db, actor, 'order-access');
          if (!await db.canAccessShopOrder(actor.workspaceId, storeOrderId, accessKey)) {
            throw new RequestError(404, 'This order is unavailable. Open it in the browser tab used for checkout.', 'shop-order-unavailable');
          }
          const order = await requireOrder(db, actor.workspaceId, storeOrderId);
          if (order.source !== 'storefront') throw new RequestError(404, 'This store order is unavailable.');
          const previous = await db.getCall(request.headers.get('x-session-id'), actor);
          if (previous?.state.order.id === order.id && previous.state.order.revision === order.revision) return json(sessionData(previous));
          return json(sessionData(await db.createCall(actor, createSession(order, language))));
        }
        const previous = await db.getCall(request.headers.get('x-session-id'), guest);
        if (previous) return json(sessionData(previous));
        await reserveGuestRequests(db, guest, 'new-calls');
        return json(sessionData(await db.createCall(guest, createSession(guestOrder, language))));
      } catch (error) {
        return requestError(error);
      }
    },
    async auth(request) {
      try {
        const localAccess = localAccessEnabled(request);
        const configured = localAccess || authConfigured();
        return json({ configured, user: configured ? publicUser(await identify(request, await database())) : null,
          maxImportBytes: uploadLimit, shopEnabled: shopEnabled(), localAccess });
      } catch (error) {
        return requestError(error);
      }
    },
    async signIn(request) {
      try {
        assertSameOrigin(request);
        return await authLogin(request, await database());
      } catch (error) {
        return requestError(error);
      }
    },
    async signOut(request) {
      try {
        assertSameOrigin(request);
        const db = await database();
        const actor = await identify(request, db);
        if (actor) await db.deleteCalls(actor.sessionId);
        return await authLogout(request, db);
      } catch (error) {
        return requestError(error);
      }
    },
    orders: protectedRoute(async (request, { db, actor }) => {
      const query = new URL(request.url).searchParams.get('q')?.trim().slice(0, 120);
      return json({ orders: await db.listOrders(actor.workspaceId, { query, limit: 100 }) });
    }),
    catalog: manageCatalog(async (_request, { db, actor }) => {
      return json({ products: await db.listProducts(actor.workspaceId) });
    }),
    saveProduct: manageCatalog(async (request, { db, actor }) => {
      return json({ product: await db.saveProduct(actor.workspaceId, await readJson(request)) });
    }),
    addStock: manageCatalog(async (request, { db, actor }) => {
      const body = await readJson(request);
      return json({ product: await db.addStock(actor.workspaceId, body?.sku, body?.quantity, body?.requestId) });
    }),
    async shop(request) {
      try {
        if (!shopEnabled()) throw new RequestError(404, 'The storefront is currently closed.', 'shop-disabled');
        const workspaceId = process.env.DISPATCH_WORKSPACE_ID?.trim() || 'default';
        if (request.method === 'GET') {
          const products = await (await database()).listProducts(workspaceId);
          return json({ products: products.map(({ sku, name, nameHi, nameMr, unit, category, pricePaise, stock }) =>
            ({ sku, name, nameHi, nameMr, unit, category, pricePaise, stock })) });
        }
        assertSameOrigin(request);
        const input = await readJson(request);
        const db = await database();
        if (!await db.rateLimit('shop:' + workspaceId, 30, 60_000)) {
          throw new RequestError(429, 'The storefront is busy. Wait a minute and try again.', 'shop-busy');
        }
        return json(await db.placeShopOrder(workspaceId, input), 201);
      } catch (error) {
        discardBody(request);
        return requestError(error);
      }
    },
    receipts: protectedRoute(async (request, { db, actor }) => {
      const params = new URL(request.url).searchParams;
      const orderId = params.get('orderId');
      if (!orderId || orderId.length > 120) throw new RequestError(400, 'Choose an order first.');
      await requireOrder(db, actor.workspaceId, orderId);
      const receiptId = params.get('receiptId');
      if (receiptId === null) return json({ receipts: await db.getOrderReceipts(actor.workspaceId, orderId) });
      if (!receiptId || receiptId.length > 100) throw new RequestError(404, 'Receipt not found.');
      const [receipt] = await db.getOrderReceipts(actor.workspaceId, orderId, { id: receiptId });
      if (!receipt) throw new RequestError(404, 'Receipt not found.');
      const language = params.get('language') ?? undefined;
      if (language && !locales.has(language)) throw new RequestError(400, 'Choose a receipt language.');
      return new Response(renderOrderReceipt(receipt, language), { headers: {
        ...responseHeaders,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      } });
    }),
    voiceUsage: protectedRoute(async (request, { db, actor }) => {
      const sessionId = request.headers.get('x-session-id');
      if (sessionId && !await db.getCall(sessionId, actor)) {
        throw new RequestError(404, 'Voice usage for this call could not be found.');
      }
      return json(await db.voiceUsage.summary(actor.workspaceId, sessionId));
    }),
    saveVoiceUsage: protectedRoute(async (request, { db, actor }) => {
      if (actor.role !== 'admin') throw new RequestError(403, 'Only administrators can edit voice budgets.');
      await db.voiceUsage.setLimits(actor.workspaceId, await readJson(request));
      return json(await db.voiceUsage.summary(actor.workspaceId));
    }),
    session: protectedRoute(async (request, { db, actor }) => {
      const params = new URL(request.url).searchParams;
      const orderId = params.get('orderId');
      if (!orderId || orderId.length > 120) throw new RequestError(400, 'Choose an order first.');
      const language = params.get('language') ?? undefined;
      if (language !== undefined && !locales.has(language)) throw new RequestError(400, 'Choose Hindi, Marathi, or English.');
      const order = await requireOrder(db, actor.workspaceId, orderId);
      let session = await db.getCall(request.headers.get('x-session-id'), actor);
      if (!session || session.state.order.id !== order.id || session.state.order.revision !== order.revision) {
        session = await db.createCall(actor, createSession(order, language));
      } else if (order.source === 'storefront') {
        const { history, ...record } = order;
        session.state.order = record;
      }
      return json(sessionData(session));
    }),
    warmModel: protectedRoute(async (request, { db, actor }) => {
      const { provider } = await readJson(request) ?? {};
      if (!['ollama', 'ollama-hari'].includes(provider) || !ollamaEnabled(provider)) {
        throw new RequestError(400, 'Choose an available local reply model.');
      }
      if (!await db.rateLimit('model-warmup:' + actor.sessionId, 30, 60_000)) {
        throw new RequestError(429, 'Too many model checks. Wait a moment and retry.');
      }
      const ready = await warmReplyModel(provider);
      if (!ready) throw new RequestError(503, 'Could not warm up this model. Check Ollama, then retry.', 'model-unavailable');
      return json({ provider, ready });
    }, { operation: 'model.warmup' }),
    shipping: protectedRoute(async (request, { db, actor, session }) => {
      const { id, source } = session.state.order;
      if (source !== 'storefront') return json({ holdUntil: null });
      if (request.method !== 'GET') await db.setShippingHold(session, request.method === 'POST');
      const [order, holdUntil] = await Promise.all([
        requireOrder(db, actor.workspaceId, id),
        db.shippingHoldUntil(actor.workspaceId, id),
      ]);
      const revision = new URL(request.url).searchParams.get('revision');
      return json({ holdUntil, ...(String(order.revision) !== revision ? { order } : {}) });
    }, { sessionRequired: true, guestAllowed: true, operation: 'order.shipping' }),
    turn: protectedRoute(async (request, { db, actor, session }) => {
      assertRevision(session, request);
      const audio = request.headers.get('content-type')?.split(';')[0].trim() === 'audio/wav';
      const providers = replyProviders(publicActor(actor));
      const audioProvider = audio ? request.headers.get('x-reply-provider') ?? 'rules' : null;
      if (audio && (!['rules', 'auto'].includes(audioProvider) || !providers.includes(audioProvider))) {
        discardBody(request);
        throw new RequestError(400, 'Choose an available voice provider.');
      }
      if (audio && !await db.rateLimit('voice:' + requestLimitKey(actor, session), 40, 60_000)) {
        throw new RequestError(429, 'Voice request limit reached. Wait a moment or continue by text.');
      }
      if (audio) await reserveGuestRequests(db, actor, 'voice');
      const body = audio
        ? { ...await voiceRoute(request, 'transcribe', { db, actor, session }), replyProvider: audioProvider }
        : await readJson(request);
      if (audio && !body.text) throw new RequestError(422, 'I could not catch that. Try speaking a little closer to the microphone.');
      const input = readText(body);
      if (body.itemAction !== undefined && !['add', 'remove'].includes(body.itemAction?.type)) {
        throw new RequestError(400, 'Choose an item action.');
      }
      if (body.stockAction !== undefined && (body.itemAction !== undefined ||
          !['partial', 'backorder', 'substitute'].includes(body.stockAction?.type))) {
        throw new RequestError(400, 'Choose a stock option.');
      }
      const provider = body.replyProvider ?? providers[0];
      if (!providers.includes(provider)) throw new RequestError(400, 'Choose an available reply provider.');
      const interpretationMode = body.interpretationMode ?? 'parser';
      const automatic = provider === 'auto';
      if (!['parser', 'llm'].includes(interpretationMode) || (interpretationMode === 'llm' && provider === 'rules')) {
        throw new RequestError(400, 'Choose an available model for LLM interpretation.');
      }
      if (request.signal.aborted) throw new RequestError(408, 'The message was cancelled.');
      const order = actor === guest ? session.state.order : await requireOrder(db, actor.workspaceId, session.state.order.id);
      if (session.state.order.revision !== order.revision) {
        refreshOrder(session, order);
        await db.saveCall(session);
        delete session.lock;
        throw new RequestError(409, 'The order changed. Refresh and review it before continuing.', 'order-stale');
      }
      const previousReply = session.state.messages.at(-1)?.text;
      const candidate = structuredClone(session.state);
      if (order.source === 'storefront') {
        const { history, ...record } = order;
        candidate.order = record;
      }
      const turnInput = { ...input, itemAction: body.itemAction, stockAction: body.stockAction };
      const usesModels = automatic || interpretationMode === 'llm';
      const shouldInterpret = usesModels && shouldInterpretTurn(candidate, turnInput);
      let interpretation = automatic && shouldInterpret ? routeOrderLookup(candidate.order, input.text) : null;
      let interpretationSource = interpretation ? 'order-data' : usesModels ? 'controls' : 'parser';
      if (shouldInterpret && !interpretation) {
        if (!await db.rateLimit('model-interpretation:' + requestLimitKey(actor, session), 40, 60_000)) {
          throw new RequestError(429, 'Too many model requests. Wait a moment or switch to the built-in parser.');
        }
        await reserveGuestRequests(db, actor, 'model');
        const modelInput = { text: input.text, session: candidate, signal: request.signal };
        interpretationSource = automatic ? (sarvamEnabled() ? 'sarvam' : 'groq') : provider;
        interpretation = await interpret({ ...modelInput, provider: interpretationSource });
        if (interpretationSource === 'sarvam' && !interpretation && !request.signal.aborted && groqEnabled()) {
          interpretationSource = 'groq';
          interpretation = await interpret({ ...modelInput, provider: 'groq' });
        }
        if (request.signal.aborted) throw new RequestError(408, 'The message was cancelled.');
        if (!interpretation) {
          throw new RequestError(503, 'The model could not interpret this request. Try again or switch to the built-in parser.', 'interpretation-unavailable');
        }
      }
      const { choices, change, rejectedChange, ...result } = handleTurn(candidate, { ...turnInput, interpretation });
      const styleEnabled = !automatic && interpretationMode === 'parser' && provider !== 'rules';
      const requireHari = styleEnabled && provider === 'ollama-hari';
      const variants = requireHari && choices
        ? choices.options.map(option => [choices.prefix, option.replace('{amount}', () => choices.amount)].filter(Boolean).join(' '))
        : [];
      async function styleTurn() {
        try {
          const styled = await styleReply({
            provider,
            choices,
            variants,
            rejectedChange,
            text: input.text,
            reply: result.reply,
            language: result.language,
            previousReply,
            signal: request.signal,
          });
          if (!request.signal.aborted && provider !== 'rules' && styled?.source === provider &&
              typeof styled.reply === 'string' &&
              (provider === 'groq' || variants.includes(styled.reply) || styled.reply.endsWith(result.reply))) {
            return styled;
          }
        } catch {
          // A provider failure is handled below according to the selected provider.
        }
        return null;
      }
      const hariReply = requireHari ? await styleTurn() : null;
      if (requireHari && !hariReply) {
        if (request.signal.aborted) throw new RequestError(408, 'The message was cancelled.');
        throw new RequestError(503, 'Hari could not finish the reply. Check that Ollama is running, then retry.', 'hari-unavailable');
      }
      let receipt;
      if (change && actor === guest) {
        candidate.order.revision++;
        candidate.blockedRequests = [];
      } else if (change) {
        const saved = await db.saveQuantity(actor.workspaceId, order.id, {
          itemId: change.itemId, quantity: change.to, newItem: change.newItem, revision: order.revision, actor: actor.user,
          backorderQuantity: change.backorderQuantity, updates: change.updates,
          receipt: { language: result.language, blockedRequests: candidate.blockedRequests ?? [] },
        });
        const { history, receipt: savedReceipt, ...record } = saved;
        receipt = savedReceipt;
        candidate.order = record;
        candidate.history = history;
        candidate.blockedRequests = [];
      }
      session.state = candidate;
      session.revision++;
      const styled = !styleEnabled ? null : requireHari ? hariReply : await styleTurn();
      const reply = styled?.reply ?? result.reply;
      session.state.messages.at(-1).text = reply;
      await db.saveCall(session);
      delete session.lock;
      return json({
        ...sessionData(session),
        ...result,
        reply,
        replySource: styled?.source ?? 'rules',
        interpretationSource,
        ...(receipt ? { receipt } : {}),
      });
    }, { sessionRequired: true, guestAllowed: true, lock: true, operation: 'order.turn' }),
    transcribe: speechRoute('transcribe'),
    speak: speechRoute('speak'),
    imports: protectedRoute(async (request, { db, actor }) => {
      const query = new URL(request.url).searchParams;
      const phase = query.get('phase');
      if (phase === 'commit') {
        const input = await readJson(request);
        if (typeof input?.importId !== 'string' || input.importId.length > 100) throw new RequestError(400, 'Choose an import preview.');
        return json(await db.commitImport(actor.workspaceId, actor.user, input.importId));
      }
      if (phase !== 'inspect' && phase !== 'preview') throw new RequestError(400, 'Choose an import step.');
      const filename = encodedHeader(request, 'x-filename', 1_024);
      if (!filename || filename.length > 255) throw new RequestError(400, 'Choose a CSV, Excel, or JSON file.');
      const bytes = await readBody(request, uploadLimit);
      const sheet = query.get('sheet') || undefined;
      if (phase === 'inspect') return json(await inspectOrderImport({ filename, bytes, sheet }));
      const serialized = encodedHeader(request, 'x-column-mapping', 8_192);
      let mapping;
      if (serialized !== undefined) {
        try {
          mapping = JSON.parse(serialized);
          if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error();
        } catch {
          throw new RequestError(400, 'The column mapping could not be read.');
        }
      }
      const { orders, errors } = await parseOrderImport({ filename, bytes, sheet, mapping });
      if (errors.length) {
        reportFailure('order.import.validation', 422);
        return json({ errors, importId: null, counts: { created: 0, updated: 0, unchanged: 0, conflicts: 0 }, changes: [] });
      }
      return json({ errors: [], ...await db.previewImport(actor.workspaceId, actor.user, orders) });
    }, { admin: true, operation: 'order.import' }),
    template: protectedRoute(async (request) => {
      const format = new URL(request.url).searchParams.get('format');
      if (!['csv', 'xlsx', 'json'].includes(format)) throw new RequestError(400, 'Choose CSV, Excel, or JSON.');
      const { filename, contentType, bytes } = await orderTemplate(format);
      return new Response(bytes, {
        headers: { ...responseHeaders, 'Content-Type': contentType, 'Content-Disposition': `attachment; filename="${filename}"` },
      });
    }, { admin: true }),
  };
}

export const dispatchHandlers = createDispatchHandlers();

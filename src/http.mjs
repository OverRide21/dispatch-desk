import { createSession, handleTurn, snapshot } from './orders.mjs';
import { synthesize, transcribe, voiceAvailable } from './gnani.mjs';
import { ollamaEnabled, personalizeReply, warmOllama } from './ollama.mjs';
import { groqEnabled, selectGroqReply } from './groq.mjs';
import { authenticate, authConfigured, authLogin, authLogout, assertSameOrigin } from './auth.mjs';
import { getStore } from './store.mjs';
import { inspectOrderImport, parseOrderImport, orderTemplate } from './order-import.mjs';

const locales = new Set(['mr-IN', 'hi-IN', 'en-IN']);
const uploadLimit = (process.env.VERCEL ? 4 : 5) * 1024 * 1024;
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

function readText(body) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 500) {
    throw new RequestError(400, 'Enter a message between 1 and 500 characters.');
  }
  if (body.language !== undefined && !locales.has(body.language)) {
    throw new RequestError(400, 'Choose Hindi, Marathi, or English.');
  }
  return { text, language: body.language };
}

function replyProviders() {
  return [
    ...(groqEnabled() ? ['groq'] : []),
    ...['ollama', 'ollama-dhee'].filter(ollamaEnabled),
    'rules',
  ];
}

async function styleOrderReply({ provider, ...input }) {
  if (provider === 'ollama' || provider === 'ollama-dhee') return personalizeReply({ provider, ...input });
  if (provider === 'groq') {
    const reply = await selectGroqReply(input);
    if (reply) return { reply, source: 'groq' };
  }
  return { reply: input.reply, source: 'rules' };
}

function sessionData(session) {
  return {
    sessionId: session.id,
    revision: session.revision,
    voiceEnabled: voiceAvailable(),
    voiceAutoLanguage: process.env.GNANI_STT_MODEL !== 'prisma-v2.5',
    ollamaEnabled: ollamaEnabled(),
    replyProviders: replyProviders(),
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

async function voiceRoute(request, action, session) {
  if (!voiceAvailable()) {
    discardBody(request);
    throw new RequestError(503, 'Live voice needs a Gnani API key. You can still type to the desk.');
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
      if (input.length < 44 || input.toString('ascii', 0, 4) !== 'RIFF' ||
          input.toString('ascii', 8, 12) !== 'WAVE') {
        throw new RequestError(400, 'Send a valid WAV recording.');
      }
      return json(await transcribe(input, { language, signal }));
    }

    const { text, language } = readText(await readJson(request));
    const reply = session.state.messages.at(-1);
    if (reply?.role !== 'agent' || reply.text !== text || reply.language !== language) {
      throw new RequestError(409, 'Only the current desk reply can be played.');
    }
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
    if (error instanceof RequestError) throw error;
    if (request.signal.aborted) {
      throw new RequestError(408, 'The voice request was cancelled.');
    }
    if (timeout.aborted || error?.status === 504) {
      throw new RequestError(504, 'The voice service took too long. Please try again or type your message.');
    }
    const failures = {
      429: 'Gnani voice is busy. Wait a moment, or type your message.',
      503: 'Gnani rejected the configured key or model. Check your access, or use text.',
    };
    const status = Object.hasOwn(failures, error?.status) ? error.status : 502;
    throw new RequestError(status, failures[status] || 'The voice service could not finish this turn. Check the Gnani key and credits, or use text.');
  }
}

function publicUser(actor) {
  return actor ? { name: actor.user, role: actor.role } : null;
}

async function requireOrder(store, workspaceId, id) {
  const order = await store.getOrder(workspaceId, id);
  if (!order) throw new RequestError(404, 'Order not found.');
  return order;
}

function refreshOrder(session, order) {
  if (session.state.order.revision === order.revision) return;
  const { history, ...record } = order;
  Object.assign(session.state, { order: record, history, pending: null, focus: null });
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
  styleReply = styleOrderReply, warmReplyModel = () => {},
} = {}) {
  const database = () => store ?? getStore();
  const protectedRoute = (action, { sessionRequired = false, lock = false, admin = false, operation } = {}) => async (request) => {
    let db;
    let session;
    try {
      if (request.method !== 'GET') assertSameOrigin(request);
      db = await database();
      const actor = await identify(request, db);
      if (!actor) throw new RequestError(401, 'Sign in to continue.', 'sign-in-required');
      if (admin && actor.role !== 'admin') throw new RequestError(403, 'Only administrators can import orders.');
      if (sessionRequired) {
        const id = request.headers.get('x-session-id');
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
  const speechRoute = (action) => protectedRoute(async (request, { db, actor, session }) => {
    if (!await db.rateLimit('voice:' + actor.sessionId, 40, 60_000)) {
      throw new RequestError(429, 'Voice request limit reached. Wait a moment or continue by text.');
    }
    return voiceRoute(request, action, session);
  }, { sessionRequired: true, operation: `voice.${action}` });

  return {
    async auth(request) {
      try {
        const configured = authConfigured();
        return json({ configured, user: configured ? publicUser(await identify(request, await database())) : null, maxImportBytes: uploadLimit });
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
      }
      void warmReplyModel();
      return json(sessionData(session));
    }),
    turn: protectedRoute(async (request, { db, actor, session }) => {
      assertRevision(session, request);
      const body = await readJson(request);
      const input = readText(body);
      if (body.itemAction !== undefined && !['add', 'remove'].includes(body.itemAction?.type)) {
        throw new RequestError(400, 'Choose an item action.');
      }
      const providers = replyProviders();
      const provider = body.replyProvider ?? providers[0];
      if (!providers.includes(provider)) throw new RequestError(400, 'Choose an available reply provider.');
      if (request.signal.aborted) throw new RequestError(408, 'The message was cancelled.');
      const order = await requireOrder(db, actor.workspaceId, session.state.order.id);
      if (session.state.order.revision !== order.revision) {
        refreshOrder(session, order);
        await db.saveCall(session);
        delete session.lock;
        throw new RequestError(409, 'The order changed. Refresh and review it before continuing.', 'order-stale');
      }
      const previousReply = session.state.messages.at(-1)?.text;
      const candidate = structuredClone(session.state);
      const { choices, change, rejectedChange, ...result } = handleTurn(candidate, { ...input, itemAction: body.itemAction });
      const requireDhee = provider === 'ollama-dhee';
      const variants = requireDhee && choices
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
      const dheeReply = requireDhee ? await styleTurn() : null;
      if (requireDhee && !dheeReply) {
        if (request.signal.aborted) throw new RequestError(408, 'The message was cancelled.');
        throw new RequestError(503, 'Dhee could not finish the reply. Check that Ollama is running, then retry.', 'dhee-unavailable');
      }
      if (change) {
        const saved = await db.saveQuantity(actor.workspaceId, order.id, {
          itemId: change.itemId, quantity: change.to, newItem: change.newItem, revision: order.revision, actor: actor.user,
        });
        const { history, ...record } = saved;
        candidate.order = record;
        candidate.history = history;
      }
      session.state = candidate;
      session.revision++;
      const styled = requireDhee ? dheeReply : await styleTurn();
      const reply = styled?.reply ?? result.reply;
      session.state.messages.at(-1).text = reply;
      await db.saveCall(session);
      delete session.lock;
      return json({
        ...sessionData(session),
        ...result,
        reply,
        replySource: styled?.source ?? 'rules',
      });
    }, { sessionRequired: true, lock: true, operation: 'order.turn' }),
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

export const dispatchHandlers = createDispatchHandlers({ warmReplyModel: warmOllama });

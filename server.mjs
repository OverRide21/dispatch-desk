import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createSession, handleTurn, snapshot } from './src/orders.mjs';
import { synthesize, transcribe, voiceAvailable } from './src/gnani.mjs';

const locales = new Set(['mr-IN', 'hi-IN', 'en-IN']);
const fileTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);
const sessionLifetime = 2 * 60 * 60 * 1000;
const sessionLimit = 150;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    throw new RequestError(413, 'This request is too large.');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new RequestError(413, 'This request is too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readText(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    request.resume();
    throw new RequestError(415, 'Send the message as JSON.');
  }

  let body;
  try {
    body = JSON.parse((await readBody(request, 8_192)).toString('utf8'));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'This message could not be read.');
  }

  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 500) {
    throw new RequestError(400, 'Enter a message between 1 and 500 characters.');
  }
  if (body.language !== undefined && !locales.has(body.language)) {
    throw new RequestError(400, 'Choose Hindi, Marathi, or English.');
  }
  return { text, language: body.language };
}

function lookupSession(sessions, id) {
  const now = Date.now();
  for (const [key, value] of sessions) {
    if (now - value.seenAt > sessionLifetime) sessions.delete(key);
  }
  const session = sessions.get(id);
  if (session) session.seenAt = now;
  return session;
}

function newSession(sessions) {
  if (sessions.size >= sessionLimit) {
    throw new RequestError(503, 'The demo is busy. Please try again shortly.');
  }
  const id = randomUUID();
  const session = { id, state: createSession(), seenAt: Date.now() };
  sessions.set(id, session);
  return session;
}

function sessionData(session) {
  return {
    sessionId: session.id,
    voiceEnabled: voiceAvailable(),
    voiceAutoLanguage: process.env.GNANI_STT_MODEL !== 'prisma-v2.5',
    ...snapshot(session.state),
  };
}

function ensureVoice() {
  if (!voiceAvailable()) {
    throw new RequestError(503, 'Live voice needs a Gnani API key. You can still type to the desk.');
  }
}

async function voiceRoute(request, response, path) {
  ensureVoice();
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  response.once('close', abort);
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(25_000)]);
  try {
    if (path === '/api/voice/transcribe') {
      const language = request.headers['x-language'];
      if (language && language !== 'indic-auto' && !locales.has(language)) {
        throw new RequestError(400, 'Choose Hindi, Marathi, or English.');
      }
      const input = await readBody(request, 1_048_576);
      if (input.length < 44 || input.toString('ascii', 0, 4) !== 'RIFF' ||
          input.toString('ascii', 8, 12) !== 'WAVE') {
        throw new RequestError(400, 'Send a valid WAV recording.');
      }
      json(response, 200, await transcribe(input, { language, signal }));
      return;
    }

    const { text, language } = await readText(request);
    const audio = await synthesize(text, { language, signal });
    const headers = { 'Content-Type': audio.contentType };
    if (audio.sampleRate) headers['X-Sample-Rate'] = audio.sampleRate;
    response.writeHead(200, headers);
    await pipeline(Readable.fromWeb(audio.body), response, { signal });
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (response.headersSent || response.destroyed) return;
    const timeout = (signal.aborted && !cancellation.signal.aborted) || error.status === 504;
    const failures = {
      429: 'Gnani voice is busy. Wait a moment, or type your message.',
      503: 'Gnani rejected the configured key or model. Check your access, or use text.',
    };
    const status = timeout ? 504 : (failures[error.status] ? error.status : 502);
    throw new RequestError(status, timeout
      ? 'The voice service took too long. Please try again or type your message.'
      : failures[status] || 'The voice service could not finish this turn. Check the Gnani key and credits, or use text.');
  } finally {
    response.off('close', abort);
  }
}

async function serveFile(response, path) {
  const file = path === '/' ? '/index.html' : path;
  const extension = file.slice(file.lastIndexOf('.'));
  const type = fileTypes.get(extension);
  if (!type || !/^\/[\w-]+\.[a-z]+$/.test(file)) {
    throw new RequestError(404, 'This page was not found.');
  }
  let contents;
  try {
    contents = await readFile(new URL(`./public${file}`, import.meta.url));
  } catch (error) {
    if (error.code === 'ENOENT') throw new RequestError(404, 'This page was not found.');
    throw error;
  }
  response.writeHead(200, { 'Content-Type': type });
  response.end(contents);
}

export function createDispatchServer() {
  const sessions = new Map();
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const method = request.method;
      if (path === '/api/session' && method === 'GET') {
        const session = lookupSession(sessions, request.headers['x-session-id']) ?? newSession(sessions);
        return json(response, 200, sessionData(session));
      }
      const knownPost = ['/api/turn', '/api/reset', '/api/voice/transcribe', '/api/voice/speak'];
      if (method === 'POST' && knownPost.includes(path)) {
        const session = lookupSession(sessions, request.headers['x-session-id']);
        if (!session) throw new RequestError(409, 'Your session expired. Refresh the page to start a new call.');
        if (path === '/api/turn') {
          const input = await readText(request);
          const result = handleTurn(session.state, input);
          return json(response, 200, { ...sessionData(session), ...result });
        }
        if (path === '/api/reset') {
          request.resume();
          session.state = createSession();
          return json(response, 200, sessionData(session));
        }
        await voiceRoute(request, response, path);
        return;
      }
      if (path.startsWith('/api/')) throw new RequestError(404, 'This endpoint was not found.');
      if (method !== 'GET') throw new RequestError(405, 'This method is not supported.');
      await serveFile(response, path);
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      if (!(error instanceof RequestError)) {
        console.error('Dispatch Desk request failed:', error.name, error.code ?? '');
      }
      json(response, error.status ?? 500, {
        error: error instanceof RequestError ? error.message : 'Something went wrong. Please try again.',
      });
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT || 3000);
  createDispatchServer().listen(port, '127.0.0.1', () => {
    console.log(`Dispatch Desk is ready at http://localhost:${port}`);
    console.log(voiceAvailable() ? 'Gnani voice is configured.' : 'Text demo is ready. Set GNANI_API_KEY in .env for live voice.');
  });
}

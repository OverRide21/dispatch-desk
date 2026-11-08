import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const cookieName = 'dispatch_session';
const sessionDuration = 8 * 60 * 60 * 1000;
const failureWindow = 60_000;
const maxFailures = 5;
const noStore = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

function authError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function credentials() {
  const admin = {
    name: process.env.DISPATCH_ADMIN_USERNAME?.trim() ?? '',
    password: process.env.DISPATCH_ADMIN_PASSWORD ?? '',
    role: 'admin',
  };
  const operator = {
    name: process.env.DISPATCH_OPERATOR_USERNAME?.trim() ?? '',
    password: process.env.DISPATCH_OPERATOR_PASSWORD ?? '',
    role: 'operator',
  };
  const workspaceId = process.env.DISPATCH_WORKSPACE_ID?.trim() || 'default';
  const valid = ({ name, password }) => name.length > 0 && name.length <= 128 &&
    password.length >= 12 && password.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(name);
  const hasOperator = Boolean(operator.name || operator.password);
  if (!valid(admin) || (hasOperator && (!valid(operator) ||
      admin.name.toLowerCase() === operator.name.toLowerCase())) ||
      workspaceId.length > 100 || /[\u0000-\u001f\u007f]/u.test(workspaceId)) return null;
  return {
    workspaceId,
    users: hasOperator ? [admin, operator] : [admin],
    // The keyed digest also invalidates existing sessions when configured credentials rotate.
    sessionKey: digest(JSON.stringify([workspaceId, admin.name, admin.password, operator.name, operator.password])),
  };
}

export function authConfigured() {
  return credentials() !== null;
}

function expectedOrigin(request) {
  const configured = process.env.DISPATCH_PUBLIC_ORIGIN?.trim();
  try {
    const url = new URL(configured || request.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        (configured && (url.pathname !== '/' || url.search || url.hash))) throw new Error();
    // Next.js can canonicalize the local request URL to localhost. Use the actual
    // loopback Host on the same port so the browser's Origin can be checked exactly.
    const host = request.headers.get('host');
    if (!configured && loopbackHosts.has(url.hostname) && host &&
        /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) {
      const local = URL.parse(`${url.protocol}//${host}`);
      if (local && local.port === url.port) return local;
    }
    return url;
  } catch {
    throw authError(503, 'invalid-origin-config', 'The server origin is not configured correctly.');
  }
}

export function assertSameOrigin(request) {
  const fetchSite = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  const expected = expectedOrigin(request);
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite) || origin && origin !== expected.origin) {
    throw authError(403, 'cross-origin', 'Open Dispatch Desk directly to complete this request.');
  }
}

function readToken(request) {
  const entries = request.headers.get('cookie')?.split(';') ?? [];
  for (const entry of entries) {
    const [name, token] = entry.trim().split('=');
    if (name === cookieName && /^[A-Za-z0-9_-]{43}$/.test(token ?? '')) return token;
  }
  return null;
}

function tokenHash(config, token) {
  return createHmac('sha256', config.sessionKey).update(token).digest('hex');
}

function sessionCookie(request, token, maxAge) {
  return `${cookieName}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict` +
    (expectedOrigin(request).protocol === 'https:' ? '; Secure' : '');
}

export async function authenticate(request, store) {
  const config = credentials();
  const token = readToken(request);
  if (!config || !token) return null;
  const sessionId = tokenHash(config, token);
  const session = await store.getAuthSession(sessionId);
  if (!session || session.workspaceId !== config.workspaceId) return null;
  const account = config.users.find(user => user.name === session.user);
  return account ? { workspaceId: session.workspaceId, user: account.name, role: account.role, sessionId } : null;
}

async function loginInput(request) {
  const limit = 4096;
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    void request.body?.cancel().catch(() => {});
    throw authError(415, 'invalid-login', 'Send sign-in details as JSON.');
  }
  if (Number(request.headers.get('content-length')) > limit) {
    void request.body?.cancel().catch(() => {});
    throw authError(413, 'invalid-login', 'Sign-in details are too long.');
  }
  if (!request.body) throw authError(400, 'invalid-login', 'Enter your username and password.');
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
        throw authError(413, 'invalid-login', 'Sign-in details are too long.');
      }
      chunks.push(value);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Handled below. */ }
    const username = typeof data?.username === 'string' ? data.username.trim() : '';
    const password = typeof data?.password === 'string' ? data.password : '';
    if (!username || username.length > 128 || !password || password.length > 256) {
      throw authError(400, 'invalid-login', 'Enter your username and password.');
    }
    return { username, password };
  } finally {
    reader.releaseLock();
  }
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { ...noStore, ...headers } });
}

function authResponse(error) {
  if (!error.status) return json({ error: 'The sign-in service could not complete this request.' }, 500);
  return json({ error: error.message, code: error.code }, error.status);
}

export async function authLogin(request, store) {
  try {
    assertSameOrigin(request);
    const config = credentials();
    if (!config) return json({ error: 'Operator sign-in has not been configured.', code: 'auth-unconfigured' }, 503);
    const { username, password } = await loginInput(request);
    const now = Date.now();
    let account;
    const attemptedPassword = digest(password);
    const attemptedUsername = digest(username);
    for (const user of config.users) {
      const matchesName = timingSafeEqual(digest(user.name), attemptedUsername);
      const matchesPassword = timingSafeEqual(digest(user.password), attemptedPassword);
      if (matchesName && matchesPassword) account = user;
    }
    const knownName = config.users.find(user => user.name === username)?.name ?? 'unknown';
    const failureKey = 'login:' + digest(JSON.stringify([config.workspaceId, config.sessionKey.toString('hex'), knownName])).toString('hex');
    const previous = await store.getRate(failureKey);
    if (previous?.count >= maxFailures || (!account && !await store.rateLimit(failureKey, maxFailures, failureWindow))) {
      return json({ error: 'Too many sign-in attempts. Try again shortly.', code: 'auth-throttled' }, 429, {
        'Retry-After': String(previous ? Math.max(1, Math.ceil((previous.until - now) / 1000)) : 60),
      });
    }
    if (!account) {
      return json({ error: 'The username or password is incorrect.', code: 'invalid-credentials' }, 401);
    }
    if (previous) await store.clearRate(failureKey);
    const existing = readToken(request);
    if (existing) await store.deleteAuthSession(tokenHash(config, existing));
    const token = randomBytes(32).toString('base64url');
    await store.createAuthSession(config.workspaceId, account.name, tokenHash(config, token), now + sessionDuration);
    return json({ user: { name: account.name, role: account.role }, workspaceId: config.workspaceId }, 200, {
      'Set-Cookie': sessionCookie(request, token, sessionDuration / 1000),
    });
  } catch (error) {
    return authResponse(error);
  }
}

export async function authLogout(request, store) {
  try {
    assertSameOrigin(request);
    const config = credentials();
    const token = readToken(request);
    if (config && token) await store.deleteAuthSession(tokenHash(config, token));
    return json({ user: null }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
  } catch (error) {
    return authResponse(error);
  }
}

// PKCE helpers, KV-backed sessions, and the lichess.org API wrapper.
function base64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomString(byteLength = 48) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes.buffer);
}

export async function codeChallengeS256(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(digest);
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 350;
const OAUTH_STATE_TTL_SECONDS = 600;

export function parseCookies(c) {
  const header = c.req.header('Cookie') || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

export function sessionCookie(id) {
  return `sid=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearedSessionCookie() {
  return 'sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

export async function getSession(c) {
  const cookies = parseCookies(c);
  const sid = cookies['sid'];
  if (!sid) return null;
  const raw = await c.env.KV.get(`session:${sid}`);
  if (!raw) return null;
  try {
    return { id: sid, ...JSON.parse(raw) };
  } catch {
    return null;
  }
}

export async function createSession(c, { accessToken, username }) {
  const sid = randomString(24);
  await c.env.KV.put(`session:${sid}`, JSON.stringify({ accessToken, username }), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return sid;
}

export async function destroySession(c, sid) {
  if (sid) await c.env.KV.delete(`session:${sid}`);
}

export async function saveOAuthState(c, state, verifier) {
  await c.env.KV.put(`oauth:${state}`, verifier, { expirationTtl: OAUTH_STATE_TTL_SECONDS });
}

export async function consumeOAuthState(c, state) {
  const key = `oauth:${state}`;
  const verifier = await c.env.KV.get(key);
  if (verifier) await c.env.KV.delete(key);
  return verifier;
}

const BASE = 'https://lichess.org';

export class LichessError extends Error {
  constructor(status, body) {
    const detail =
      body && typeof body === 'object' ? body.error || JSON.stringify(body) : String(body || '');
    super(`Lichess API error ${status}: ${detail}`);
    this.status = status;
    this.body = body;
  }
}

async function handle(res) {
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  if (!res.ok) throw new LichessError(res.status, json);
  return json;
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function lget(token, path) {
  const res = await fetch(BASE + path, { headers: authHeaders(token) });
  return handle(res);
}

export async function lpost(token, path, params) {
  const body = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      body.set(k, String(v));
    }
  }
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeaders(token) },
    body,
  });
  return handle(res);
}

export async function lpostEmpty(token, path) {
  const res = await fetch(BASE + path, { method: 'POST', headers: authHeaders(token) });
  return handle(res);
}

export async function exchangeCodeForToken({ code, verifier, redirectUri, clientId }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: clientId,
  });
  const res = await fetch(`${BASE}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return handle(res);
}

// Account / games
export const getAccount = (token) => lget(token, '/api/account');
export const getPlaying = (token) => lget(token, '/api/account/playing');
export const gameExport = (gameId) => lget(null, `/game/export/${gameId}?pgnInJson=true`);

// Board API
export const boardMove = (token, gameId, move) =>
  lpostEmpty(token, `/api/board/game/${gameId}/move/${encodeURIComponent(move)}`);
export const boardResign = (token, gameId) =>
  lpostEmpty(token, `/api/board/game/${gameId}/resign`);

// Read ONLY the first event of a board game's state stream, then disconnect.
// That first event carries the current position, status and BOTH players'
// clocks (wtime/btime in milliseconds). /api/account/playing only exposes
// your own secondsLeft, so this is how we get the opponent's timer. Best
// effort: returns null if the game isn't a board game / stream can't be read.
export async function boardGameState(token, gameId, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/board/game/${gameId}/state`, {
      headers: authHeaders(token),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      buf += decoder.decode(value, { stream: true });
      const nl = buf.indexOf('\n');
      if (nl === -1) continue;
      const line = buf.slice(0, nl).trim();
      if (!line) return null;
      return JSON.parse(line);
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    try { controller.abort(); } catch {}
  }
}

// Join the matchmaking pool. Holds the connection until matched or timeout.
export async function quickPairSeek(token, params, timeoutMs = 20000) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') body.set(k, String(v));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/board/seek`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeaders(token) },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LichessError(res.status, text ? { raw: text } : null);
    }
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          if (/"game"\s*:/.test(buf)) return { matched: true };
          if (buf.length > 4096) buf = buf.slice(-512);
        }
      } catch {
        // aborted -> timeout below
      }
    }
    return { matched: true };
  } catch (e) {
    if (e.name === 'AbortError') return { matched: false, timedOut: true };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Challenges
export const challengeAI = (token, params) => lpost(token, '/api/challenge/ai', params);
export const challengeOpen = (token, params) => lpost(token, '/api/challenge/open', params);
export const challengeUser = (token, username, params) =>
  lpost(token, `/api/challenge/${encodeURIComponent(username)}`, params);
export const challengeShow = (token, challengeId) =>
  lget(token, `/api/challenge/${challengeId}/show`);
export const challengeList = (token) => lget(token, '/api/challenge');
export const challengeAccept = (token, challengeId) =>
  lpostEmpty(token, `/api/challenge/${challengeId}/accept`);
export const challengeDecline = (token, challengeId) =>
  lpostEmpty(token, `/api/challenge/${challengeId}/decline`);
export const challengeCancel = (token, challengeId) =>
  lpostEmpty(token, `/api/challenge/${challengeId}/cancel`);

// Puzzles
export const puzzleDaily = () => lget(null, '/api/puzzle/daily');
export const puzzleNext = (token) => lget(token, '/api/puzzle/next');
export const puzzleById = (token, id) => lget(token, `/api/puzzle/${id}`);
export const puzzleBatch = (token, angle, nb) =>
  lget(token, `/api/puzzle/batch/${encodeURIComponent(angle)}?nb=${encodeURIComponent(nb)}`);

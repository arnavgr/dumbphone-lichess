// ---------------------------------------------------------------------------
// Everything that talks to Lichess, or supports talking to Lichess, in one
// file:
//   - PKCE helpers for the OAuth2 login flow
//   - KV-backed session + OAuth-state storage
//   - The lichess.org HTTP API wrapper (Board API, challenges, puzzles...)
//
// Split out from chess.js-dependent game logic (see chess.js) and from the
// route handlers (see index.js).
// ---------------------------------------------------------------------------

// ============================================================================
// PKCE (RFC 7636) helpers used for the Lichess OAuth2 login flow.
// Lichess is a "public client" - no client secret, PKCE with S256 is mandatory.
// ============================================================================

function base64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Random URL-safe string, used for both the PKCE code_verifier and the OAuth "state" param.
export function randomString(byteLength = 48) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes.buffer);
}

// S256 code_challenge derived from a code_verifier.
export async function codeChallengeS256(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(digest);
}

// ============================================================================
// Session + OAuth-state storage (Cloudflare KV, via the `KV` binding)
// ============================================================================

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 350; // ~ lifetime of a Lichess access token (~1 year)
const OAUTH_STATE_TTL_SECONDS = 600; // 10 minutes to complete the login round trip

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

// Returns { id, accessToken, username } or null if not logged in.
export async function getSession(c) {
  const cookies = parseCookies(c);
  const sid = cookies['sid'];
  if (!sid) return null;
  const raw = await c.env.KV.get(`session:${sid}`);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return { id: sid, ...data };
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

// --- OAuth state (short lived, holds the PKCE code_verifier between /login and /callback) ---

export async function saveOAuthState(c, state, verifier) {
  await c.env.KV.put(`oauth:${state}`, verifier, { expirationTtl: OAUTH_STATE_TTL_SECONDS });
}

export async function consumeOAuthState(c, state) {
  const key = `oauth:${state}`;
  const verifier = await c.env.KV.get(key);
  if (verifier) await c.env.KV.delete(key);
  return verifier;
}

// ============================================================================
// Thin wrapper around the Lichess HTTP API (https://lichess.org/api).
// Every function returns parsed JSON on success and throws a LichessError on
// failure, so callers can show the real error message from Lichess instead
// of failing silently.
// ============================================================================

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
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...authHeaders(token),
    },
    body,
  });
  return handle(res);
}

export async function lpostEmpty(token, path) {
  const res = await fetch(BASE + path, { method: 'POST', headers: authHeaders(token) });
  return handle(res);
}

// --- OAuth token exchange (Authorization Code + PKCE) ---
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
  return handle(res); // { token_type, access_token, expires_in }
}

// --- Account ---
export const getAccount = (token) => lget(token, '/api/account');
export const getPlaying = (token) => lget(token, '/api/account/playing');

// --- Games ---
export const gameExport = (gameId) => lget(null, `/game/export/${gameId}?pgnInJson=true`);

// --- Board API (human play) ---
export const boardMove = (token, gameId, move) =>
  lpostEmpty(token, `/api/board/game/${gameId}/move/${encodeURIComponent(move)}`);
export const boardResign = (token, gameId) =>
  lpostEmpty(token, `/api/board/game/${gameId}/resign`);
export const boardAbort = (token, gameId) => lpostEmpty(token, `/api/board/game/${gameId}/abort`);

// Board API "seek" (join the real-time matchmaking pool). This holds the HTTP
// connection open until a match is found, so we bound it with a timeout and just
// report back whether the stream closed (matched) or we gave up (timed out).
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
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...authHeaders(token),
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LichessError(res.status, text ? { raw: text } : null);
    }
    if (res.body) {
      const reader = res.body.getReader();
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // reader threw because we aborted -> treat as timeout below
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

// --- Challenges ---
export const challengeAI = (token, params) => lpost(token, '/api/challenge/ai', params);
export const challengeOpen = (token, params) => lpost(token, '/api/challenge/open', params);
export const challengeUser = (token, username, params) =>
  lpost(token, `/api/challenge/${encodeURIComponent(username)}`, params);
export const challengeShow = (token, challengeId) =>
  lget(token, `/api/challenge/${challengeId}/show`);

// --- Puzzles ---
export const puzzleDaily = () => lget(null, '/api/puzzle/daily');
export const puzzleNext = (token) => lget(token, '/api/puzzle/next');
export const puzzleById = (token, id) => lget(token, `/api/puzzle/${id}`);

// Thin wrapper around the Lichess HTTP API (https://lichess.org/api).
// Every function returns parsed JSON on success and throws a LichessError on failure,
// so callers can show the real error message from Lichess instead of failing silently.

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

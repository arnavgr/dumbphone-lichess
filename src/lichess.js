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
//
// NOTE: this is now mostly a fallback. GameWatcher (below) keeps a stream
// open continuously and has fresher data - this one-shot read only gets used
// on /game/:id when the watcher hasn't received anything yet.
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

// ---------------------------------------------------------------------
// GameWatcher (Durable Object)
//
// WHY THIS EXISTS: Lichess treats "connected to the Board API's game
// stream" (GET /api/board/game/stream/{id}) as your presence at the
// board - it's how every real Board API client (bots, DGT boards, etc.)
// proves it's still there. This app renders a page and closes the
// connection, so without this object, Lichess sees us connect for an
// instant on every page load and then vanish - and starts its "opponent
// left" abort countdown the moment each page finishes rendering.
//
// This object holds that stream connection open for the lifetime of a
// game, independent of whether/when the phone happens to load a page,
// and caches the latest position/clocks/status so page renders can read
// them without hitting Lichess fresh each time. A watchdog alarm re-checks
// every few seconds and reconnects if the stream has gone quiet, so a
// dropped connection gets re-established well within the window Lichess
// allows before flagging us as gone.
const TERMINAL_STATUSES = new Set([
  'mate', 'resign', 'stalemate', 'timeout', 'draw',
  'outoftime', 'cheat', 'noStart', 'aborted', 'variantEnd',
]);
const STALE_MS = 8000; // if we've heard nothing in 8s, assume the connection died
const WATCHDOG_MS = 5000; // check that often - comfortably under Lichess's ~10-20s window

export class GameWatcher {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.running = false;
    this.generation = 0;
    this.lastHeardAt = 0;
    this.latest = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/start' && request.method === 'POST') {
      const { token, gameId } = await request.json();
      this.token = token;
      this.gameId = gameId;
      if (!this.running) {
        this.running = true;
        this.connect(); // not awaited - the DO stays alive while this has pending I/O
        await this.state.storage.setAlarm(Date.now() + WATCHDOG_MS);
      }
      return new Response('ok');
    }

    if (url.pathname === '/stop' && request.method === 'POST') {
      this.running = false;
      this.generation++; // retires any in-flight read loop
      return new Response('ok');
    }

    if (url.pathname === '/state') {
      return new Response(JSON.stringify(this.latest || {}), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  }

  // Called by the Cloudflare runtime when the alarm set above fires.
  async alarm() {
    if (!this.running) return;
    if (Date.now() - this.lastHeardAt > STALE_MS) this.connect();
    await this.state.storage.setAlarm(Date.now() + WATCHDOG_MS);
  }

  async connect() {
    if (!this.token || !this.gameId) return;
    const gen = ++this.generation; // if an older loop is still winding down, this retires it
    this.lastHeardAt = Date.now();
    try {
      const res = await fetch(`${BASE}/api/board/game/stream/${this.gameId}`, {
        headers: authHeaders(this.token),
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (this.running && gen === this.generation) {
        const { done, value } = await reader.read();
        this.lastHeardAt = Date.now(); // any byte counts, including keep-alive blank lines
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.handleLine(line);
        }
        if (this.latest && TERMINAL_STATUSES.has(this.latest.status)) {
          this.running = false;
        }
      }
    } catch {
      // dropped mid-stream - the watchdog alarm will notice lastHeardAt
      // going stale and call connect() again.
    }
  }

  handleLine(line) {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      return;
    }
    if (evt.type === 'gameFull') {
      this.latest = {
        ...(this.latest || {}),
        ...evt.state,
        white: evt.white,
        black: evt.black,
        initialFen: evt.initialFen,
      };
    } else if (evt.type === 'gameState') {
      this.latest = { ...(this.latest || {}), ...evt };
    } else if (evt.type === 'opponentGone') {
      this.latest = {
        ...(this.latest || {}),
        opponentGone: evt.gone,
        claimWinInSeconds: evt.claimWinInSeconds,
      };
    }
  }
}

import { randomString } from './pkce.js';

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

import { Hono } from 'hono';
import { Chess } from 'chess.js';
import {
  randomString, codeChallengeS256, getSession, createSession, destroySession,
  saveOAuthState, consumeOAuthState, sessionCookie, clearedSessionCookie, parseCookies,
} from './lichess.js';
import * as lichess from './lichess.js';
import {
  renderBoard, sideToMove, puzzleBasePosition, puzzleStateFrom, normalizeUci, applyUciMoves,
  pickAiMove, applyAiMove, BOARD_SIZE_KEYS,
} from './chess.js';
import { page, redirectPage, errorPage, htmlResponse, escapeHtml, selectField, renderGamesList, playerBar } from './ui.js';
import { TIME_CONTROLS, findTimeControl, AI_TIME_CONTROLS, findAiTimeControl, AI_LEVELS, LOCAL_AI_LEVELS } from './constants.js';

// GameWatcher is a Durable Object (defined in lichess.js, since it's really
// just another piece of "talk to the Lichess API" logic) that keeps a
// Board API game-stream connection open for the life of a game, so Lichess
// doesn't think we've disconnected between page loads. Cloudflare requires
// the class to be exported from this file (the `main` entry in
// wrangler.toml) for the [[durable_objects.bindings]] binding to find it.
export { GameWatcher } from './lichess.js';

const app = new Hono();

const UCI_MOVE_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const SQUARE_RE = /^[a-h][1-8]$/;
const LICHESS_SCOPES = ['board:play', 'challenge:read', 'challenge:write', 'puzzle:read'];
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

app.use('*', async (c, next) => {
  try { c.set('session', await getSession(c)); } catch { c.set('session', null); }
  await next();
});

const session = (c) => c.get('session') || null;

// ---- Game-presence watcher (Durable Object) helpers ----

function gameWatcherStub(env, gameId) {
  return env.GAME_WATCHER.get(env.GAME_WATCHER.idFromName(gameId));
}

// Idempotent - safe to call on every page load for a game. Tells the
// GameWatcher Durable Object to (keep) holding the Board API stream open
// for this game so Lichess sees us as continuously present. Best-effort:
// a failure here shouldn't break page rendering.
async function startWatching(c, gameId) {
  const s = session(c);
  if (!s || !s.accessToken) return;
  try {
    await gameWatcherStub(c.env, gameId).fetch('https://do/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: s.accessToken, gameId }),
    });
  } catch {
    // best-effort
  }
}

async function stopWatching(c, gameId) {
  try { await gameWatcherStub(c.env, gameId).fetch('https://do/stop', { method: 'POST' }); } catch {}
}

async function watcherState(c, gameId) {
  try {
    const res = await gameWatcherStub(c.env, gameId).fetch('https://do/state');
    return await res.json();
  } catch {
    return null;
  }
}

function boardSize(c) {
  const v = parseCookies(c)['bsize'];
  return BOARD_SIZE_KEYS.includes(v) ? v : 'normal';
}

const newPuzzleHref = () => `/puzzle?r=${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const toSquare = (uci) => String(uci || '').slice(2, 4);

// Clock formatting for the multiplayer player bars above/below the board.
function fmtClockSec(totalSeconds) {
  const t = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
const fmtClockMs = (ms) => fmtClockSec(ms / 1000);

// Parses both UCI (e2e4) and SAN (e4, Nf3, O-O, e8=Q).
function parseMoveInput(input, fen) {
  const clean = String(input || '').trim();
  if (!clean) return null;
  const lower = clean.toLowerCase();
  if (UCI_MOVE_RE.test(lower)) return lower;
  try {
    const chess = new Chess(fen);
    const m = chess.move(clean); // chess.js handles SAN
    if (m) return m.from + m.to + (m.promotion || '');
  } catch {}
  return null;
}

function timeControlParams(tc) {
  const params = {};
  if (tc.clock) {
    params['clock.limit'] = tc.clock.limit;
    params['clock.increment'] = tc.clock.increment;
  }
  return params;
}

function parseStep(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function checkPuzzleGuess(solution, step, guess) {
  const expected = normalizeUci(solution[step]);
  const g = normalizeUci(guess);
  if (g && expected && g === expected) {
    let newStep = step + 1;
    if (solution[newStep]) newStep += 1;
    return { correct: true, newStep };
  }
  const wrongPromotion = g.length >= 4 && expected.length >= 5 && g !== expected && g.slice(0, 4) === expected.slice(0, 4);
  return { correct: false, wrongPromotion };
}

function describeChallenge(ch) {
  const tc = ch.timeControl || {};
  let speed = '';
  if (tc.type === 'clock') speed = `${Math.round((tc.limit || 0) / 60)}+${tc.increment || 0}`;
  else speed = tc.type || '';
  return `${ch.rated ? 'Rated' : 'Casual'} ${speed}`.trim();
}

const SIZE_HINTS = {
  tiny: 'very small screens (128x160)', small: 'small screens (~160px wide)',
  normal: '240x320 screens', large: '320px+ wide screens',
};

app.get('/settings', async (c) => {
  const s = session(c);
  const requested = c.req.query('s');
  let extraHeaders = {};
  if (requested && BOARD_SIZE_KEYS.includes(requested)) {
    extraHeaders = { 'Set-Cookie': `bsize=${requested}; Path=/; Max-Age=31536000` };
  }
  const current = requested && BOARD_SIZE_KEYS.includes(requested) ? requested : boardSize(c);
  let body = '<p>Pick a board size for your screen. Saved on this phone.</p>';
  for (const k of BOARD_SIZE_KEYS) {
    const active = k === current;
    body += `<p><b>${k}</b> - ${SIZE_HINTS[k]} `;
    body += active ? '<b style="color:#006600;">[current]</b>' : `<a href="/settings?s=${k}">Use this size</a>`;
    body += '</p>';
    body += renderBoard(START_FEN, 'white', { size: k });
  }
  return htmlResponse(page('Board size', body, s), 200, extraHeaders);
});

app.get('/', async (c) => {
  const s = session(c);
  if (!s) {
    const body = `<p>Play Lichess chess on a basic phone browser - no smartphone needed.</p>
<p><a href="${newPuzzleHref()}">&gt;&gt; Solve a puzzle (no login needed)</a></p>
<p><a href="/ai">&gt;&gt; Play vs a computer (no login needed)</a></p>
<p><a href="/login">&gt;&gt; Login with Lichess to play other people</a></p>
<p style="font-size:12px;">Puzzles and the local computer opponent work without login. Logging in adds rated multiplayer against real people and your ratings.</p>`;
    return htmlResponse(page('Lichess Dumbphone', body, s));
  }
  let nowPlaying = [], incoming = [], loadError = null;
  try { nowPlaying = (await lichess.getPlaying(s.accessToken)).nowPlaying || []; } catch (e) { loadError = e.message; }
  try { incoming = (await lichess.challengeList(s.accessToken)).in || []; } catch {}
  let body = '';
  if (loadError) body += `<p>Could not load your games: ${escapeHtml(loadError)}</p>`;
  if (incoming.length > 0) {
    body += '<h4 style="margin:8px 0 4px;">Incoming challenges</h4>';
    for (const ch of incoming) {
      const from = (ch.challenger && (ch.challenger.name || ch.challenger.username)) || 'Someone';
      body += `<p><b>${escapeHtml(from)}</b> challenges you - ${escapeHtml(describeChallenge(ch))}</p>`;
      body += `<form method="post" action="/challenge/${escapeHtml(ch.id)}/accept" style="display:inline;margin:0;"><input type="submit" value="Accept"></form>`;
      body += `<form method="post" action="/challenge/${escapeHtml(ch.id)}/decline" style="display:inline;margin:0;"><input type="submit" value="Decline"></form>`;
    }
    body += '<hr>';
  }
  if (nowPlaying.length > 0) {
    // Make sure every active game has a watcher running - this is how we
    // catch games that started some other way (e.g. accepted on
    // lichess.org itself, or a challenge someone else accepted) without
    // needing to have seen the exact moment they started.
    for (const g of nowPlaying) await startWatching(c, g.gameId);
    const first = nowPlaying.find((g) => g.isMyTurn) || nowPlaying[0];
    const oppName = (first.opponent && first.opponent.username) || 'opponent';
    const oppRating = first.opponent && first.opponent.rating ? `(${first.opponent.rating})` : '';
    body += '<p><b>You have a game in progress.</b></p>';
    body += `<p><a href="/game/${escapeHtml(first.gameId)}#board">&gt;&gt; Continue vs ${escapeHtml(oppName)}${oppRating}${first.isMyTurn ? ' (your move)' : ''}</a></p>`;
    if (nowPlaying.length > 1) body += renderGamesList(nowPlaying);
  } else { body += '<p>No games in progress.</p>'; }
  body += '<p><a href="/">Refresh</a></p><hr>';
  body += '<p><a href="/game/new/multiplayer">&gt;&gt; Play multiplayer</a></p>';
  body += '<p><a href="/game/new/ai">&gt;&gt; Play vs AI (Lichess)</a></p>';
  body += '<p><a href="/ai">&gt;&gt; Play vs AI (no login)</a></p>';
  body += `<p><a href="${newPuzzleHref()}">&gt;&gt; Solve a puzzle</a></p>`;
  return htmlResponse(page('Lichess Dumbphone', body, s, { refreshSeconds: incoming.length ? 30 : undefined }));
});

// ---------------------------------------------------------------- Auth

function tokenCreateUrl() {
  const url = new URL('https://lichess.org/account/oauth/token/create');
  for (const scope of LICHESS_SCOPES) url.searchParams.append('scopes[]', scope);
  url.searchParams.set('description', 'dumbphone-lichess');
  return url.toString();
}

app.get('/login', async (c) => {
  const s = session(c);
  const configured = c.env.LICHESS_CLIENT_ID && c.env.REDIRECT_URI;
  let body = '<h4 style="margin:8px 0 4px;">Option A - Login via Lichess</h4>';
  body += configured ? '<p><a href="/login/oauth">&gt;&gt; Continue to Lichess</a></p>' : "<p>Not available: LICHESS_CLIENT_ID / REDIRECT_URI aren't set in wrangler.toml.</p>";
  body += '<hr><h4 style="margin:8px 0 4px;">Option B - Paste a personal API token</h4>';
  body += `<p><a href="${escapeHtml(tokenCreateUrl())}">&gt;&gt; Create a token on lichess.org</a></p>`;
  body += `<form method="post" action="/login/token"><p>Paste your token: <input type="text" name="token" size="30"></p><p><input type="submit" value="Log in with token"></p></form>`;
  return htmlResponse(page('Login', body, s));
});

app.get('/login/oauth', async (c) => {
  const clientId = c.env.LICHESS_CLIENT_ID, redirectUri = c.env.REDIRECT_URI;
  if (!clientId || !redirectUri) return htmlResponse(errorPage('Not configured', 'LICHESS_CLIENT_ID and REDIRECT_URI must be set in wrangler.toml.'), 500);
  const verifier = randomString(48), state = randomString(24);
  await saveOAuthState(c, state, verifier);
  const challenge = await codeChallengeS256(verifier);
  const authUrl = new URL('https://lichess.org/oauth');
  authUrl.searchParams.set('response_type', 'code'); authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri); authUrl.searchParams.set('scope', LICHESS_SCOPES.join(' '));
  authUrl.searchParams.set('code_challenge_method', 'S256'); authUrl.searchParams.set('code_challenge', challenge); authUrl.searchParams.set('state', state);
  return htmlResponse(redirectPage(authUrl.toString(), 'Taking you to Lichess to log in...'));
});

app.get('/callback', async (c) => {
  const code = c.req.query('code'), state = c.req.query('state'), errorParam = c.req.query('error');
  if (errorParam) return htmlResponse(errorPage('Login cancelled', `Lichess said: ${errorParam}`, '/login'));
  if (!code || !state) return htmlResponse(errorPage('Login failed', 'Missing code or state from Lichess.', '/login'), 400);
  let verifier; try { verifier = await consumeOAuthState(c, state); } catch { verifier = null; }
  if (!verifier) return htmlResponse(errorPage('Login failed', 'Your login attempt expired or was already used. Try again.', '/login'), 400);
  try {
    const tokenData = await lichess.exchangeCodeForToken({ code, verifier, redirectUri: c.env.REDIRECT_URI, clientId: c.env.LICHESS_CLIENT_ID });
    const account = await lichess.getAccount(tokenData.access_token);
    const sid = await createSession(c, { accessToken: tokenData.access_token, username: account.username });
    return htmlResponse(redirectPage('/', `Logged in as ${account.username}.`), 200, { 'Set-Cookie': sessionCookie(sid) });
  } catch (e) { return htmlResponse(errorPage('Login failed', e.message, '/login'), 400); }
});

app.post('/login/token', async (c) => {
  const form = await c.req.parseBody(); const token = String(form.token || '').trim();
  if (!token) return htmlResponse(errorPage('Missing token', 'Please paste a Lichess API token.', '/login'), 400);
  try {
    const account = await lichess.getAccount(token);
    const sid = await createSession(c, { accessToken: token, username: account.username });
    return htmlResponse(redirectPage('/', `Logged in as ${account.username}.`), 200, { 'Set-Cookie': sessionCookie(sid) });
  } catch (e) { return htmlResponse(errorPage('Login failed', `That token didn't work (${e.message}).`, '/login'), 400); }
});

app.get('/logout', async (c) => {
  const s = session(c); if (s) { try { await destroySession(c, s.id); } catch {} }
  return htmlResponse(redirectPage('/', 'Logged out.'), 200, { 'Set-Cookie': clearedSessionCookie() });
});

// ---------------------------------------------------------------- Owner login

const OWNER_LOGIN_ATTEMPT_LIMIT = 6, OWNER_LOGIN_WINDOW_SECONDS = 15 * 60;

function passwordsMatch(a, b) {
  const strA = String(a || ''), strB = String(b || ''); const len = Math.max(strA.length, strB.length, 1);
  let diff = strA.length === strB.length ? 0 : 1;
  for (let i = 0; i < len; i++) { const ca = i < strA.length ? strA.charCodeAt(i) : 0; const cb = i < strB.length ? strB.charCodeAt(i) : 0; diff |= ca ^ cb; }
  return diff === 0;
}

function clientIp(c) { return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'; }

async function ownerLoginAttempts(c) {
  const key = `ownerlogin:${clientIp(c)}`; let count = 0;
  try { const raw = await c.env.KV.get(key); count = raw ? parseInt(raw, 10) || 0 : 0; } catch {}
  return { key, count };
}

app.get('/owner-login', async (c) => {
  const s = session(c);
  const body = `<p>Owner-only quick login.</p><form method="post" action="/owner-login"><p>Password: <input type="password" name="password" size="20"></p><p><input type="submit" value="Log in"></p></form>`;
  return htmlResponse(page('Owner login', body, s));
});

app.post('/owner-login', async (c) => {
  const configured = c.env.OWNER_TOKEN && c.env.OWNER_LOGIN_PASSWORD;
  if (!configured) return htmlResponse(errorPage('Not configured', 'OWNER_TOKEN and OWNER_LOGIN_PASSWORD secrets are not set.', '/login'), 500);
  const { key, count } = await ownerLoginAttempts(c);
  if (count >= OWNER_LOGIN_ATTEMPT_LIMIT) return htmlResponse(errorPage('Too many attempts', 'Too many wrong attempts.', '/owner-login'), 429);
  const form = await c.req.parseBody(); const password = String(form.password || '');
  if (!passwordsMatch(password, c.env.OWNER_LOGIN_PASSWORD)) {
    try { await c.env.KV.put(key, String(count + 1), { expirationTtl: OWNER_LOGIN_WINDOW_SECONDS }); } catch {}
    return htmlResponse(errorPage('Login failed', 'Wrong password.', '/owner-login'), 401);
  }
  try { await c.env.KV.delete(key); } catch {}
  try {
    const account = await lichess.getAccount(c.env.OWNER_TOKEN);
    const sid = await createSession(c, { accessToken: c.env.OWNER_TOKEN, username: account.username });
    return htmlResponse(redirectPage('/', `Logged in as ${account.username}.`), 200, { 'Set-Cookie': sessionCookie(sid) });
  } catch (e) { return htmlResponse(errorPage('Login failed', `Owner token failed (${e.message}).`, '/owner-login'), 400); }
});

// ---------------------------------------------------------------- vs AI (Lichess)

app.get('/game/new/ai', async (c) => {
  const s = session(c); if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const body = `<form method="post" action="/game/new/ai">
<p>Level: ${selectField('level', AI_LEVELS.map((l) => ({ value: l, label: `Level ${l}` })), 3)}</p>
<p>Your color: ${selectField('color', [{ value: 'random', label: 'Random' }, { value: 'white', label: 'White' }, { value: 'black', label: 'Black' }], 'random')}</p>
<p>Time control: ${selectField('timeControl', AI_TIME_CONTROLS, 'unlimited')}</p>
<p><input type="submit" value="Start game"></p></form>`;
  return htmlResponse(page('Play vs AI (Lichess)', body, s));
});

app.post('/game/new/ai', async (c) => {
  const s = session(c); if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const form = await c.req.parseBody();
  const tc = findAiTimeControl(form.timeControl);
  const params = { level: form.level, color: form.color, variant: 'standard', ...timeControlParams(tc) };
  try {
    const res = await lichess.challengeAI(s.accessToken, params);
    const gameId = (res.game && res.game.id) || res.id || (res.challenge && res.challenge.id);
    if (!gameId) throw new Error('Lichess did not return a game id.');
    await startWatching(c, gameId);
    return htmlResponse(redirectPage(`/game/${gameId}#board`, 'Game created!'));
  } catch (e) { return htmlResponse(errorPage('Could not start game', e.message, '/game/new/ai')); }
});

// ---------------------------------------------------------------- Multiplayer & Challenges

app.get('/game/new/multiplayer', async (c) => {
  const s = session(c); if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const colorField = selectField('color', [{ value: 'random', label: 'Random' }, { value: 'white', label: 'White' }, { value: 'black', label: 'Black' }], 'random');
  const ratedCasual = selectField('rated', [{ value: 'false', label: 'Casual' }, { value: 'true', label: 'Rated' }], 'false');
  const ratedDefault = selectField('rated', [{ value: 'true', label: 'Rated' }, { value: 'false', label: 'Casual' }], 'true');
  const body = `<h4>1) Quick pair</h4><form method="post" action="/game/new/multiplayer/quick"><p>Time: ${selectField('timeControl', TIME_CONTROLS, 'rapid-600-0')}</p><p>${ratedDefault}</p><p><input type="submit" value="Find opponent"></p></form><hr>
<h4>2) Challenge username</h4><form method="post" action="/game/new/multiplayer/user"><p>User: <input type="text" name="username" size="16"></p><p>Color: ${colorField}</p><p>Time: ${selectField('timeControl', TIME_CONTROLS, 'rapid-600-0')}</p><p>${ratedCasual}</p><p><input type="submit" value="Send"></p></form><hr>
<h4>3) Open link</h4><form method="post" action="/game/new/multiplayer/open"><p>Time: ${selectField('timeControl', TIME_CONTROLS, 'rapid-600-0')}</p><p>${ratedCasual}</p><p><input type="submit" value="Create link"></p></form>`;
  return htmlResponse(page('Play multiplayer', body, s));
});

app.post('/game/new/multiplayer/quick', async (c) => {
  const s = session(c); if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const form = await c.req.parseBody(); const tc = findTimeControl(form.timeControl); const rated = form.rated === 'false' ? 'false' : 'true';
  let exclude = []; try { exclude = ((await lichess.getPlaying(s.accessToken)).nowPlaying || []).map((g) => g.gameId); } catch {}
  const seekParams = { rated, time: Math.round(tc.clock.limit / 60), increment: tc.clock.increment };
  const searchUrl = `/searching?started=${Date.now()}&tc=${encodeURIComponent(tc.value)}&rated=${rated}` + (exclude.length ? `&exclude=${encodeURIComponent(exclude.join(','))}` : '');
  try { c.executionCtx.waitUntil(lichess.quickPairSeek(s.accessToken, seekParams, 90000).catch(() => {})); } catch {}
  return htmlResponse(redirectPage(searchUrl, 'Joining pool...'));
});

app.get('/searching', async (c) => {
  const s = session(c); if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const started = Number(c.req.query('started')) || Date.now(); const excludeParam = c.req.query('exclude') || '';
  const exclude = excludeParam.split(',').map((x) => x.trim()).filter(Boolean);
  const tcValue = c.req.query('tc') || ''; const rated = c.req.query('rated') !== 'false'; const tc = findTimeControl(tcValue);
  const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
  const selfUrl = `/searching?started=${started}&tc=${encodeURIComponent(tcValue)}&rated=${rated ? 'true' : 'false'}` + (excludeParam ? `&exclude=${encodeURIComponent(excludeParam)}` : '');
  let list = [], err = null; try { list = (await lichess.getPlaying(s.accessToken)).nowPlaying || []; } catch (e) { err = e.message; }
  const newGame = list.find((g) => !exclude.includes(g.gameId));
  if (newGame) {
    await startWatching(c, newGame.gameId);
    // Straight redirect so the browser lands directly on the board.
    return c.redirect(`/game/${newGame.gameId}#board`, 302);
  }
  if (elapsed > 90) return htmlResponse(page('Quick pair', '<p>No opponent found within 90s.</p><p><a href="/game/new/multiplayer">Back</a></p>', s));
  const body = `<p><b>Looking for ${rated ? 'RATED' : 'casual'} ${escapeHtml(tc.label)}... (${elapsed}s)</b></p><p><a href="${escapeHtml(selfUrl)}">Check now</a></p>${err ? `<p>${escapeHtml(err)}</p>` : ''}`;
  return htmlResponse(page('Searching', body, s, { refreshSeconds: 5 }));
});

app.post('/game/new/multiplayer/user', async (c) => {
  const s = session(c); if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const form = await c.req.parseBody(); const username = String(form.username || '').trim();
  if (!username) return htmlResponse(errorPage('Missing username', 'Enter a username.', '/game/new/multiplayer'), 400);
  const tc = findTimeControl(form.timeControl);
  try {
    const res = await lichess.challengeUser(s.accessToken, username, { rated: form.rated, color: form.color, variant: 'standard', ...timeControlParams(tc) });
    return htmlResponse(redirectPage(`/challenge/${(res.challenge && res.challenge.id) || res.id}`, `Sent to ${username}.`));
  } catch (e) { return htmlResponse(errorPage('Failed', e.message, '/game/new/multiplayer')); }
});

app.post('/game/new/multiplayer/open', async (c) => {
  const s = session(c); if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const form = await c.req.parseBody(); const tc = findTimeControl(form.timeControl);
  try {
    const res = await lichess.challengeOpen(s.accessToken, { rated: form.rated, variant: 'standard', ...timeControlParams(tc) });
    const id = (res.challenge && res.challenge.id) || res.id; const url = (res.challenge && res.challenge.url) || res.url;
    return htmlResponse(page('Open challenge', `<p>Share link:</p><p><b>${escapeHtml(url || '(none)')}</b></p><p><a href="/challenge/${escapeHtml(id)}">Status</a></p>`, s));
  } catch (e) { return htmlResponse(errorPage('Failed', e.message, '/game/new/multiplayer')); }
});

app.get('/challenge/:id', async (c) => {
  const s = session(c); if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id'); let info = null, error = null;
  try { info = await lichess.challengeShow(s.accessToken, id); } catch (e) { error = e.message; }
  const ch = (info && (info.challenge || info)) || {};
  if (ch.status === 'accepted') return c.redirect(`/game/${id}#board`, 302);
  let body = error ? `<p>${escapeHtml(error)}</p>` : `<p>Status: <b>${escapeHtml(ch.status || 'unknown')}</b></p>`;
  if (ch.url) body += `<p>Link: <b>${escapeHtml(ch.url)}</b></p>`;
  body += `<p><a href="/challenge/${escapeHtml(id)}">Refresh</a></p><p><a href="/game/${escapeHtml(id)}#board">Open game</a></p>`;
  if (!ch.status || ch.status === 'created' || ch.status === 'sent') body += `<form method="post" action="/challenge/${escapeHtml(id)}/cancel"><p><input type="submit" value="Cancel"></p></form>`;
  return htmlResponse(page('Challenge', body, s, { refreshSeconds: error ? undefined : 10 }));
});

app.post('/challenge/:id/accept', async (c) => {
  const s = session(c); if (!s) return htmlResponse(redirectPage('/login', 'Login.'));
  const id = c.req.param('id');
  try {
    await lichess.challengeAccept(s.accessToken, id);
    await startWatching(c, id);
    // Straight redirect so the browser lands directly on the board.
    return c.redirect(`/game/${id}#board`, 302);
  } catch (e) { return htmlResponse(errorPage('Failed', e.message, '/')); }
});

app.post('/challenge/:id/decline', async (c) => { const s = session(c); if (!s) return htmlResponse(redirectPage('/login', 'Login.')); try { await lichess.challengeDecline(s.accessToken, c.req.param('id')); return htmlResponse(redirectPage('/', 'Declined.')); } catch (e) { return htmlResponse(errorPage('Failed', e.message, '/')); } });
app.post('/challenge/:id/cancel', async (c) => { const s = session(c); if (!s) return htmlResponse(redirectPage('/login', 'Login.')); try { await lichess.challengeCancel(s.accessToken, c.req.param('id')); return htmlResponse(redirectPage('/', 'Cancelled.')); } catch (e) { return htmlResponse(errorPage('Failed', e.message, '/')); } });

// ---------------------------------------------------------------- vs AI, no login

app.get('/ai', async (c) => {
  const s = session(c);
  const body = `<p>Play vs a computer - no Lichess account needed.</p><form method="get" action="/ai/play"><p>Difficulty: ${selectField('diff', LOCAL_AI_LEVELS, 1)}</p><p>Color: ${selectField('color', [{ value: 'w', label: 'White' }, { value: 'b', label: 'Black' }], 'w')}</p><p><input type="submit" value="Start game"></p></form>`;
  return htmlResponse(page('Play vs AI (no login)', body, s));
});

app.get('/ai/play', async (c) => {
  const s = session(c); const size = boardSize(c); const q = c.req.query();
  let diff = parseInt(q.diff, 10); if (!Number.isFinite(diff) || diff < 0) diff = 1; if (diff > 4) diff = 4;
  const color = q.color === 'b' ? 'b' : 'w'; const fenParam = q.fen || null;
  const moveRaw = (q.move || '').trim(); const selectedParam = (q.selected || '').toLowerCase();
  const selected = SQUARE_RE.test(selectedParam) ? selectedParam : null;
  const lmParam = (q.lm || '').toLowerCase(); let lastMove = UCI_MOVE_RE.test(lmParam) ? lmParam : null;
  const linkBase = (extra = {}) => {
    const params = new URLSearchParams(); params.set('diff', String(diff)); params.set('color', color);
    for (const [k, v] of Object.entries(extra)) { if (v === undefined || v === null || v === '') continue; params.set(k, String(v)); }
    return `/ai/play?${params.toString()}`;
  };
  const moveToUci = (m) => `${m.from}${m.to}${m.promotion || ''}`;
  let chess; let resetMessage = null;
  try { chess = fenParam ? new Chess(fenParam) : new Chess(); } catch { chess = new Chess(); resetMessage = 'Invalid FEN, fresh game.'; }
  if (resetMessage) lastMove = null;
  if (!fenParam && color === 'b' && !resetMessage) { const applied = applyAiMove(chess, await pickAiMove(chess, diff)); lastMove = applied ? moveToUci(applied) : null; }
  if (moveRaw) {
    const moveUci = parseMoveInput(moveRaw, chess.fen());
    if (!moveUci) return htmlResponse(errorPage('Invalid move', 'That move was not understood.', linkBase({ fen: chess.fen(), lm: lastMove })), 400);
    try { chess.move({ from: moveUci.slice(0, 2), to: moveUci.slice(2, 4), promotion: moveUci.slice(4, 5) || undefined }); }
    catch { return htmlResponse(errorPage('Illegal move', 'That move is not legal here.', linkBase({ fen: chess.fen(), lm: lastMove })), 200); }
    lastMove = moveUci;
    if (!chess.isGameOver()) { const applied = applyAiMove(chess, await pickAiMove(chess, diff)); if (applied) lastMove = moveToUci(applied); }
    // Straight redirect back to the square you moved to.
    return c.redirect(linkBase({ fen: chess.fen(), lm: lastMove }) + `#sq-${toSquare(moveUci)}`, 302);
  }
  if (!chess.isGameOver() && chess.turn() !== color) {
    const applied = applyAiMove(chess, await pickAiMove(chess, diff)); if (applied) lastMove = moveToUci(applied);
    return c.redirect(linkBase({ fen: chess.fen(), lm: lastMove }) + (lastMove ? `#sq-${toSquare(lastMove)}` : '#board'), 302);
  }
  const orientation = color === 'b' ? 'black' : 'white'; const isOver = chess.isGameOver();
  let message, msgColor;
  if (resetMessage) { message = resetMessage; msgColor = '#cc0000'; }
  else if (chess.isCheckmate()) { message = chess.turn() === color ? 'Checkmate - you lose.' : 'Checkmate - you win!'; msgColor = '#000099'; }
  else if (chess.isStalemate()) { message = 'Stalemate.'; msgColor = '#000099'; }
  else if (chess.isDraw()) { message = 'Draw.'; msgColor = '#000099'; }
  else if (chess.isCheck()) { message = 'Check! Your move.'; msgColor = '#cc0000'; }
  else { message = 'Your move - tap a piece, or type e4/Nf3.'; msgColor = '#006600'; }
  const refreshUrl = linkBase({ fen: chess.fen(), lm: lastMove }) + '#board';
  let body = `<p><b style="color:${msgColor};">${escapeHtml(message)}</b></p>`;
  body += renderBoard(chess.fen(), orientation, {
    size, interactive: !isOver, selected: selected && !isOver ? selected : null, lastMove,
    isOwnPiece: (sq, piece) => (color === 'w' ? piece === piece.toUpperCase() : piece === piece.toLowerCase()),
    selectHref: (sq) => linkBase({ fen: chess.fen(), selected: sq, lm: lastMove }) + `#sq-${sq}`,
    moveHref: (uci) => linkBase({ fen: chess.fen(), move: uci, lm: lastMove }),
  });
  if (selected && !isOver) body += `<p><a href="${escapeHtml(refreshUrl)}">[Cancel selection]</a></p>`;
  if (!isOver) {
    body += `<form method="get" action="/ai/play"><input type="hidden" name="diff" value="${diff}"><input type="hidden" name="color" value="${color}"><input type="hidden" name="fen" value="${escapeHtml(chess.fen())}">${lastMove ? `<input type="hidden" name="lm" value="${escapeHtml(lastMove)}">` : ''}
<p style="font-size:12px;">Type move (e4, Nf3, O-O, or e2e4): <input type="text" name="move" size="8" maxlength="6"> <input type="submit" value="Play"></p></form>`;
  }
  body += `<p><a href="${escapeHtml(refreshUrl)}">Refresh board</a> | <a href="/ai">New game</a></p>`;
  body += '<div style="margin-top:10px;font-size:12px;"><b>Difficulty:</b> ' + LOCAL_AI_LEVELS.map((l) => String(l.value) === String(diff) ? `<b>[${l.value}]</b>` : `<a href="${escapeHtml(linkBase({ fen: chess.fen(), diff: String(l.value), lm: lastMove }))}">${l.value}</a>`).join(' ') + '</div>';
  body += `<div style="margin-top:10px;font-size:12px;"><b>New game:</b> <a href="/ai/play?diff=${diff}&amp;color=w">White</a> | <a href="/ai/play?diff=${diff}&amp;color=b">Black</a></div>`;
  return htmlResponse(page('Play vs AI (no login)', body, s));
});

// ---------------------------------------------------------------- Game board

app.get('/game/:id', async (c) => {
  const s = session(c); if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id'); const size = boardSize(c); const moveRaw = (c.req.query('move') || '').trim();
  const selectedParam = (c.req.query('selected') || '').toLowerCase();
  const selected = SQUARE_RE.test(selectedParam) ? selectedParam : null;
  let game = null, error = null;
  try { game = ((await lichess.getPlaying(s.accessToken)).nowPlaying || []).find((g) => g.gameId === id) || null; } catch (e) { error = e.message; }
  // Make sure the watcher is running for this game on every load - it's
  // idempotent, so this is cheap, and it's what keeps Lichess from thinking
  // we've left between page loads.
  if (game) await startWatching(c, id);
  // Parse move AFTER fetching game so we have the FEN for SAN parsing
  if (moveRaw && game) {
    const moveUci = parseMoveInput(moveRaw, game.fen);
    if (!moveUci) return htmlResponse(errorPage('Invalid move', 'That move was not understood.', `/game/${id}#board`), 400);
    try {
      await lichess.boardMove(s.accessToken, id, moveUci);
      // Straight redirect back to the square you moved to (no intermediate page).
      return c.redirect(`/game/${id}#sq-${toSquare(moveUci)}`, 302);
    } catch (e) {
      return htmlResponse(errorPage('Move rejected', e.message, `/game/${id}#board`), 200);
    }
  }
  let body = ''; let refreshSeconds;
  const refreshUrl = `/game/${encodeURIComponent(id)}?r=${Date.now()}#board`;
  if (error) body += `<p>${escapeHtml(error)}</p>`;
  if (game) {
    const opp = game.opponent || {};
    const orientation = game.color === 'black' ? 'black' : 'white';
    const canMove = !!game.isMyTurn;
    // Stockfish / AI games are also played on this route - the player bars
    // and clocks are for multiplayer (real opponents) only. Lichess reports
    // AI opponents in TWO different shapes depending on how the game was
    // started: { aiLevel: N } OR { username: "Stockfish level N" } with no
    // aiLevel field - so check BOTH, otherwise AI games leak through.
    const oppNameStr = String(opp.username || opp.name || '');
    const isAiGame = !!opp.aiLevel || /stockfish/i.test(oppNameStr) || opp.title === 'AI';

    let myRatingStr = '', oppRatingStr = '';
    let myClock = null, oppClock = null;
    if (!isAiGame) {
      oppRatingStr = opp.rating ? ` (${opp.rating}${opp.provisional ? '?' : ''})` : '';
      try {
        const account = await lichess.getAccount(s.accessToken);
        const perf = (account.perfs || {})[game.perf || game.speed];
        if (perf && perf.rating) myRatingStr = ` (${perf.rating}${perf.prov ? '?' : ''})`;
      } catch {}
      // getPlaying() only exposes YOUR OWN secondsLeft, never the opponent's.
      // The game watcher sees both sides' clocks on every Board API stream
      // event, so ask it first; if it hasn't received anything yet (e.g. it
      // only just started), fall back to a one-shot stream read.
      let watch = await watcherState(c, id);
      if (!watch || typeof watch.wtime !== 'number') {
        try { watch = await lichess.boardGameState(s.accessToken, id); } catch { watch = null; }
      }
      const oppClockMs = (watch && typeof watch.wtime === 'number' && typeof watch.btime === 'number')
        ? (game.color === 'white' ? watch.btime : watch.wtime) : null;
      myClock = typeof game.secondsLeft === 'number' ? fmtClockSec(game.secondsLeft) : null;
      // Clockless/unlimited games report absurdly large values (the stream
      // sends a huge placeholder instead of a real clock) - never show those.
      oppClock = oppClockMs !== null && oppClockMs < 86400000 ? fmtClockMs(oppClockMs) : null;
    }

    if (!isAiGame) body += playerBar(`${opp.username || '?'}${oppRatingStr}`, { clock: oppClock, toMove: !canMove });
    body += renderBoard(game.fen, orientation, {
      size, interactive: canMove, selected: canMove ? selected : null, lastMove: game.lastMove || null,
      isOwnPiece: (sq, piece) => (game.color === 'white' ? piece === piece.toUpperCase() : piece === piece.toLowerCase()),
      selectHref: (sq) => `/game/${encodeURIComponent(id)}?selected=${sq}#sq-${sq}`,
      moveHref: (uci) => `/game/${encodeURIComponent(id)}?move=${uci}`,
    });
    if (!isAiGame) body += playerBar(`${s.username}${myRatingStr} - you (${game.color})`, { clock: myClock, toMove: canMove });

    body += canMove ? '<p><b>Your move - tap a piece, or type e4/Nf3.</b></p>' : '<p>Waiting for opponent... (auto-refreshes)</p>';
    body += `<p><a href="${refreshUrl}">Refresh board</a></p>`;
    if (canMove) {
      if (selected) body += `<p><a href="${refreshUrl}">[Cancel selection]</a></p>`;
      body += `<form method="post" action="/game/${encodeURIComponent(id)}/move"><p style="font-size:12px;">Type move (e4, Nf3, O-O, or e2e4): <input type="text" name="move" size="8" maxlength="6"> <input type="submit" value="Play"></p></form>`;
    }
    body += `<form method="post" action="/game/${encodeURIComponent(id)}/resign"><p><input type="submit" value="Resign"></p></form>`;
    if (!canMove && !selected) refreshSeconds = 15;
  } else {
    let finished = null; try { finished = await lichess.gameExport(id); } catch {}
    if (finished) {
      body += '<p>This game is not currently active.</p>';
      if (finished.status) body += `<p>Status: ${escapeHtml(finished.status)}</p>`;
      if (finished.winner) body += `<p>Winner: ${escapeHtml(finished.winner)}</p>`;
      if (finished.pgn) {
        try { const chess = new Chess(); chess.loadPgn(finished.pgn); const hist = chess.history({ verbose: true }); const last = hist[hist.length - 1]; const lastMove = last ? `${last.from}${last.to}${last.promotion || ''}` : null; body += renderBoard(chess.fen(), 'white', { size, lastMove }); } catch {}
      }
      body += `<p><a href="https://lichess.org/${encodeURIComponent(id)}">&gt; View on lichess.org</a></p>`;
    } else {
      body += '<p>Game not found or aborted.</p>';
      body += `<p>If this is a challenge, <a href="/challenge/${encodeURIComponent(id)}">check status</a>.</p>`;
    }
    body += `<p><a href="${refreshUrl}">Refresh</a> | <a href="/">Home</a></p>`;
  }
  return htmlResponse(page('Game', body, s, { refreshSeconds, refreshUrl }));
});

app.post('/game/:id/move', async (c) => {
  const s = session(c); if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id'); const form = await c.req.parseBody();
  // Fetch game to get FEN for SAN parsing
  let game = null;
  try { game = ((await lichess.getPlaying(s.accessToken)).nowPlaying || []).find((g) => g.gameId === id) || null; } catch {}
  const fen = game ? game.fen : START_FEN;
  const move = parseMoveInput(form.move, fen);
  if (!move) return htmlResponse(errorPage('Invalid move', 'Please enter a move like e4, Nf3, or e2e4.', `/game/${id}#board`), 400);
  try {
    await lichess.boardMove(s.accessToken, id, move);
    // 303: browser converts the POST into a GET of the anchored URL, landing
    // straight on the square you moved to instead of the top of the page.
    return c.redirect(`/game/${id}#sq-${toSquare(move)}`, 303);
  } catch (e) { return htmlResponse(errorPage('Move rejected', e.message, `/game/${id}#board`), 200); }
});

app.post('/game/:id/resign', async (c) => {
  const s = session(c); if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id');
  try {
    await lichess.boardResign(s.accessToken, id);
    await stopWatching(c, id);
    return htmlResponse(redirectPage('/', 'You resigned.'));
  } catch (e) { return htmlResponse(errorPage('Could not resign', e.message, `/game/${id}#board`), 200); }
});

// ---------------------------------------------------------------- Puzzles

const PUZZLE_ANGLE = 'mix', PUZZLE_BATCH_SIZE = 20;

app.get('/puzzle', async (c) => {
  const s = session(c);
  try {
    const cookies = parseCookies(c); let queue = (cookies['pzk'] || '').split(',').map((x) => x.trim()).filter(Boolean); let id;
    if (queue.length > 0) { id = queue.shift(); }
    else {
      let batch = null; try { batch = await lichess.puzzleBatch(s ? s.accessToken : null, PUZZLE_ANGLE, PUZZLE_BATCH_SIZE); } catch { batch = null; }
      const ids = (batch && Array.isArray(batch.puzzles) ? batch.puzzles : []).map((p) => p && p.puzzle && p.puzzle.id).filter(Boolean);
      if (ids.length > 0) { id = ids.shift(); queue = ids; }
      else { const fallback = s ? await lichess.puzzleNext(s.accessToken) : await lichess.puzzleDaily(); id = fallback && fallback.puzzle && fallback.puzzle.id; }
    }
    if (!id) throw new Error('Lichess did not return a puzzle.');
    const extraHeaders = { 'Set-Cookie': queue.length > 0 ? `pzk=${queue.join(',')}; Path=/; Max-Age=86400` : 'pzk=; Path=/; Max-Age=0' };
    return htmlResponse(redirectPage(`/puzzle/${id}?step=0#board`, 'Loading puzzle...'), 200, extraHeaders);
  } catch (e) { return htmlResponse(errorPage('Could not load puzzle', e.message, '/'), 500); }
});

app.get('/puzzle/:id', async (c) => {
  const s = session(c); const id = c.req.param('id'); const pid = encodeURIComponent(id);
  const size = boardSize(c); const step = parseStep(c.req.query('step')); const msg = c.req.query('msg');
  let puzzle; try { puzzle = await lichess.puzzleById(s ? s.accessToken : null, id); } catch (e) { return htmlResponse(errorPage('Could not load puzzle', e.message, newPuzzleHref())); }
  let base, solution;
  try { base = puzzleBasePosition(puzzle); solution = ((puzzle.puzzle && puzzle.puzzle.solution) || []).map(normalizeUci); } catch (e) { return htmlResponse(errorPage('Puzzle setup error', e.message, newPuzzleHref()), 500); }
  const solverColor = sideToMove(base.fen); let state;
  try { state = puzzleStateFrom(base.fen, solution, step); } catch (e) { return htmlResponse(errorPage('Puzzle setup error', e.message, newPuzzleHref()), 500); }
  const lastMove = state.step > 0 ? solution[state.step - 1] : null;

  // Typed/linked move.
  const moveRaw = (c.req.query('move') || '').trim();
  if (moveRaw) {
    const guess = parseMoveInput(moveRaw, state.fen);
    if (!guess) return htmlResponse(errorPage('Invalid move', 'That move was not understood.', `/puzzle/${id}?step=${step}#board`), 400);
    const result = checkPuzzleGuess(solution, state.step, guess);
    if (result.correct) return c.redirect(`/puzzle/${pid}?step=${result.newStep}&msg=correct#sq-${toSquare(guess)}`, 302);
    const kind = result.wrongPromotion ? 'promo' : 'wrong';
    return c.redirect(`/puzzle/${pid}?step=${step}&msg=${kind}#board`, 302);
  }

  // "Show solution": auto-play the correct move for the current step.
  if (c.req.query('reveal') === '1' && !state.solved) {
    const mv = solution[state.step];
    const result = checkPuzzleGuess(solution, state.step, mv);
    if (result.correct) return c.redirect(`/puzzle/${pid}?step=${result.newStep}&msg=revealed#sq-${toSquare(mv)}`, 302);
  }

  const selectedParam = (c.req.query('selected') || '').toLowerCase();
  const selected = SQUARE_RE.test(selectedParam) ? selectedParam : null;
  let body = '';
  if (msg === 'wrong') body += '<p><b style="color:#cc0000;">Not quite - try again.</b></p>';
  if (msg === 'promo') body += '<p><b style="color:#cc0000;">Right square, wrong promotion. Type e.g. e7e8n.</b></p>';
  if (msg === 'correct') body += '<p><b style="color:#006600;">Correct!</b></p>';
  if (msg === 'revealed') body += '<p><b style="color:#996600;">Solution move played.</b></p>';
  const refreshUrl = `/puzzle/${pid}?step=${state.step}#board`;
  if (state.solved) {
    body += renderBoard(state.fen, solverColor, { size, lastMove });
    body += `<p>Puzzle rating: ${escapeHtml(puzzle.puzzle.rating)}</p><p><b>Puzzle solved!</b></p><p><a href="${newPuzzleHref()}">&gt;&gt; Next puzzle</a></p>`;
  } else {
    body += renderBoard(state.fen, solverColor, {
      size, interactive: true, selected, lastMove,
      isOwnPiece: (sq, piece) => (solverColor === 'white' ? piece === piece.toUpperCase() : piece === piece.toLowerCase()),
      selectHref: (sq) => `/puzzle/${pid}?step=${state.step}&selected=${sq}#sq-${sq}`,
      moveHref: (uci) => `/puzzle/${pid}?step=${state.step}&move=${uci}`,
    });
    body += `<p>Puzzle rating: ${escapeHtml(puzzle.puzzle.rating)}</p><p>Find the best move for <b>${escapeHtml(solverColor)}</b> - tap a piece, or type e4/Nf3.</p>`;
    if (selected) body += `<p><a href="${refreshUrl}">[Cancel selection]</a></p>`;
    body += `<form method="post" action="/puzzle/${pid}"><input type="hidden" name="step" value="${state.step}"><p style="font-size:12px;">Type move (e4, Nf3, O-O, or e2e4): <input type="text" name="move" size="8" maxlength="6"> <input type="submit" value="Submit"></p></form>`;
    body += `<p><a href="/puzzle/${pid}?step=${state.step}&amp;reveal=1#board">Show solution (auto-plays the correct move)</a></p>`;
  }
  body += `<p><a href="${refreshUrl}">Refresh</a> | <a href="${newPuzzleHref()}">New puzzle</a></p>`;
  return htmlResponse(page('Puzzle', body, s));
});

app.post('/puzzle/:id', async (c) => {
  const s = session(c); const id = c.req.param('id'); const form = await c.req.parseBody(); const step = parseStep(form.step);
  let puzzle; try { puzzle = await lichess.puzzleById(s ? s.accessToken : null, id); } catch (e) { return htmlResponse(errorPage('Could not load puzzle', e.message, newPuzzleHref())); }
  let base, solution;
  try {
    base = puzzleBasePosition(puzzle);
    solution = ((puzzle.puzzle && puzzle.puzzle.solution) || []).map(normalizeUci);
  } catch (e) { return htmlResponse(errorPage('Puzzle setup error', e.message, newPuzzleHref()), 500); }
  const guess = parseMoveInput(form.move, applyUciMoves(base.fen, solution.slice(0, step)));
  if (!guess) return c.redirect(`/puzzle/${id}?step=${step}#board`, 303);
  const result = checkPuzzleGuess(solution, step, guess);
  if (result.correct) return c.redirect(`/puzzle/${id}?step=${result.newStep}&msg=correct#sq-${toSquare(guess)}`, 303);
  const kind = result.wrongPromotion ? 'promo' : 'wrong';
  return c.redirect(`/puzzle/${id}?step=${step}&msg=${kind}#board`, 303);
});

app.notFound((c) => htmlResponse(errorPage('Not found', 'That page does not exist.'), 404));
app.onError((err, c) => { console.error(err); return htmlResponse(errorPage('Something went wrong', err.message), 500); });

export default app;

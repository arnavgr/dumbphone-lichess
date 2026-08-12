import { Hono } from 'hono';
import { Chess } from 'chess.js';
import {
  randomString,
  codeChallengeS256,
  getSession,
  createSession,
  destroySession,
  saveOAuthState,
  consumeOAuthState,
  sessionCookie,
  clearedSessionCookie,
  parseCookies,
} from './lichess.js';
import * as lichess from './lichess.js';
import {
  renderBoard,
  sideToMove,
  puzzleBasePosition,
  puzzleStateFrom,
  normalizeUci,
  pickAiMove,
  applyAiMove,
  BOARD_SIZE_KEYS,
} from './chess.js';
import {
  page,
  redirectPage,
  errorPage,
  htmlResponse,
  escapeHtml,
  selectField,
  renderGamesList,
} from './ui.js';
import { TIME_CONTROLS, findTimeControl, AI_LEVELS, LOCAL_AI_LEVELS } from './constants.js';

const app = new Hono();

const UCI_MOVE_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const SQUARE_RE = /^[a-h][1-8]$/;
const LICHESS_SCOPES = ['board:play', 'challenge:read', 'challenge:write', 'puzzle:read'];
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

app.use('*', async (c, next) => {
  try {
    c.set('session', await getSession(c));
  } catch {
    c.set('session', null);
  }
  await next();
});

const session = (c) => c.get('session') || null;

// Board size picked on /settings, stored in the "bsize" cookie (works
// logged-out and persists across pages/visits).
function boardSize(c) {
  const v = parseCookies(c)['bsize'];
  return BOARD_SIZE_KEYS.includes(v) ? v : 'normal';
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
    if (solution[newStep]) newStep += 1; // auto-play the opponent's forced reply
    return { correct: true, newStep };
  }
  const wrongPromotion =
    g.length >= 4 && expected.length >= 5 && g !== expected && g.slice(0, 4) === expected.slice(0, 4);
  return { correct: false, wrongPromotion };
}

function describeChallenge(ch) {
  const tc = ch.timeControl || {};
  let speed = '';
  if (tc.type === 'clock') speed = `${Math.round((tc.limit || 0) / 60)}+${tc.increment || 0}`;
  else speed = tc.type || '';
  return `${ch.rated ? 'Rated' : 'Casual'} ${speed}`.trim();
}

// ---------------------------------------------------------------- Settings
const SIZE_HINTS = {
  tiny: 'very small screens (128x160)',
  small: 'small screens (~160px wide)',
  normal: '240x320 screens',
  large: '320px+ wide screens',
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
    body += active
      ? '<b style="color:#006600;">[current]</b>'
      : `<a href="/settings?s=${k}">Use this size</a>`;
    body += '</p>';
    body += renderBoard(START_FEN, 'white', { size: k });
  }
  return htmlResponse(page('Board size', body, s), 200, extraHeaders);
});

// ---------------------------------------------------------------- Home
app.get('/', async (c) => {
  const s = session(c);
  if (!s) {
    const body = `
<p>Play Lichess chess on a basic phone browser - no smartphone needed.</p>
<p><a href="/puzzle">&gt;&gt; Solve a puzzle (no login needed)</a></p>
<p><a href="/ai">&gt;&gt; Play vs a computer (no login needed)</a></p>
<p><a href="/login">&gt;&gt; Login with Lichess to play other people</a></p>
<p style="font-size:12px;">Note: without login, Lichess only serves one puzzle per day. Log in for unlimited puzzles and multiplayer.</p>`;
    return htmlResponse(page('Lichess Dumbphone', body, s));
  }

  let nowPlaying = [];
  let incoming = [];
  let loadError = null;
  try {
    nowPlaying = (await lichess.getPlaying(s.accessToken)).nowPlaying || [];
  } catch (e) {
    loadError = e.message;
  }
  try {
    incoming = (await lichess.challengeList(s.accessToken)).in || [];
  } catch {
    // non-fatal
  }

  let body = '';
  if (loadError) body += `<p>Could not load your games: ${escapeHtml(loadError)}</p>`;

  if (incoming.length > 0) {
    body += '<h4 style="margin:8px 0 4px;">Incoming challenges</h4>';
    for (const ch of incoming) {
      const from = (ch.challenger && (ch.challenger.name || ch.challenger.username)) || 'Someone';
      body += `<p><b>${escapeHtml(from)}</b> challenges you - ${escapeHtml(describeChallenge(ch))}</p>`;
      body += `<form method="post" action="/challenge/${escapeHtml(ch.id)}/accept" style="display:inline;margin:0;"><input type="submit" value="Accept"></form> `;
      body += `<form method="post" action="/challenge/${escapeHtml(ch.id)}/decline" style="display:inline;margin:0;"><input type="submit" value="Decline"></form>`;
    }
    body += '<hr>';
  }

  if (nowPlaying.length > 0) {
    const first = nowPlaying.find((g) => g.isMyTurn) || nowPlaying[0];
    const oppName = (first.opponent && first.opponent.username) || 'opponent';
    const oppRating = first.opponent && first.opponent.rating ? ` (${first.opponent.rating})` : '';
    body += '<p><b>You have a game in progress.</b></p>';
    body += `<p><a href="/game/${escapeHtml(first.gameId)}">&gt;&gt; Continue vs ${escapeHtml(oppName)}${oppRating}${first.isMyTurn ? ' (your move)' : ''}</a></p>`;
    if (nowPlaying.length > 1) body += renderGamesList(nowPlaying);
  } else {
    body += '<p>No games in progress.</p>';
  }

  body += '<p><a href="/">Refresh</a></p><hr>';
  body += '<p><a href="/game/new/multiplayer">&gt;&gt; Play multiplayer</a></p>';
  body += '<p><a href="/game/new/ai">&gt;&gt; Play vs AI (Lichess)</a></p>';
  body += '<p><a href="/ai">&gt;&gt; Play vs AI (no login)</a></p>';
  body += '<p><a href="/puzzle">&gt;&gt; Solve a puzzle</a></p>';
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
  body += configured
    ? '<p><a href="/login/oauth">&gt;&gt; Continue to Lichess</a></p>'
    : "<p>Not available: LICHESS_CLIENT_ID / REDIRECT_URI aren't set in wrangler.toml.</p>";
  body += '<hr><h4 style="margin:8px 0 4px;">Option B - Paste a personal API token</h4>';
  body += `<p><a href="${escapeHtml(tokenCreateUrl())}">&gt;&gt; Create a token on lichess.org</a> (opens with the right permissions already checked)</p>`;
  body += `
<form method="post" action="/login/token">
<p>Paste your token: <input type="text" name="token" size="30"></p>
<p><input type="submit" value="Log in with token"></p>
</form>`;
  return htmlResponse(page('Login', body, s));
});

app.get('/login/oauth', async (c) => {
  const clientId = c.env.LICHESS_CLIENT_ID;
  const redirectUri = c.env.REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return htmlResponse(errorPage('Not configured', 'LICHESS_CLIENT_ID and REDIRECT_URI must be set in wrangler.toml.'), 500);
  }
  const verifier = randomString(48);
  const state = randomString(24);
  await saveOAuthState(c, state, verifier);
  const challenge = await codeChallengeS256(verifier);
  const authUrl = new URL('https://lichess.org/oauth');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', LICHESS_SCOPES.join(' '));
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('state', state);
  return htmlResponse(redirectPage(authUrl.toString(), 'Taking you to Lichess to log in...'));
});

app.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const errorParam = c.req.query('error');
  if (errorParam) return htmlResponse(errorPage('Login cancelled', `Lichess said: ${errorParam}`, '/login'));
  if (!code || !state) return htmlResponse(errorPage('Login failed', 'Missing code or state from Lichess.', '/login'), 400);
  let verifier;
  try {
    verifier = await consumeOAuthState(c, state);
  } catch {
    verifier = null;
  }
  if (!verifier) {
    return htmlResponse(errorPage('Login failed', 'Your login attempt expired or was already used. Try again.', '/login'), 400);
  }
  try {
    const tokenData = await lichess.exchangeCodeForToken({
      code,
      verifier,
      redirectUri: c.env.REDIRECT_URI,
      clientId: c.env.LICHESS_CLIENT_ID,
    });
    const account = await lichess.getAccount(tokenData.access_token);
    const sid = await createSession(c, { accessToken: tokenData.access_token, username: account.username });
    // Set-Cookie goes INTO htmlResponse so it actually ships on the Response.
    return htmlResponse(redirectPage('/', `Logged in as ${account.username}.`), 200, {
      'Set-Cookie': sessionCookie(sid),
    });
  } catch (e) {
    return htmlResponse(errorPage('Login failed', e.message, '/login'), 400);
  }
});

app.post('/login/token', async (c) => {
  const form = await c.req.parseBody();
  const token = String(form.token || '').trim();
  if (!token) return htmlResponse(errorPage('Missing token', 'Please paste a Lichess API token.', '/login'), 400);
  try {
    const account = await lichess.getAccount(token);
    const sid = await createSession(c, { accessToken: token, username: account.username });
    return htmlResponse(redirectPage('/', `Logged in as ${account.username}.`), 200, {
      'Set-Cookie': sessionCookie(sid),
    });
  } catch (e) {
    return htmlResponse(errorPage('Login failed', `That token didn't work (${e.message}).`, '/login'), 400);
  }
});

app.get('/logout', async (c) => {
  const s = session(c);
  if (s) {
    try {
      await destroySession(c, s.id);
    } catch {
      // still clear the cookie
    }
  }
  return htmlResponse(redirectPage('/', 'Logged out.'), 200, { 'Set-Cookie': clearedSessionCookie() });
});

// ---------------------------------------------------------------- vs AI (Lichess)
app.get('/game/new/ai', async (c) => {
  const s = session(c);
  if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const body = `
<form method="post" action="/game/new/ai">
<p>Level: ${selectField('level', AI_LEVELS.map((l) => ({ value: l, label: `Level ${l}` })), 3)}</p>
<p>Your color: ${selectField('color', [{ value: 'random', label: 'Random' }, { value: 'white', label: 'White' }, { value: 'black', label: 'Black' }], 'random')}</p>
<p>Time control: ${selectField('timeControl', TIME_CONTROLS, 'rapid-600-0')}</p>
<p><input type="submit" value="Start game"></p>
</form>`;
  return htmlResponse(page('Play vs AI (Lichess)', body, s));
});

app.post('/game/new/ai', async (c) => {
  const s = session(c);
  if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const form = await c.req.parseBody();
  const tc = findTimeControl(form.timeControl);
  const params = { level: form.level, color: form.color, variant: 'standard', ...timeControlParams(tc) };
  try {
    const res = await lichess.challengeAI(s.accessToken, params);
    const gameId = (res.game && res.game.id) || res.id || (res.challenge && res.challenge.id);
    if (!gameId) throw new Error('Lichess did not return a game id.');
    return htmlResponse(redirectPage(`/game/${gameId}`, 'Game created!'));
  } catch (e) {
    return htmlResponse(errorPage('Could not start game', e.message, '/game/new/ai'));
  }
});

// ---------------------------------------------------------------- Multiplayer
app.get('/game/new/multiplayer', async (c) => {
  const s = session(c);
  if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const colorField = selectField('color', [{ value: 'random', label: 'Random' }, { value: 'white', label: 'White' }, { value: 'black', label: 'Black' }], 'random');
  const ratedCasual = selectField('rated', [{ value: 'false', label: 'Casual' }, { value: 'true', label: 'Rated' }], 'false');
  const ratedDefault = selectField('rated', [{ value: 'true', label: 'Rated' }, { value: 'false', label: 'Casual' }], 'true');
  const body = `
<h4 style="margin:8px 0 4px;">1) Quick pair - play a random opponent</h4>
<p>Searches the real Lichess matchmaking pool. Default is RATED.</p>
<form method="post" action="/game/new/multiplayer/quick">
<p>Time control: ${selectField('timeControl', TIME_CONTROLS, 'rapid-600-0')}</p>
<p>${ratedDefault}</p>
<p><input type="submit" value="Find opponent"></p>
</form>
<hr>
<h4 style="margin:8px 0 4px;">2) Challenge a Lichess username</h4>
<form method="post" action="/game/new/multiplayer/user">
<p>Username: <input type="text" name="username" size="16"></p>
<p>Your color: ${colorField}</p>
<p>Time control: ${selectField('timeControl', TIME_CONTROLS, 'rapid-600-0')}</p>
<p>${ratedCasual}</p>
<p><input type="submit" value="Send challenge"></p>
</form>
<hr>
<h4 style="margin:8px 0 4px;">3) Shareable link (open challenge)</h4>
<form method="post" action="/game/new/multiplayer/open">
<p>Time control: ${selectField('timeControl', TIME_CONTROLS, 'rapid-600-0')}</p>
<p>${ratedCasual}</p>
<p><input type="submit" value="Create link"></p>
</form>`;
  return htmlResponse(page('Play multiplayer', body, s));
});

// Quick pair: don't hold the phone's request open. Snapshot existing games,
// run the seek in the background, send the phone to an auto-refreshing
// /searching page. A "new" game = one not in the snapshot.
app.post('/game/new/multiplayer/quick', async (c) => {
  const s = session(c);
  if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const form = await c.req.parseBody();
  const tc = findTimeControl(form.timeControl);
  const rated = form.rated === 'false' ? 'false' : 'true';
  let exclude = [];
  try {
    exclude = ((await lichess.getPlaying(s.accessToken)).nowPlaying || []).map((g) => g.gameId);
  } catch {
    // ignore
  }
  const seekParams = { rated, time: Math.round(tc.clock.limit / 60), increment: tc.clock.increment };
  const searchUrl =
    `/searching?started=${Date.now()}&tc=${encodeURIComponent(tc.value)}&rated=${rated}` +
    (exclude.length ? `&exclude=${encodeURIComponent(exclude.join(','))}` : '');
  try {
    c.executionCtx.waitUntil(lichess.quickPairSeek(s.accessToken, seekParams, 90000).catch(() => {}));
  } catch {
    try {
      await lichess.quickPairSeek(s.accessToken, seekParams, 20000);
    } catch {
      // /searching will time out and say so
    }
  }
  return htmlResponse(redirectPage(searchUrl, 'Joining the matchmaking pool...'));
});

app.get('/searching', async (c) => {
  const s = session(c);
  if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const started = Number(c.req.query('started')) || Date.now();
  const excludeParam = c.req.query('exclude') || '';
  const exclude = excludeParam.split(',').map((x) => x.trim()).filter(Boolean);
  const tcValue = c.req.query('tc') || '';
  const rated = c.req.query('rated') !== 'false';
  const tc = findTimeControl(tcValue);
  const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
  const selfUrl =
    `/searching?started=${started}&tc=${encodeURIComponent(tcValue)}&rated=${rated ? 'true' : 'false'}` +
    (excludeParam ? `&exclude=${encodeURIComponent(excludeParam)}` : '');

  let list = [];
  let err = null;
  try {
    list = (await lichess.getPlaying(s.accessToken)).nowPlaying || [];
  } catch (e) {
    err = e.message;
  }
  const newGame = list.find((g) => !exclude.includes(g.gameId));
  if (newGame) return htmlResponse(redirectPage(`/game/${newGame.gameId}`, 'Opponent found!'));

  if (elapsed > 90) {
    const body = `
<p>No opponent found within 90 seconds for ${escapeHtml(tc.label)} ${rated ? 'rated' : 'casual'}.</p>
<p>The search may still be running on the server - if someone joins, the game will appear on your home page.</p>
<p><a href="/game/new/multiplayer">&gt;&gt; Back to multiplayer</a> | <a href="/">&gt;&gt; Home</a></p>`;
    return htmlResponse(page('Quick pair', body, s));
  }
  const body = `
<p><b>Looking for a ${rated ? 'RATED' : 'casual'} ${escapeHtml(tc.label)} opponent... (${elapsed}s)</b></p>
<p>This page checks automatically every few seconds.</p>
<p><a href="${escapeHtml(selfUrl)}">Check now</a></p>
${err ? `<p style="font-size:12px;">${escapeHtml(err)}</p>` : ''}`;
  return htmlResponse(page('Searching for opponent', body, s, { refreshSeconds: 5 }));
});

app.post('/game/new/multiplayer/user', async (c) => {
  const s = session(c);
  if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const form = await c.req.parseBody();
  const username = String(form.username || '').trim();
  if (!username) return htmlResponse(errorPage('Missing username', 'Please enter a Lichess username.', '/game/new/multiplayer'), 400);
  const tc = findTimeControl(form.timeControl);
  const params = { rated: form.rated, color: form.color, variant: 'standard', ...timeControlParams(tc) };
  try {
    const res = await lichess.challengeUser(s.accessToken, username, params);
    const challengeId = (res.challenge && res.challenge.id) || res.id;
    return htmlResponse(redirectPage(`/challenge/${challengeId}`, `Challenge sent to ${username}.`));
  } catch (e) {
    return htmlResponse(errorPage('Could not send challenge', e.message, '/game/new/multiplayer'));
  }
});

app.post('/game/new/multiplayer/open', async (c) => {
  const s = session(c);
  if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const form = await c.req.parseBody();
  const tc = findTimeControl(form.timeControl);
  const params = { rated: form.rated, variant: 'standard', ...timeControlParams(tc) };
  try {
    const res = await lichess.challengeOpen(s.accessToken, params);
    const id = (res.challenge && res.challenge.id) || res.id;
    const url = (res.challenge && res.challenge.url) || res.url;
    const body = `
<p>Share this link with your opponent. The game starts when they open it:</p>
<p><b>${escapeHtml(url || '(no url returned)')}</b></p>
<p><a href="/challenge/${escapeHtml(id)}">&gt;&gt; Check status / wait</a></p>`;
    return htmlResponse(page('Open challenge created', body, s));
  } catch (e) {
    return htmlResponse(errorPage('Could not create challenge', e.message, '/game/new/multiplayer'));
  }
});

// ---------------------------------------------------------------- Challenges
app.get('/challenge/:id', async (c) => {
  const s = session(c);
  if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id');
  let info = null;
  let error = null;
  try {
    info = await lichess.challengeShow(s.accessToken, id);
  } catch (e) {
    error = e.message;
  }
  const ch = (info && (info.challenge || info)) || {};
  if (ch.status === 'accepted') return htmlResponse(redirectPage(`/game/${id}`, 'Challenge accepted! Loading game...'));
  let body = '';
  if (error) body += `<p>${escapeHtml(error)}</p>`;
  else {
    body += `<p>Status: <b>${escapeHtml(ch.status || 'unknown')}</b></p>`;
    const url = ch.url || (info && info.url);
    if (url) body += `<p>Share link:<br><b>${escapeHtml(url)}</b></p>`;
  }
  body += `<p><a href="/challenge/${escapeHtml(id)}">Refresh status</a></p>`;
  body += `<p><a href="/game/${escapeHtml(id)}">Try opening the game directly</a></p>`;
  if (!ch.status || ch.status === 'created' || ch.status === 'sent') {
    body += `<form method="post" action="/challenge/${escapeHtml(id)}/cancel"><p><input type="submit" value="Cancel challenge"></p></form>`;
  }
  return htmlResponse(page('Challenge status', body, s, { refreshSeconds: error ? undefined : 10 }));
});

app.post('/challenge/:id/accept', async (c) => {
  const s = session(c);
  if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id');
  try {
    await lichess.challengeAccept(s.accessToken, id);
    return htmlResponse(redirectPage(`/game/${id}`, 'Challenge accepted!'));
  } catch (e) {
    return htmlResponse(errorPage('Could not accept challenge', e.message, '/'));
  }
});

app.post('/challenge/:id/decline', async (c) => {
  const s = session(c);
  if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id');
  try {
    await lichess.challengeDecline(s.accessToken, id);
    return htmlResponse(redirectPage('/', 'Challenge declined.'));
  } catch (e) {
    return htmlResponse(errorPage('Could not decline challenge', e.message, '/'));
  }
});

app.post('/challenge/:id/cancel', async (c) => {
  const s = session(c);
  if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id');
  try {
    await lichess.challengeCancel(s.accessToken, id);
    return htmlResponse(redirectPage('/', 'Challenge cancelled.'));
  } catch (e) {
    return htmlResponse(errorPage('Could not cancel challenge', e.message, '/'));
  }
});

// ---------------------------------------------------------------- vs AI, no login
app.get('/ai', async (c) => {
  const s = session(c);
  const body = `
<p>Play vs a computer - no Lichess account needed.</p>
<form method="get" action="/ai/play">
<p>Difficulty: ${selectField('diff', LOCAL_AI_LEVELS, 1)}</p>
<p>Your color: ${selectField('color', [{ value: 'w', label: 'White' }, { value: 'b', label: 'Black' }], 'w')}</p>
<p><input type="submit" value="Start game"></p>
</form>`;
  return htmlResponse(page('Play vs AI (no login)', body, s));
});

app.get('/ai/play', async (c) => {
  const s = session(c);
  const size = boardSize(c);
  const q = c.req.query();
  let diff = parseInt(q.diff, 10);
  if (!Number.isFinite(diff) || diff < 0) diff = 1;
  if (diff > 4) diff = 4;
  const color = q.color === 'b' ? 'b' : 'w';
  const fenParam = q.fen || null;
  const moveParam = (q.move || '').toLowerCase();
  const selectedParam = (q.selected || '').toLowerCase();
  const selected = SQUARE_RE.test(selectedParam) ? selectedParam : null;

  const linkBase = (extra = {}) => {
    const params = new URLSearchParams();
    params.set('diff', String(diff));
    params.set('color', color);
    for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
    return `/ai/play?${params.toString()}`;
  };

  let chess;
  let resetMessage = null;
  try {
    chess = fenParam ? new Chess(fenParam) : new Chess();
  } catch {
    chess = new Chess();
    resetMessage = 'That position was invalid, so this is a fresh game.';
  }

  if (!fenParam && color === 'b' && !resetMessage) applyAiMove(chess, await pickAiMove(chess, diff));

  if (moveParam) {
    if (!UCI_MOVE_RE.test(moveParam)) {
      return htmlResponse(errorPage('Invalid move', 'That move was not understood.', linkBase({ fen: chess.fen() })), 400);
    }
    try {
      chess.move({ from: moveParam.slice(0, 2), to: moveParam.slice(2, 4), promotion: moveParam.slice(4, 5) || undefined });
    } catch {
      return htmlResponse(errorPage('Illegal move', 'That move is not legal here.', linkBase({ fen: chess.fen() })), 200);
    }
    if (!chess.isGameOver()) applyAiMove(chess, await pickAiMove(chess, diff));
    return htmlResponse(redirectPage(linkBase({ fen: chess.fen() }), 'Move played.'));
  }

  if (!chess.isGameOver() && chess.turn() !== color) {
    applyAiMove(chess, await pickAiMove(chess, diff));
    return htmlResponse(redirectPage(linkBase({ fen: chess.fen() }), 'AI is thinking...'));
  }

  const orientation = color === 'b' ? 'black' : 'white';
  const isOver = chess.isGameOver();
  let message;
  let msgColor;
  if (resetMessage) {
    message = resetMessage; msgColor = '#cc0000';
  } else if (chess.isCheckmate()) {
    message = chess.turn() === color ? 'Checkmate - you lose. Game over.' : 'Checkmate - you win! Game over.'; msgColor = '#000099';
  } else if (chess.isStalemate()) {
    message = 'Stalemate. Game over.'; msgColor = '#000099';
  } else if (chess.isDraw()) {
    message = 'Draw. Game over.'; msgColor = '#000099';
  } else if (chess.isCheck()) {
    message = 'Check! Your move.'; msgColor = '#cc0000';
  } else {
    message = 'Your move - tap a piece, then tap a highlighted square.'; msgColor = '#006600';
  }

  let body = `<p><b style="color:${msgColor};">${escapeHtml(message)}</b></p>`;
  body += renderBoard(chess.fen(), orientation, {
    size,
    interactive: !isOver,
    selected: selected && !isOver ? selected : null,
    isOwnPiece: (sq, piece) => (color === 'w' ? piece === piece.toUpperCase() : piece === piece.toLowerCase()),
    selectHref: (sq) => linkBase({ fen: chess.fen(), selected: sq }),
    moveHref: (uci) => linkBase({ fen: chess.fen(), move: uci }),
  });
  if (selected && !isOver) body += `<p><a href="${escapeHtml(linkBase({ fen: chess.fen() }))}">[Cancel selection]</a></p>`;
  body += `<p><a href="${escapeHtml(linkBase({ fen: chess.fen() }))}">Refresh</a> | <a href="/ai">New game (options)</a></p>`;
  body += '<div style="margin-top:10px;font-size:12px;"><b>Difficulty:</b> ';
  body += LOCAL_AI_LEVELS.map((l) =>
    String(l.value) === String(diff)
      ? `<b>[${l.value}]</b>`
      : `<a href="${escapeHtml(linkBase({ fen: chess.fen(), diff: String(l.value) }))}">${l.value}</a>`
  ).join(' ');
  body += '</div>';
  body += `<div style="margin-top:10px;font-size:12px;"><b>New game:</b> <a href="/ai/play?diff=${diff}&amp;color=w">White</a> | <a href="/ai/play?diff=${diff}&amp;color=b">Black</a></div>`;
  return htmlResponse(page('Play vs AI (no login)', body, s));
});

// ---------------------------------------------------------------- Game board
app.get('/game/:id', async (c) => {
  const s = session(c);
  if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id');
  const size = boardSize(c);

  const moveParam = (c.req.query('move') || '').toLowerCase();
  if (moveParam) {
    if (!UCI_MOVE_RE.test(moveParam)) {
      return htmlResponse(errorPage('Invalid move', 'That move was not understood.', `/game/${id}`), 400);
    }
    try {
      await lichess.boardMove(s.accessToken, id, moveParam);
      return htmlResponse(redirectPage(`/game/${id}`, 'Move played.'));
    } catch (e) {
      return htmlResponse(errorPage('Move rejected', e.message, `/game/${id}`), 200);
    }
  }

  const selectedParam = (c.req.query('selected') || '').toLowerCase();
  const selected = SQUARE_RE.test(selectedParam) ? selectedParam : null;

  let game = null;
  let error = null;
  try {
    game = ((await lichess.getPlaying(s.accessToken)).nowPlaying || []).find((g) => g.gameId === id) || null;
  } catch (e) {
    error = e.message;
  }

  let body = '';
  let refreshSeconds;
  if (error) body += `<p>${escapeHtml(error)}</p>`;

  if (game) {
    // Ratings: opponent's comes with the game; ours needs /api/account keyed
    // by the game's perf/speed (e.g. "rapid"/"classical").
    let myRatingStr = '';
    try {
      const account = await lichess.getAccount(s.accessToken);
      const perf = (account.perfs || {})[game.perf || game.speed];
      if (perf && perf.rating) myRatingStr = ` (${perf.rating}${perf.prov ? '?' : ''})`;
    } catch {
      // rating is cosmetic - never block the game on it
    }
    const opp = game.opponent || {};
    const oppStr = opp.rating
      ? ` (${opp.rating}${opp.provisional ? '?' : ''})`
      : opp.aiLevel ? ` (AI level ${opp.aiLevel})` : '';

    const orientation = game.color === 'black' ? 'black' : 'white';
    const canMove = !!game.isMyTurn;
    body += renderBoard(game.fen, orientation, {
      size,
      interactive: canMove,
      selected: canMove ? selected : null,
      isOwnPiece: (sq, piece) => (game.color === 'white' ? piece === piece.toUpperCase() : piece === piece.toLowerCase()),
      selectHref: (sq) => `/game/${encodeURIComponent(id)}?selected=${sq}`,
      moveHref: (uci) => `/game/${encodeURIComponent(id)}?move=${uci}`,
    });
    body += `<p>You${myRatingStr} as <b>${escapeHtml(game.color)}</b> vs <b>${escapeHtml(opp.username || '?')}</b>${oppStr}</p>`;
    body += canMove
      ? '<p><b>Your move - tap a piece, then tap a highlighted square.</b></p>'
      : '<p>Waiting for opponent... (this page refreshes automatically)</p>';
    if (typeof game.secondsLeft === 'number') {
      const m = Math.floor(game.secondsLeft / 60);
      const sec = game.secondsLeft % 60;
      body += `<p>Time left: ${m}m ${sec}s</p>`;
    }
    body += `<p><a href="/game/${encodeURIComponent(id)}">Refresh board</a></p>`;
    if (canMove) {
      if (selected) body += `<p><a href="/game/${encodeURIComponent(id)}">[Cancel selection]</a></p>`;
      body += `
<form method="post" action="/game/${encodeURIComponent(id)}/move">
<p style="font-size:12px;">Need underpromotion (e.g. e7e8n)? Type the move:
<input type="text" name="move" size="8" maxlength="6"> <input type="submit" value="Play"></p>
</form>`;
    }
    body += `<form method="post" action="/game/${encodeURIComponent(id)}/resign"><p><input type="submit" value="Resign"></p></form>`;
    if (!canMove && !selected) refreshSeconds = 15;
  } else {
    let finished = null;
    try {
      finished = await lichess.gameExport(id);
    } catch {
      // ignore
    }
    if (finished) {
      body += '<p>This game is not currently active.</p>';
      if (finished.status) body += `<p>Status: ${escapeHtml(finished.status)}</p>`;
      if (finished.winner) body += `<p>Winner: ${escapeHtml(finished.winner)}</p>`;
      if (finished.pgn) {
        try {
          const chess = new Chess();
          chess.loadPgn(finished.pgn);
          body += renderBoard(chess.fen(), 'white', { size });
        } catch {
          // best effort
        }
      }
    } else {
      body += '<p>Game not found, not yet started, or you are not a player in it.</p>';
      body += `<p>If this is a challenge you just created, <a href="/challenge/${encodeURIComponent(id)}">check its status here</a>.</p>`;
    }
    body += `<p><a href="/game/${encodeURIComponent(id)}">Refresh</a> | <a href="/">Home</a></p>`;
  }
  return htmlResponse(page('Game', body, s, { refreshSeconds }));
});

app.post('/game/:id/move', async (c) => {
  const s = session(c);
  if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id');
  const form = await c.req.parseBody();
  const move = normalizeUci(form.move);
  if (!move) return htmlResponse(errorPage('Invalid move', 'Please enter a move like e2e4.', `/game/${id}`), 400);
  try {
    await lichess.boardMove(s.accessToken, id, move);
    return htmlResponse(redirectPage(`/game/${id}`, 'Move played.'));
  } catch (e) {
    return htmlResponse(errorPage('Move rejected', e.message, `/game/${id}`), 200);
  }
});

app.post('/game/:id/resign', async (c) => {
  const s = session(c);
  if (!s) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id');
  try {
    await lichess.boardResign(s.accessToken, id);
    return htmlResponse(redirectPage('/', 'You resigned.'));
  } catch (e) {
    return htmlResponse(errorPage('Could not resign', e.message, `/game/${id}`), 200);
  }
});

// ---------------------------------------------------------------- Puzzles
app.get('/puzzle', async (c) => {
  const s = session(c);
  try {
    let data;
    let extraHeaders = {};
    if (s) {
      // Logged in: Lichess serves a fresh puzzle every call.
      data = await lichess.puzzleNext(s.accessToken);
    } else {
      // Anonymous: Lichess only exposes daily puzzles. Rotate the last few
      // days' daily puzzles so "New puzzle" varies. (If the day-offset
      // endpoint is unavailable, fall back to today's daily.)
      const cookies = parseCookies(c);
      const offset = Math.abs(parseInt(cookies['pzday'], 10) || 0) % 6;
      extraHeaders = { 'Set-Cookie': `pzday=${(offset + 1) % 6}; Path=/; Max-Age=31536000` };
      try {
        data = await lichess.puzzleDailyDay(offset);
      } catch {
        data = await lichess.puzzleDaily();
      }
    }
    const id = data.puzzle.id;
    return htmlResponse(redirectPage(`/puzzle/${id}?step=0`, 'Loading puzzle...'), 200, extraHeaders);
  } catch (e) {
    return htmlResponse(errorPage('Could not load puzzle', e.message, '/'), 500);
  }
});

app.get('/puzzle/:id', async (c) => {
  const s = session(c);
  const id = c.req.param('id');
  const size = boardSize(c);
  const step = parseStep(c.req.query('step'));
  const msg = c.req.query('msg');

  let puzzle;
  try {
    puzzle = await lichess.puzzleById(s ? s.accessToken : null, id);
  } catch (e) {
    return htmlResponse(errorPage('Could not load puzzle', e.message, '/puzzle'));
  }

  let base;
  let solution;
  try {
    base = puzzleBasePosition(puzzle);
    solution = ((puzzle.puzzle && puzzle.puzzle.solution) || []).map(normalizeUci);
  } catch (e) {
    return htmlResponse(errorPage('Puzzle setup error', e.message, '/puzzle'), 500);
  }
  const solverColor = sideToMove(base.fen);
  let state;
  try {
    state = puzzleStateFrom(base.fen, solution, step);
  } catch (e) {
    return htmlResponse(errorPage('Puzzle setup error', e.message, '/puzzle'), 500);
  }

  const moveRaw = c.req.query('move');
  if (moveRaw) {
    const guess = normalizeUci(moveRaw);
    if (!UCI_MOVE_RE.test(guess)) {
      return htmlResponse(errorPage('Invalid move', 'That move was not understood.', `/puzzle/${id}?step=${step}`), 400);
    }
    const result = checkPuzzleGuess(solution, state.step, guess);
    if (result.correct) return htmlResponse(redirectPage(`/puzzle/${id}?step=${result.newStep}&msg=correct`, 'Correct!'));
    const kind = result.wrongPromotion ? 'promo' : 'wrong';
    return htmlResponse(redirectPage(`/puzzle/${id}?step=${step}&msg=${kind}`, 'Not quite...'));
  }

  const selectedParam = (c.req.query('selected') || '').toLowerCase();
  const selected = SQUARE_RE.test(selectedParam) ? selectedParam : null;
  const pid = encodeURIComponent(id);

  let body = '';
  if (msg === 'wrong') body += '<p><b style="color:#cc0000;">Not quite - try again.</b></p>';
  if (msg === 'promo') body += '<p><b style="color:#cc0000;">Right square, but not that promotion piece. Type the move below (e.g. e7e8n).</b></p>';
  if (msg === 'correct') body += '<p><b style="color:#006600;">Correct!</b></p>';

  if (state.solved) {
    body += renderBoard(state.fen, solverColor, { size });
    body += `<p>Puzzle rating: ${escapeHtml(puzzle.puzzle.rating)}</p>`;
    body += '<p><b>Puzzle solved!</b></p>';
    body += '<p><a href="/puzzle">&gt;&gt; Next puzzle</a></p>';
  } else {
    body += renderBoard(state.fen, solverColor, {
      size,
      interactive: true,
      selected,
      isOwnPiece: (sq, piece) => (solverColor === 'white' ? piece === piece.toUpperCase() : piece === piece.toLowerCase()),
      selectHref: (sq) => `/puzzle/${pid}?step=${state.step}&selected=${sq}`,
      moveHref: (uci) => `/puzzle/${pid}?step=${state.step}&move=${uci}`,
    });
    body += `<p>Puzzle rating: ${escapeHtml(puzzle.puzzle.rating)}</p>`;
    body += `<p>Find the best move for <b>${escapeHtml(solverColor)}</b> - tap a piece, then tap a highlighted square.</p>`;
    if (selected) body += `<p><a href="/puzzle/${pid}?step=${state.step}">[Cancel selection]</a></p>`;
    body += `
<form method="post" action="/puzzle/${pid}">
<input type="hidden" name="step" value="${state.step}">
<p style="font-size:12px;">Or type a move: <input type="text" name="move" size="8" maxlength="6"> <input type="submit" value="Submit"></p>
</form>`;
  }
  body += `<p><a href="/puzzle/${pid}?step=${state.step}">Refresh</a> | <a href="/puzzle">New puzzle</a></p>`;
  return htmlResponse(page('Puzzle', body, s));
});

app.post('/puzzle/:id', async (c) => {
  const s = session(c);
  const id = c.req.param('id');
  const form = await c.req.parseBody();
  const step = parseStep(form.step);
  const guess = normalizeUci(form.move);
  let puzzle;
  try {
    puzzle = await lichess.puzzleById(s ? s.accessToken : null, id);
  } catch (e) {
    return htmlResponse(errorPage('Could not load puzzle', e.message, '/puzzle'));
  }
  let solution;
  try {
    puzzleBasePosition(puzzle);
    solution = ((puzzle.puzzle && puzzle.puzzle.solution) || []).map(normalizeUci);
  } catch (e) {
    return htmlResponse(errorPage('Puzzle setup error', e.message, '/puzzle'), 500);
  }
  if (!guess) return htmlResponse(redirectPage(`/puzzle/${id}?step=${step}`, 'No move entered.'));
  const result = checkPuzzleGuess(solution, step, guess);
  if (result.correct) return htmlResponse(redirectPage(`/puzzle/${id}?step=${result.newStep}&msg=correct`, 'Correct!'));
  const kind = result.wrongPromotion ? 'promo' : 'wrong';
  return htmlResponse(redirectPage(`/puzzle/${id}?step=${step}&msg=${kind}`, 'Not quite...'));
});

// ---------------------------------------------------------------- Fallbacks
app.notFound((c) => htmlResponse(errorPage('Not found', 'That page does not exist.'), 404));
app.onError((err, c) => {
  console.error(err);
  return htmlResponse(errorPage('Something went wrong', err.message), 500);
});

export default app;

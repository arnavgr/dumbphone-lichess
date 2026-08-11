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
} from './lichess.js';
import * as lichess from './lichess.js';
import { renderBoard, sideToMove, puzzleState, normalizeUci, pickAiMove, applyAiMove } from './chess.js';
import {
  page,
  redirectPage,
  errorPage,
  htmlResponse,
  escapeHtml,
  selectField,
  renderGamesList,
} from './ui.js';
import { VARIANTS, TIME_CONTROLS, findTimeControl, AI_LEVELS, LOCAL_AI_LEVELS } from './constants.js';

const app = new Hono();

// Tap-to-move works by carrying the move in a GET link's querystring, which
// is a real side effect (submits a move) even though it's a GET - the only
// way to get a clickable, no-typing move on a browser with no JS. Opera
// Mini's proxy (and some CDNs) can be aggressive about caching GET
// responses, so anything that just executed a move is marked no-store to
// avoid a stale/replayed page on back-navigation or refresh.
const NO_STORE = { 'Cache-Control': 'no-store' };

const UCI_MOVE_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const SQUARE_RE = /^[a-h][1-8]$/;

// Scopes this app ever needs from a Lichess account, used both for the
// OAuth authorize request and to pre-check the right boxes on Lichess's own
// "create a personal token" page (see /login).
const LICHESS_SCOPES = ['board:play', 'challenge:read', 'challenge:write', 'puzzle:read'];

app.use('*', async (c, next) => {
  c.set('session', await getSession(c));
  await next();
});

function requireSession(c) {
  return c.get('session') || null;
}

function timeControlParams(tc) {
  const params = {};
  if (tc.clock) {
    params['clock.limit'] = tc.clock.limit;
    params['clock.increment'] = tc.clock.increment;
  } else if (tc.days) {
    params.days = tc.days;
  }
  return params;
}

// Puzzle "step" = number of solution moves already applied, starting at 0.
function parseStep(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Shared by the tap-to-move GET handler and the typed-move POST fallback.
function checkPuzzleGuess(puzzle, step, guess) {
  const solution = puzzle.puzzle.solution || [];
  const expected = String(solution[step] || '').toLowerCase();
  if (guess && guess === expected) {
    let newStep = step + 1;
    if (solution[newStep]) newStep += 1; // auto-play the opponent's forced reply
    return { correct: true, newStep };
  }
  return { correct: false };
}

// ---------------------------------------------------------------- Home

app.get('/', async (c) => {
  const session = requireSession(c);
  if (!session) {
    const body = `
<p>Play real Lichess games on a dumbphone browser.</p>
<p>You can solve puzzles or play vs a computer opponent right away - no
login needed for either. Logging in with your Lichess account is only
needed for real multiplayer games against other people.</p>
<p><a href="/puzzle">&gt;&gt; Solve a puzzle (no login needed)</a></p>
<p><a href="/ai">&gt;&gt; Play vs a computer (no login needed)</a></p>
<p><a href="/login">&gt;&gt; Login with Lichess to play real multiplayer games</a></p>`;
    return htmlResponse(page('Lichess Dumbphone', body, session));
  }

  let nowPlaying = [];
  let loadError = null;
  try {
    const data = await lichess.getPlaying(session.accessToken);
    nowPlaying = data.nowPlaying || [];
  } catch (e) {
    loadError = e.message;
  }

  let body = '';
  if (loadError) body += `<p>Could not load your games: ${escapeHtml(loadError)}</p>`;

  if (nowPlaying.length > 0) {
    const first = nowPlaying[0];
    const oppName = (first.opponent && first.opponent.username) || 'opponent';
    body += `<p><b>You have a game in progress.</b></p>`;
    body += `<p><a href="/game/${escapeHtml(first.gameId)}">&gt;&gt; Continue match vs ${escapeHtml(oppName)}</a></p>`;
    body += renderGamesList(nowPlaying);
  } else {
    body += '<p>No games in progress.</p>';
  }

  body += '<p><a href="/">Refresh</a></p><hr>';
  body +=
    '<p><a href="/game/new/ai">Play vs AI (Lichess)</a> | ' +
    '<a href="/ai">Play vs AI (local)</a> | ' +
    '<a href="/game/new/multiplayer">Play multiplayer</a> | ' +
    '<a href="/puzzle">Solve a puzzle</a></p>';

  return htmlResponse(page('Lichess Dumbphone', body, session));
});

// ---------------------------------------------------------------- Auth
//
// Two ways to log in:
//   A) /login/oauth - the normal OAuth2+PKCE redirect to lichess.org
//   B) /login/token - paste a personal API token created on any browser,
//      no redirect through lichess.org's own pages at all. Useful if
//      lichess.org's website doesn't render well on this particular phone.

function tokenCreateUrl() {
  const url = new URL('https://lichess.org/account/oauth/token/create');
  for (const scope of LICHESS_SCOPES) url.searchParams.append('scopes[]', scope);
  url.searchParams.set('description', 'dumbphone-lichess');
  return url.toString();
}

app.get('/login', async (c) => {
  const session = requireSession(c);
  const configured = c.env.LICHESS_CLIENT_ID && c.env.REDIRECT_URI;

  let body = '<h4>Option A - Login via Lichess</h4>';
  body +=
    "<p>Redirects to lichess.org to sign in there. If lichess.org's own pages " +
    'don\'t render well on your phone, use Option B below instead.</p>';
  body += configured
    ? '<p><a href="/login/oauth">&gt;&gt; Continue to Lichess</a></p>'
    : "<p>Not available right now: LICHESS_CLIENT_ID / REDIRECT_URI aren't set in wrangler.toml.</p>";

  body += '<hr>';
  body += '<h4>Option B - Paste a personal API token</h4>';
  body +=
    '<p>Works entirely on this page, no redirect. Create a token once on ' +
    'any browser - even one that is not this phone - then paste it below.</p>';
  body += `<p><a href="${escapeHtml(tokenCreateUrl())}">&gt;&gt; Create a token on lichess.org</a> ` +
    '(opens with the right permissions already checked)</p>';
  body += `
<form method="post" action="/login/token">
<p>Paste your token: <input type="text" name="token" size="30"></p>
<p><input type="submit" value="Log in with token"></p>
</form>`;

  return htmlResponse(page('Login', body, session));
});

app.get('/login/oauth', async (c) => {
  const clientId = c.env.LICHESS_CLIENT_ID;
  const redirectUri = c.env.REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return htmlResponse(
      errorPage(
        'Not configured',
        'LICHESS_CLIENT_ID and REDIRECT_URI must be set as vars in wrangler.toml. See the README.'
      ),
      500
    );
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

  if (errorParam) {
    return htmlResponse(errorPage('Login cancelled', `Lichess said: ${errorParam}`));
  }
  if (!code || !state) {
    return htmlResponse(errorPage('Login failed', 'Missing code or state from Lichess.'));
  }
  const verifier = await consumeOAuthState(c, state);
  if (!verifier) {
    return htmlResponse(
      errorPage(
        'Login failed',
        'Your login session expired or was already used. Please try logging in again.',
        '/login'
      ),
      400
    );
  }

  try {
    const tokenData = await lichess.exchangeCodeForToken({
      code,
      verifier,
      redirectUri: c.env.REDIRECT_URI,
      clientId: c.env.LICHESS_CLIENT_ID,
    });
    const account = await lichess.getAccount(tokenData.access_token);
    const sid = await createSession(c, {
      accessToken: tokenData.access_token,
      username: account.username,
    });
    c.header('Set-Cookie', sessionCookie(sid));
    return htmlResponse(redirectPage('/', `Logged in as ${account.username}.`));
  } catch (e) {
    return htmlResponse(errorPage('Login failed', e.message, '/login'));
  }
});

app.post('/login/token', async (c) => {
  const form = await c.req.parseBody();
  const token = String(form.token || '').trim();
  if (!token) {
    return htmlResponse(errorPage('Missing token', 'Please paste a Lichess API token.', '/login'), 400);
  }
  try {
    const account = await lichess.getAccount(token);
    const sid = await createSession(c, { accessToken: token, username: account.username });
    c.header('Set-Cookie', sessionCookie(sid));
    return htmlResponse(redirectPage('/', `Logged in as ${account.username}.`));
  } catch (e) {
    return htmlResponse(
      errorPage(
        'Login failed',
        `That token didn't work (${e.message}). Double-check you created it using the link above and pasted it in full.`,
        '/login'
      ),
      400
    );
  }
});

app.get('/logout', async (c) => {
  const session = requireSession(c);
  if (session) await destroySession(c, session.id);
  c.header('Set-Cookie', clearedSessionCookie());
  return htmlResponse(redirectPage('/', 'Logged out.'));
});

// ---------------------------------------------------------------- New game vs AI (Lichess-hosted)

app.get('/game/new/ai', async (c) => {
  const session = requireSession(c);
  if (!session) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const body = `
<form method="post" action="/game/new/ai">
<p>Level: ${selectField('level', AI_LEVELS.map((l) => ({ value: l, label: `Level ${l}` })), 3)}</p>
<p>Your color: ${selectField(
    'color',
    [
      { value: 'random', label: 'Random' },
      { value: 'white', label: 'White' },
      { value: 'black', label: 'Black' },
    ],
    'random'
  )}</p>
<p>Variant: ${selectField('variant', VARIANTS, 'standard')}</p>
<p>Time control: ${selectField('timeControl', TIME_CONTROLS, 'rapid-600-0')}</p>
<p><input type="submit" value="Start game"></p>
</form>`;
  return htmlResponse(page('Play vs AI (Lichess)', body, session));
});

app.post('/game/new/ai', async (c) => {
  const session = requireSession(c);
  if (!session) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const form = await c.req.parseBody();
  const tc = findTimeControl(form.timeControl);
  const params = {
    level: form.level,
    color: form.color,
    variant: form.variant,
    ...timeControlParams(tc),
  };
  try {
    const game = await lichess.challengeAI(session.accessToken, params);
    const gameId = game.id || (game.game && game.game.id);
    return htmlResponse(redirectPage(`/game/${gameId}`, 'Game created!'));
  } catch (e) {
    return htmlResponse(errorPage('Could not start game', e.message, '/game/new/ai'));
  }
});

// ---------------------------------------------------------------- New multiplayer game

app.get('/game/new/multiplayer', async (c) => {
  const session = requireSession(c);
  if (!session) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const colorField = selectField(
    'color',
    [
      { value: 'random', label: 'Random' },
      { value: 'white', label: 'White' },
      { value: 'black', label: 'Black' },
    ],
    'random'
  );
  const ratedField = selectField(
    'rated',
    [
      { value: 'false', label: 'Casual' },
      { value: 'true', label: 'Rated' },
    ],
    'false'
  );

  const body = `
<h4>1) Challenge a Lichess username</h4>
<form method="post" action="/game/new/multiplayer/user">
<p>Username: <input type="text" name="username" size="16"></p>
<p>Your color: ${colorField}</p>
<p>Variant: ${selectField('variant', VARIANTS, 'standard')}</p>
<p>Time control: ${selectField('timeControl', TIME_CONTROLS, 'rapid-600-0')}</p>
<p>${ratedField}</p>
<p><input type="submit" value="Send challenge"></p>
</form>
<hr>
<h4>2) Create a shareable link (open challenge)</h4>
<p>Makes a link you can send to a friend outside Lichess (SMS, chat, etc).
Whoever opens it can join and the game starts.</p>
<form method="post" action="/game/new/multiplayer/open">
<p>Variant: ${selectField('variant', VARIANTS, 'standard')}</p>
<p>Time control: ${selectField('timeControl', TIME_CONTROLS, 'rapid-600-0')}</p>
<p>${ratedField}</p>
<p><input type="submit" value="Create link"></p>
</form>
<hr>
<h4>3) Quick pair (random opponent)</h4>
<p>Joins the real Lichess matchmaking pool for up to 20 seconds.</p>
<form method="post" action="/game/new/multiplayer/quick">
<p>Variant: ${selectField('variant', VARIANTS, 'standard')}</p>
<p>Time control: ${selectField('timeControl', TIME_CONTROLS, 'rapid-600-0')}</p>
<p>${ratedField}</p>
<p><input type="submit" value="Find opponent"></p>
</form>`;
  return htmlResponse(page('Play Multiplayer', body, session));
});

app.post('/game/new/multiplayer/user', async (c) => {
  const session = requireSession(c);
  if (!session) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const form = await c.req.parseBody();
  const username = String(form.username || '').trim();
  if (!username) {
    return htmlResponse(
      errorPage('Missing username', 'Please enter a Lichess username.', '/game/new/multiplayer')
    );
  }
  const tc = findTimeControl(form.timeControl);
  const params = { rated: form.rated, color: form.color, variant: form.variant, ...timeControlParams(tc) };
  try {
    const res = await lichess.challengeUser(session.accessToken, username, params);
    const challengeId = (res.challenge && res.challenge.id) || res.id;
    return htmlResponse(redirectPage(`/challenge/${challengeId}`, `Challenge sent to ${username}.`));
  } catch (e) {
    return htmlResponse(errorPage('Could not send challenge', e.message, '/game/new/multiplayer'));
  }
});

app.post('/game/new/multiplayer/open', async (c) => {
  const session = requireSession(c);
  if (!session) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const form = await c.req.parseBody();
  const tc = findTimeControl(form.timeControl);
  const params = { rated: form.rated, variant: form.variant, ...timeControlParams(tc) };
  try {
    const res = await lichess.challengeOpen(session.accessToken, params);
    const id = (res.challenge && res.challenge.id) || res.id;
    const url = (res.challenge && res.challenge.url) || res.url;
    const body = `
<p>Share this link with someone to play:</p>
<p><b>${escapeHtml(url || '(no url returned)')}</b></p>
<p><a href="/challenge/${escapeHtml(id)}">Check status / continue</a></p>`;
    return htmlResponse(page('Open challenge created', body, session));
  } catch (e) {
    return htmlResponse(errorPage('Could not create challenge', e.message, '/game/new/multiplayer'));
  }
});

app.post('/game/new/multiplayer/quick', async (c) => {
  const session = requireSession(c);
  if (!session) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const form = await c.req.parseBody();
  const tc = findTimeControl(form.timeControl);
  const params = { rated: form.rated, variant: form.variant };
  if (tc.clock) {
    params.time = tc.clock.limit / 60;
    params.increment = tc.clock.increment;
  } else if (tc.days) {
    params.days = tc.days;
  }
  try {
    const result = await lichess.quickPairSeek(session.accessToken, params, 20000);
    const playing = await lichess.getPlaying(session.accessToken);
    const game = (playing.nowPlaying || [])[0];
    if (game) {
      return htmlResponse(redirectPage(`/game/${game.gameId}`, 'Opponent found!'));
    }
    const msg = result.timedOut
      ? 'No opponent found within 20 seconds - nobody else was seeking that time control just now. Try again, or send a challenge link instead.'
      : 'The search ended but no game was found. Please try again.';
    const body = `<p>${escapeHtml(msg)}</p><p><a href="/game/new/multiplayer">Back</a></p>`;
    return htmlResponse(page('Quick pair', body, session));
  } catch (e) {
    return htmlResponse(errorPage('Quick pair failed', e.message, '/game/new/multiplayer'));
  }
});

app.get('/challenge/:id', async (c) => {
  const session = requireSession(c);
  if (!session) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id');
  let info = null;
  let error = null;
  try {
    info = await lichess.challengeShow(session.accessToken, id);
  } catch (e) {
    error = e.message;
  }
  const status = info && (info.status || (info.challenge && info.challenge.status));

  if (status === 'accepted') {
    return htmlResponse(redirectPage(`/game/${id}`, 'Challenge accepted! Loading game...'));
  }

  let body = '';
  if (error) {
    body += `<p>${escapeHtml(error)}</p>`;
  } else {
    body += `<p>Status: <b>${escapeHtml(status || 'unknown')}</b></p>`;
    const url = info && (info.url || (info.challenge && info.challenge.url));
    if (url) body += `<p>Share link: <br>${escapeHtml(url)}</p>`;
  }
  body += `<p><a href="/challenge/${escapeHtml(id)}">Refresh</a></p>`;
  body += `<p><a href="/game/${escapeHtml(id)}">Try opening the game directly</a></p>`;
  return htmlResponse(page('Challenge status', body, session));
});

// ---------------------------------------------------------------- vs AI, no login (local engine)
//
// Fully independent of Lichess - no account, no token, no OAuth. Move
// legality and game-over detection run through chess.js; the AI's replies
// come from src/chess.js. All state lives in the URL (the current FEN),
// so there's nothing to store server-side and nothing to expire.

app.get('/ai', async (c) => {
  const session = requireSession(c);
  const body = `
<p>Play vs a computer opponent - no Lichess account needed. Moves are
validated locally; the AI's replies come from a free remote engine (or
random legal moves at difficulty 0, if you'd rather just have fun).</p>
<form method="get" action="/ai/play">
<p>Difficulty: ${selectField('diff', LOCAL_AI_LEVELS, 1)}</p>
<p>Your color: ${selectField(
    'color',
    [
      { value: 'w', label: 'White' },
      { value: 'b', label: 'Black' },
    ],
    'w'
  )}</p>
<p><input type="submit" value="Start game"></p>
</form>`;
  return htmlResponse(page('Play vs AI (no login)', body, session));
});

app.get('/ai/play', async (c) => {
  const session = requireSession(c);
  const q = c.req.query();

  let diff = parseInt(q.diff, 10);
  if (!Number.isFinite(diff) || diff < 0) diff = 1;
  if (diff > 4) diff = 4;
  const color = q.color === 'b' ? 'b' : 'w';
  const fenParam = q.fen || null;

  const moveParam = (q.move || '').toLowerCase();
  const selectedParam = (q.selected || '').toLowerCase();
  const selected = SQUARE_RE.test(selectedParam) ? selectedParam : null;

  // Builds a /ai/play?... link carrying the current diff/color plus
  // whatever's overridden in `extra` (fen, selected, move, a new diff...).
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

  // Fresh game where the human plays Black - let the AI (White) open.
  if (!fenParam && color === 'b' && !resetMessage) {
    const aiMove = await pickAiMove(chess, diff);
    applyAiMove(chess, aiMove);
  }

  // A highlighted destination square was tapped - play it, then (if the
  // game isn't over) let the AI reply immediately, before rendering.
  if (moveParam) {
    if (!UCI_MOVE_RE.test(moveParam)) {
      return htmlResponse(
        errorPage('Invalid move', 'That move was not understood.', linkBase({ fen: chess.fen() })),
        400,
        NO_STORE
      );
    }
    const from = moveParam.slice(0, 2);
    const to = moveParam.slice(2, 4);
    const promotion = moveParam.slice(4, 5) || undefined;
    try {
      chess.move({ from, to, promotion });
    } catch {
      return htmlResponse(
        errorPage('Illegal move', `${from}-${to} is not legal there.`, linkBase({ fen: chess.fen() })),
        200,
        NO_STORE
      );
    }
    if (!chess.isGameOver()) {
      const aiMove = await pickAiMove(chess, diff);
      applyAiMove(chess, aiMove);
    }
    return htmlResponse(redirectPage(linkBase({ fen: chess.fen() }), 'Move played.'), 200, NO_STORE);
  }

  const orientation = color === 'b' ? 'black' : 'white';
  const isOver = chess.isGameOver();
  const humanTurn = !isOver && chess.turn() === color;

  let message;
  let msgColor;
  if (resetMessage) {
    message = resetMessage;
    msgColor = '#cc0000';
  } else if (chess.isCheckmate()) {
    message = 'Checkmate! Game over.';
    msgColor = '#000099';
  } else if (chess.isDraw()) {
    message = 'Draw. Game over.';
    msgColor = '#000099';
  } else if (chess.isCheck()) {
    message = 'Check! Your move.';
    msgColor = '#cc0000';
  } else if (humanTurn) {
    message = 'Your move - tap a piece, then tap a highlighted square.';
    msgColor = '#006600';
  } else {
    message = 'Waiting on the AI...';
    msgColor = '#666666';
  }

  let body = `<p><b style="color:${msgColor};">${escapeHtml(message)}</b></p>`;

  body += renderBoard(chess.fen(), orientation, {
    interactive: humanTurn,
    selected: humanTurn ? selected : null,
    isOwnPiece: (square, piece) =>
      color === 'w' ? piece === piece.toUpperCase() : piece === piece.toLowerCase(),
    selectHref: (square) => linkBase({ fen: chess.fen(), selected: square }),
    moveHref: (uci) => linkBase({ fen: chess.fen(), move: uci }),
  });

  if (humanTurn && selected) {
    body += `<p><a href="${linkBase({ fen: chess.fen() })}">[Cancel selection]</a></p>`;
  }
  body += `<p><a href="${linkBase({ fen: chess.fen() })}">Refresh</a></p>`;

  body += '<div style="margin-top:10px;font-size:12px;"><b>Difficulty:</b> ';
  body += LOCAL_AI_LEVELS.map((l) =>
    String(l.value) === String(diff)
      ? `<b>[${l.value}]</b>`
      : `<a href="${linkBase({ fen: chess.fen(), diff: String(l.value) })}">${l.value}</a>`
  ).join(' ');
  body += '</div>';

  body += `
<div style="margin-top:10px;font-size:12px;">
<b>New game:</b>
<a href="/ai/play?diff=${diff}&color=w">White</a> |
<a href="/ai/play?diff=${diff}&color=b">Black</a>
</div>`;

  return htmlResponse(page('Play vs AI (no login)', body, session));
});

// ---------------------------------------------------------------- Game board (Lichess-hosted)

app.get('/game/:id', async (c) => {
  const session = requireSession(c);
  if (!session) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id');

  // A highlighted destination square was tapped - actually submit the move
  // to Lichess. This is a real side effect via GET; see the NO_STORE note
  // above for why the response is marked non-cacheable.
  const moveParam = (c.req.query('move') || '').toLowerCase();
  if (moveParam) {
    if (!UCI_MOVE_RE.test(moveParam)) {
      return htmlResponse(
        errorPage('Invalid move', 'That move was not understood.', `/game/${id}`),
        400,
        NO_STORE
      );
    }
    try {
      await lichess.boardMove(session.accessToken, id, moveParam);
      return htmlResponse(redirectPage(`/game/${id}`, 'Move played.'), 200, NO_STORE);
    } catch (e) {
      return htmlResponse(errorPage('Move rejected', e.message, `/game/${id}`), 200, NO_STORE);
    }
  }

  const selectedParam = (c.req.query('selected') || '').toLowerCase();
  const selected = SQUARE_RE.test(selectedParam) ? selectedParam : null;

  let game = null;
  let error = null;
  try {
    const playing = await lichess.getPlaying(session.accessToken);
    game = (playing.nowPlaying || []).find((g) => g.gameId === id);
  } catch (e) {
    error = e.message;
  }

  let body = '';
  if (error) body += `<p>${escapeHtml(error)}</p>`;

  if (game) {
    const orientation = game.color === 'black' ? 'black' : 'white';
    const canMove = !!game.isMyTurn;

    body += renderBoard(game.fen, orientation, {
      interactive: canMove,
      selected: canMove ? selected : null,
      isOwnPiece: (square, piece) =>
        game.color === 'white' ? piece === piece.toUpperCase() : piece === piece.toLowerCase(),
      selectHref: (square) => `/game/${escapeHtml(id)}?selected=${square}`,
      moveHref: (uci) => `/game/${escapeHtml(id)}?move=${uci}`,
    });

    body += `<p>Playing as <b>${escapeHtml(game.color)}</b> vs <b>${escapeHtml(
      (game.opponent && game.opponent.username) || '?'
    )}</b></p>`;
    body += `<p>${
      game.isMyTurn ? '<b>Your move - tap a piece, then tap a highlighted square.</b>' : 'Waiting for opponent...'
    }</p>`;
    if (typeof game.secondsLeft === 'number') {
      const m = Math.floor(game.secondsLeft / 60);
      const s = game.secondsLeft % 60;
      body += `<p>Time left: ${m}m ${s}s</p>`;
    }
    body += `<p><a href="/game/${escapeHtml(id)}">Refresh board</a></p>`;

    if (canMove) {
      if (selected) {
        body += `<p><a href="/game/${escapeHtml(id)}">[Cancel selection]</a></p>`;
      }
      body += `
<form method="post" action="/game/${escapeHtml(id)}/move">
<p style="font-size:12px;">Need underpromotion (e.g. e7e8n)? Type the move instead:
<input type="text" name="move" size="8" maxlength="6"> <input type="submit" value="Play"></p>
</form>`;
    }
    body += `
<form method="post" action="/game/${escapeHtml(id)}/resign">
<p><input type="submit" value="Resign"></p>
</form>`;
  } else {
    // Not one of our active games - it may be finished, not yet accepted, or invalid.
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
          body += renderBoard(chess.fen(), 'white');
        } catch {
          // best effort only
        }
      }
    } else {
      body += '<p>Game not found, not yet started, or you are not a player in it.</p>';
    }
    body += `<p><a href="/game/${escapeHtml(id)}">Refresh</a> | <a href="/">Home</a></p>`;
  }

  return htmlResponse(page('Game', body, session));
});

app.post('/game/:id/move', async (c) => {
  const session = requireSession(c);
  if (!session) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id');
  const form = await c.req.parseBody();
  const move = normalizeUci(form.move);
  if (!move) {
    return htmlResponse(
      errorPage('Invalid move', 'Please enter a move like e2e4.', `/game/${id}`),
      400,
      NO_STORE
    );
  }
  try {
    await lichess.boardMove(session.accessToken, id, move);
    return htmlResponse(redirectPage(`/game/${id}`, 'Move played.'), 200, NO_STORE);
  } catch (e) {
    return htmlResponse(errorPage('Move rejected', e.message, `/game/${id}`), 200, NO_STORE);
  }
});

app.post('/game/:id/resign', async (c) => {
  const session = requireSession(c);
  if (!session) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id');
  try {
    await lichess.boardResign(session.accessToken, id);
    return htmlResponse(redirectPage('/', 'You resigned.'), 200, NO_STORE);
  } catch (e) {
    return htmlResponse(errorPage('Could not resign', e.message, `/game/${id}`), 200, NO_STORE);
  }
});

// ---------------------------------------------------------------- Puzzles

app.get('/puzzle', async (c) => {
  const session = requireSession(c);
  try {
    const data = session ? await lichess.puzzleNext(session.accessToken) : await lichess.puzzleDaily();
    const id = data.puzzle.id;
    return htmlResponse(redirectPage(`/puzzle/${id}?step=0`, 'Loading puzzle...'));
  } catch (e) {
    return htmlResponse(errorPage('Could not load puzzle', e.message, '/'));
  }
});

app.get('/puzzle/:id', async (c) => {
  const session = requireSession(c);
  const id = c.req.param('id');
  const step = parseStep(c.req.query('step'));
  const msg = c.req.query('msg');

  let puzzle;
  try {
    puzzle = await lichess.puzzleById(session ? session.accessToken : null, id);
  } catch (e) {
    return htmlResponse(errorPage('Could not load puzzle', e.message, '/'));
  }

  // A highlighted destination square was tapped - check it against the
  // puzzle solution. Same real-side-effect-via-GET pattern as game moves.
  const moveParam = (c.req.query('move') || '').toLowerCase();
  if (moveParam) {
    if (!UCI_MOVE_RE.test(moveParam)) {
      return htmlResponse(
        errorPage('Invalid move', 'That move was not understood.', `/puzzle/${id}?step=${step}`),
        400,
        NO_STORE
      );
    }
    const result = checkPuzzleGuess(puzzle, step, moveParam);
    if (result.correct) {
      return htmlResponse(
        redirectPage(`/puzzle/${id}?step=${result.newStep}&msg=correct`, 'Correct!'),
        200,
        NO_STORE
      );
    }
    return htmlResponse(
      redirectPage(`/puzzle/${id}?step=${step}&msg=wrong`, 'Not quite, try again.'),
      200,
      NO_STORE
    );
  }

  const selectedParam = (c.req.query('selected') || '').toLowerCase();
  const selected = SQUARE_RE.test(selectedParam) ? selectedParam : null;

  const solverColor = sideToMove(puzzleState(puzzle, 0).fen);
  const state = puzzleState(puzzle, step);

  let body = '';
  if (msg === 'wrong') body += '<p><b>Not quite - try again.</b></p>';
  if (msg === 'correct') body += '<p><b>Correct!</b></p>';

  if (state.solved) {
    body += renderBoard(state.fen, solverColor);
  } else {
    body += renderBoard(state.fen, solverColor, {
      interactive: true,
      selected,
      isOwnPiece: (square, piece) =>
        solverColor === 'white' ? piece === piece.toUpperCase() : piece === piece.toLowerCase(),
      selectHref: (square) => `/puzzle/${escapeHtml(id)}?step=${state.step}&selected=${square}`,
      moveHref: (uci) => `/puzzle/${escapeHtml(id)}?step=${state.step}&move=${uci}`,
    });
  }
  body += `<p>Puzzle rating: ${escapeHtml(puzzle.puzzle.rating)}</p>`;

  if (state.solved) {
    body += '<p><b>Puzzle solved!</b></p>';
    body += '<p><a href="/puzzle">Next puzzle</a></p>';
  } else {
    body += `<p>Find the best move for <b>${escapeHtml(
      sideToMove(state.fen)
    )}</b> - tap a piece, then tap a highlighted square.</p>`;
    if (selected) {
      body += `<p><a href="/puzzle/${escapeHtml(id)}?step=${state.step}">[Cancel selection]</a></p>`;
    }
    body += `
<form method="post" action="/puzzle/${escapeHtml(id)}">
<input type="hidden" name="step" value="${state.step}">
<p style="font-size:12px;">Or type a move: <input type="text" name="move" size="8" maxlength="6"> <input type="submit" value="Submit"></p>
</form>`;
  }
  body += `<p><a href="/puzzle/${escapeHtml(id)}?step=${state.step}">Refresh</a> | <a href="/puzzle">New puzzle</a></p>`;

  return htmlResponse(page('Puzzle', body, session));
});

app.post('/puzzle/:id', async (c) => {
  const session = requireSession(c);
  const id = c.req.param('id');
  const form = await c.req.parseBody();
  const step = parseStep(form.step);
  const guess = normalizeUci(form.move);

  let puzzle;
  try {
    puzzle = await lichess.puzzleById(session ? session.accessToken : null, id);
  } catch (e) {
    return htmlResponse(errorPage('Could not load puzzle', e.message, '/'));
  }

  const result = checkPuzzleGuess(puzzle, step, guess);
  if (result.correct) {
    return htmlResponse(
      redirectPage(`/puzzle/${id}?step=${result.newStep}&msg=correct`, 'Correct!'),
      200,
      NO_STORE
    );
  }
  return htmlResponse(
    redirectPage(`/puzzle/${id}?step=${step}&msg=wrong`, 'Not quite, try again.'),
    200,
    NO_STORE
  );
});

// ---------------------------------------------------------------- Fallbacks

app.notFound((c) => htmlResponse(errorPage('Not found', 'That page does not exist.'), 404));
app.onError((err, c) => {
  console.error(err);
  return htmlResponse(errorPage('Something went wrong', err.message), 500);
});

export default app;

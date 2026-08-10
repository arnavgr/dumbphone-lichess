import { Hono } from 'hono';
import { Chess } from 'chess.js';
import { randomString, codeChallengeS256 } from './pkce.js';
import {
  getSession,
  createSession,
  destroySession,
  saveOAuthState,
  consumeOAuthState,
  sessionCookie,
  clearedSessionCookie,
} from './session.js';
import * as lichess from './lichessApi.js';
import { renderBoard, sideToMove } from './board.js';
import { puzzleState, normalizeUci } from './puzzle.js';
import {
  page,
  redirectPage,
  errorPage,
  htmlResponse,
  escapeHtml,
  selectField,
  renderGamesList,
} from './ui.js';
import { VARIANTS, TIME_CONTROLS, findTimeControl, AI_LEVELS } from './constants.js';

const app = new Hono();

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
// (Number(x || '1') || 1 previously turned a real step=0 into 1, which is
// what caused the double-advance bug - this parses 0 correctly.)
function parseStep(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ---------------------------------------------------------------- Home

app.get('/', async (c) => {
  const session = requireSession(c);
  if (!session) {
    const body = `
<p>Play real Lichess games on a dumbphone browser.</p>
<p>You can solve puzzles right away - no login needed. Logging in with your
Lichess account is optional, and only needed to play vs the AI or against
other people.</p>
<p><a href="/puzzle">&gt;&gt; Solve a puzzle (no login needed)</a></p>
<p><a href="/login">&gt;&gt; Login with Lichess to play games</a></p>`;
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
    '<p><a href="/game/new/ai">Play vs AI</a> | ' +
    '<a href="/game/new/multiplayer">Play multiplayer</a> | ' +
    '<a href="/puzzle">Solve a puzzle</a></p>';

  return htmlResponse(page('Lichess Dumbphone', body, session));
});

// ---------------------------------------------------------------- Auth

app.get('/login', async (c) => {
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

  const scope = ['board:play', 'challenge:read', 'challenge:write', 'puzzle:read'].join(' ');
  const authUrl = new URL('https://lichess.org/oauth');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', scope);
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

app.get('/logout', async (c) => {
  const session = requireSession(c);
  if (session) await destroySession(c, session.id);
  c.header('Set-Cookie', clearedSessionCookie());
  return htmlResponse(redirectPage('/', 'Logged out.'));
});

// ---------------------------------------------------------------- New game vs AI

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
  return htmlResponse(page('Play vs AI', body, session));
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

// ---------------------------------------------------------------- Game board

app.get('/game/:id', async (c) => {
  const session = requireSession(c);
  if (!session) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id');

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
    body += renderBoard(game.fen, orientation);
    body += `<p>Playing as <b>${escapeHtml(game.color)}</b> vs <b>${escapeHtml(
      (game.opponent && game.opponent.username) || '?'
    )}</b></p>`;
    body += `<p>${game.isMyTurn ? '<b>Your move.</b>' : 'Waiting for opponent...'}</p>`;
    if (typeof game.secondsLeft === 'number') {
      const m = Math.floor(game.secondsLeft / 60);
      const s = game.secondsLeft % 60;
      body += `<p>Time left: ${m}m ${s}s</p>`;
    }
    body += `<p><a href="/game/${escapeHtml(id)}">Refresh board</a></p>`;

    if (game.isMyTurn) {
      body += `
<form method="post" action="/game/${escapeHtml(id)}/move">
<p>Move, e.g. e2e4 (from-square then to-square). For promotion add the piece
letter, e.g. e7e8q.</p>
<p><input type="text" name="move" size="8" maxlength="6"> <input type="submit" value="Play move"></p>
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
    return htmlResponse(errorPage('Invalid move', 'Please enter a move like e2e4.', `/game/${id}`));
  }
  try {
    await lichess.boardMove(session.accessToken, id, move);
    return htmlResponse(redirectPage(`/game/${id}`, 'Move played.'));
  } catch (e) {
    return htmlResponse(errorPage('Move rejected', e.message, `/game/${id}`));
  }
});

app.post('/game/:id/resign', async (c) => {
  const session = requireSession(c);
  if (!session) return htmlResponse(redirectPage('/login', 'Please log in first.'));
  const id = c.req.param('id');
  try {
    await lichess.boardResign(session.accessToken, id);
    return htmlResponse(redirectPage('/', 'You resigned.'));
  } catch (e) {
    return htmlResponse(errorPage('Could not resign', e.message, `/game/${id}`));
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

  const solverColor = sideToMove(puzzleState(puzzle, 0).fen);
  const state = puzzleState(puzzle, step);

  let body = '';
  if (msg === 'wrong') body += '<p><b>Not quite - try again.</b></p>';
  if (msg === 'correct') body += '<p><b>Correct!</b></p>';

  body += renderBoard(state.fen, solverColor);
  body += `<p>Puzzle rating: ${escapeHtml(puzzle.puzzle.rating)}</p>`;

  if (state.solved) {
    body += '<p><b>Puzzle solved!</b></p>';
    body += '<p><a href="/puzzle">Next puzzle</a></p>';
  } else {
    body += `<p>Find the best move for <b>${escapeHtml(sideToMove(state.fen))}</b>. Enter it like e2e4.</p>`;
    body += `
<form method="post" action="/puzzle/${escapeHtml(id)}">
<input type="hidden" name="step" value="${state.step}">
<p><input type="text" name="move" size="8" maxlength="6"> <input type="submit" value="Submit move"></p>
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

  const solution = puzzle.puzzle.solution || [];
  const expected = String(solution[step] || '').toLowerCase();

  if (guess && guess === expected) {
    let newStep = step + 1;
    if (solution[newStep]) newStep += 1; // auto-play the opponent's forced reply
    return htmlResponse(redirectPage(`/puzzle/${id}?step=${newStep}&msg=correct`, 'Correct!'));
  }
  return htmlResponse(redirectPage(`/puzzle/${id}?step=${step}&msg=wrong`, 'Not quite, try again.'));
});

// ---------------------------------------------------------------- Fallbacks

app.notFound((c) => htmlResponse(errorPage('Not found', 'That page does not exist.'), 404));
app.onError((err, c) => {
  console.error(err);
  return htmlResponse(errorPage('Something went wrong', err.message), 500);
});

export default app;

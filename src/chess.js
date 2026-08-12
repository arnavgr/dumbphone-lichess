// ---------------------------------------------------------------------------
// All chess.js-dependent logic used by this app, in one file:
//   - Board rendering: renders a FEN position as an HTML tap-to-move <table>
//   - Puzzle logic: replays a Lichess puzzle PGN and applies solution moves
//   - Local AI opponent: anonymous "vs AI" mode, no Lichess account needed
//
// chess.js runs here on the Worker only (server-side) - the phone never runs
// any JS, it just gets a fresh rendered board + form on every request.
// ---------------------------------------------------------------------------
import { Chess } from 'chess.js';

// ============================================================================
// Board rendering
//
// Renders a FEN position as an HTML <table> board using PNG piece icons
// (served as static assets from /images/*.png) plus tap-to-move: tap a piece
// to select it (its legal destination squares light up), then tap a
// destination to play the move - no typing, no JS, just plain <a> links
// carrying the move in the URL.
// ============================================================================

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

const PIECE_FILES = {
  K: 'wK', Q: 'wQ', R: 'wR', B: 'wB', N: 'wN', P: 'wP',
  k: 'bK', q: 'bQ', r: 'bR', b: 'bB', n: 'bN', p: 'bP',
};

const CELL = 24; // px, board square size (kept small: 8*24+coords fits a 240px screen)
const IMG = 20; // px, piece icon size

function pieceImg(code) {
  const f = PIECE_FILES[code];
  if (!f) return '';
  return `<img src="/images/${f}.png" width="${IMG}" height="${IMG}" alt="${code}" style="display:block;margin:auto;border:0;">`;
}

const SPACER = `<div style="width:${CELL}px;height:${CELL}px;"></div>`;

// FEN piece-placement field -> map of square ("e4") -> piece char ("P","n",...)
export function fenToPieceMap(fen) {
  const placement = fen.split(' ')[0];
  const rows = placement.split('/'); // rows[0] = rank 8 ... rows[7] = rank 1
  const map = {};
  for (let i = 0; i < 8; i++) {
    const rank = 8 - i;
    let file = 0;
    for (const ch of rows[i]) {
      if (/[1-8]/.test(ch)) {
        file += Number(ch);
      } else {
        map[`${FILES[file]}${rank}`] = ch;
        file += 1;
      }
    }
  }
  return map;
}

// Legal destination squares for the piece on `square`, given the current FEN,
// as a map of destination square -> full UCI move ("e2e4", "e7e8q").
// Queen promotion is the one-tap default; the typed-move fallback form on
// each page handles underpromotion. Best-effort only: any error just means
// no highlighted squares, never a crash.
function legalMovesFrom(fen, square) {
  const from = square.toLowerCase();
  try {
    const chess = new Chess(fen);
    const moves = chess.moves({ square: from, verbose: true });
    const byDestination = {};
    for (const m of moves) {
      const uci = from + m.to + (m.promotion || '');
      if (!byDestination[m.to] || m.promotion === 'q') byDestination[m.to] = uci;
    }
    return byDestination;
  } catch {
    return {};
  }
}

// orientation: 'white' (default) or 'black' (black at bottom)
// opts:
//   interactive  - if true, own pieces and legal destinations become <a> links
//   selected     - currently-selected square, or null
//   selectHref(square)        -> URL for tapping an own piece to select it
//   moveHref(uci)             -> URL for tapping a highlighted destination
//   isOwnPiece(square, piece) -> whether this piece belongs to the mover
export function renderBoard(fen, orientation = 'white', opts = {}) {
  const { interactive = false, selected = null, selectHref, moveHref, isOwnPiece } = opts;
  const pieceMap = fenToPieceMap(fen);
  const movesFromSelected = interactive && selected ? legalMovesFrom(fen, selected) : {};
  const ranksTopDown = orientation === 'black' ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const filesOrder = orientation === 'black' ? [...FILES].reverse() : FILES;
  const coordStyle = 'background:#ccc;font-size:9px;text-align:center;vertical-align:middle;';

  const fileRow = () => {
    let row = `<tr><td style="${coordStyle}width:${CELL / 2}px;height:${CELL / 2}px;"></td>`;
    for (const file of filesOrder) {
      row += `<td style="${coordStyle}width:${CELL}px;height:${CELL / 2}px;">${file}</td>`;
    }
    row += `<td style="${coordStyle}width:${CELL / 2}px;height:${CELL / 2}px;"></td></tr>`;
    return row;
  };

  let html = '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:4px auto;border:2px solid #333;">';
  html += fileRow();
  for (const rank of ranksTopDown) {
    html += `<tr><td style="${coordStyle}width:${CELL / 2}px;">${rank}</td>`;
    for (const file of filesOrder) {
      const square = `${file}${rank}`;
      const fileIdx = FILES.indexOf(file);
      const isLight = (rank - 1 + fileIdx) % 2 === 1;
      let bg = isLight ? '#f0d9b5' : '#946f51';
      const piece = pieceMap[square];
      const uci = movesFromSelected[square];
      if (selected === square) bg = '#ffed4a';
      else if (uci) bg = '#7bde7b';
      let inner = piece ? pieceImg(piece) : SPACER;
      if (uci && moveHref) {
        // Solid colors only (no rgba/border-radius): must survive ancient browsers.
        const targetContent = piece
          ? pieceImg(piece)
          : `<div style="width:${IMG / 2}px;height:${IMG / 2}px;background:#333;margin:auto;"></div>`;
        inner = `<a href="${moveHref(uci)}" style="display:block;width:${CELL}px;height:${CELL}px;text-decoration:none;">${targetContent}</a>`;
      } else if (interactive && piece && typeof isOwnPiece === 'function' && isOwnPiece(square, piece) && selectHref) {
        inner = `<a href="${selectHref(square)}" style="display:block;width:${CELL}px;height:${CELL}px;text-decoration:none;">${pieceImg(piece)}</a>`;
      }
      html += `<td width="${CELL}" height="${CELL}" style="width:${CELL}px;height:${CELL}px;min-width:${CELL}px;min-height:${CELL}px;padding:0;text-align:center;vertical-align:middle;background-color:${bg};border:1px solid #666;">${inner}</td>`;
    }
    html += `<td style="${coordStyle}width:${CELL / 2}px;">${rank}</td></tr>`;
  }
  html += fileRow();
  html += '</table>';
  return html;
}

export function sideToMove(fen) {
  return fen.split(' ')[1] === 'w' ? 'white' : 'black';
}

// ============================================================================
// Puzzle logic
//
// Lichess puzzle payloads give a full game PGN plus `initialPly` and a
// `solution` array of UCI moves. initialPly already points past the
// opponent's setup/blunder move - the FEN at that ply is the position ready
// for the solver to move:
//   solution[0] is the first move the solver must find
//   solution[1] is the opponent's forced reply (auto-played)
//   solution[2] is the solver's second move to find, and so on.
// ============================================================================

export function fenAtInitialPly(pgn, initialPly) {
  const temp = new Chess();
  temp.loadPgn(pgn);
  const moves = temp.history();
  const replay = new Chess();
  for (let i = 0; i < initialPly && i < moves.length; i++) {
    replay.move(moves[i]);
  }
  return replay.fen();
}

export function applyUciMoves(baseFen, uciMoves) {
  const chess = new Chess(baseFen);
  for (const m of uciMoves) {
    if (!m) continue;
    const from = m.slice(0, 2);
    const to = m.slice(2, 4);
    const promotion = m.length > 4 ? m.slice(4, 5) : undefined;
    chess.move({ from, to, promotion });
  }
  return chess.fen();
}

export function normalizeUci(move) {
  return String(move || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-h1-8qrbn]/g, '');
}

// Given a puzzle payload and how many solution moves have been applied so
// far ("step", starting at 0), compute the current board FEN and whether the
// puzzle is solved.
export function puzzleState(puzzle, step) {
  const baseFen = fenAtInitialPly(puzzle.game.pgn, puzzle.puzzle.initialPly);
  const solution = puzzle.puzzle.solution || [];
  const clampedStep = Math.max(0, Math.min(step, solution.length));
  const fen = applyUciMoves(baseFen, solution.slice(0, clampedStep));
  const solved = clampedStep >= solution.length;
  return { fen, solved, step: clampedStep, solutionLength: solution.length };
}

// ============================================================================
// Local AI opponent
//
// Lichess-account-free chess engine for the anonymous "vs AI" mode.
// The opponent's moves come from a free third-party remote engine
// (chess-api.com) when possible, falling back to a uniformly-random legal
// move if that call fails - so a flaky third party never leaves a game
// stuck, it just makes the AI weaker.
// ============================================================================

const REMOTE_DEPTH = { 1: 2, 2: 5, 3: 10, 4: 18 };
const REMOTE_TIMEOUT_MS = 8000;

export function randomLegalMove(chess) {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  const m = moves[Math.floor(Math.random() * moves.length)];
  return { from: m.from, to: m.to, promotion: m.promotion };
}

async function fetchRemoteAiMove(fen, depth) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const res = await fetch('https://chess-api.com/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen, depth }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.from && data.to) {
      return {
        from: String(data.from).toLowerCase(),
        to: String(data.to).toLowerCase(),
        promotion: data.promotion ? String(data.promotion).toLowerCase() : undefined,
      };
    }
  } catch {
    // network error, timeout, or bad JSON - fall through to a random move
  } finally {
    clearTimeout(timer);
  }
  return null;
}

export async function pickAiMove(chess, diff) {
  if (diff > 0) {
    const remote = await fetchRemoteAiMove(chess.fen(), REMOTE_DEPTH[diff] || 10);
    if (remote) return remote;
  }
  return randomLegalMove(chess);
}

export function applyAiMove(chess, move) {
  if (!move) return;
  try {
    chess.move(move);
  } catch {
    const fallback = randomLegalMove(chess);
    if (fallback) {
      try {
        chess.move(fallback);
      } catch {
        // Nothing legal could be applied - leave the position as-is.
      }
    }
  }
}

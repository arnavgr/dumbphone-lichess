// ---------------------------------------------------------------------------
// All chess.js-dependent logic: board rendering, puzzle logic, local AI.
// chess.js runs on the Worker only - the phone just gets rendered HTML.
// ---------------------------------------------------------------------------
import { Chess } from 'chess.js';

// ============================================================================
// Board rendering
// ============================================================================

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

const PIECE_FILES = {
  K: 'wK', Q: 'wQ', R: 'wR', B: 'wB', N: 'wN', P: 'wP',
  k: 'bK', q: 'bQ', r: 'bR', b: 'bB', n: 'bN', p: 'bP',
};

const CELL = 24;
const IMG = 20;

function pieceImg(code) {
  const f = PIECE_FILES[code];
  if (!f) return '';
  return `<img src="/images/${f}.png" width="${IMG}" height="${IMG}" alt="${code}" style="display:block;margin:auto;border:0;">`;
}

const SPACER = `<div style="width:${CELL}px;height:${CELL}px;"></div>`;

export function fenToPieceMap(fen) {
  const placement = fen.split(' ')[0];
  const rows = placement.split('/');
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
        // Solid colors only - rgba/border-radius can be missing on old browsers.
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
// Lichess puzzle payload: full game PGN + initialPly + solution (UCI array).
// The solver-to-move position is the game position at some ply, from which
// solution[0] must be legal. Previously we blindly replayed `initialPly`
// moves - if that replay produced nothing (chess.js version quirk, PGN
// parse issue, missing initialPly...), EVERY puzzle rendered the starting
// position and EVERY guess was wrong. That's exactly the reported bug.
//
// So now: puzzleBasePosition() VALIDATES the derived position by checking
// that solution[0] (and solution[1]) are legal from it, and if not, it
// searches nearby plies for the one that fits. If nothing fits, it throws
// with full diagnostics so the error page tells us exactly why.
// ============================================================================

export function normalizeUci(move) {
  return String(move || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-h1-8qrbn]/g, '');
}

// Parse the puzzle game's PGN into verbose moves. Primary path is
// chess.js's own loadPgn; the fallback is a crude tokenizer + replay, so a
// loadPgn failure mode can't silently leave us with zero moves.
function pgnToVerboseMoves(pgn) {
  const text = String(pgn || '');
  try {
    const tmp = new Chess();
    tmp.loadPgn(text);
    const hist = tmp.history({ verbose: true });
    if (hist.length) return hist;
  } catch {
    // fall through to the manual parser
  }
  const tokens = text
    .replace(/\{[^}]*\}/g, ' ') // { comments }
    .replace(/\$\d+/g, ' ') // NAGs
    .replace(/\d+\.{1,3}/g, ' ') // move numbers: "1." "12..."
    .replace(/1-0|0-1|1\/2-1\/2|\*/g, ' ') // result markers
    .split(/\s+/)
    .filter((t) => t && !/^\.\.?$/.test(t));
  const tmp = new Chess();
  const out = [];
  for (const t of tokens) {
    try {
      const m = tmp.move(t);
      if (!m) break; // chess.js 0.x-style null
      out.push(m);
    } catch {
      break;
    }
  }
  return out;
}

// Computes the solver-to-move position for a puzzle.
// Returns { fen, plyUsed, totalPlies, healed }. Throws with a diagnostic
// message if no position fits the solution (that message is shown to the
// user - send it back if you ever see it).
export function puzzleBasePosition(puzzle) {
  const solution = ((puzzle.puzzle && puzzle.puzzle.solution) || []).map(normalizeUci).filter(Boolean);
  if (!solution.length) throw new Error('Puzzle payload has no solution moves.');

  const pgn = puzzle.game && puzzle.game.pgn;
  const moves = pgnToVerboseMoves(pgn);
  if (!moves.length) {
    const p = String(pgn || '');
    throw new Error(
      `Could not parse any moves from the puzzle PGN (length ${p.length}, preview: "${p.slice(0, 60)}").`
    );
  }

  // FEN after every ply: fens[p] = position with p half-moves played.
  const replay = new Chess();
  const fens = [replay.fen()];
  for (const m of moves) {
    replay.move({ from: m.from, to: m.to, promotion: m.promotion });
    fens.push(replay.fen());
  }

  // True if solution[0] (and solution[1] if present) can be played from fens[ply].
  const fits = (ply) => {
    if (!Number.isFinite(ply) || ply < 0 || ply >= fens.length) return false;
    try {
      const ch = new Chess(fens[ply]);
      const u0 = solution[0];
      ch.move({ from: u0.slice(0, 2), to: u0.slice(2, 4), promotion: u0.slice(4, 5) || undefined });
      if (solution.length > 1) {
        const u1 = solution[1];
        ch.move({ from: u1.slice(0, 2), to: u1.slice(2, 4), promotion: u1.slice(4, 5) || undefined });
      }
      return true;
    } catch {
      return false;
    }
  };

  const claimed = Number(puzzle.puzzle.initialPly);

  // 1) Trust initialPly when it checks out.
  if (fits(claimed)) {
    return { fen: fens[claimed], plyUsed: claimed, totalPlies: moves.length, healed: false };
  }

  // 2) Self-heal: nearest ply where the solution fits.
  for (let d = 1; d <= moves.length + 1; d++) {
    if (fits(claimed + d)) {
      return { fen: fens[claimed + d], plyUsed: claimed + d, totalPlies: moves.length, healed: true };
    }
    if (fits(claimed - d)) {
      return { fen: fens[claimed - d], plyUsed: claimed - d, totalPlies: moves.length, healed: true };
    }
    if (!Number.isFinite(claimed) && fits(d)) {
      return { fen: fens[d], plyUsed: d, totalPlies: moves.length, healed: true };
    }
  }

  throw new Error(
    `Could not locate the puzzle position: initialPly=${JSON.stringify(puzzle.puzzle.initialPly)}, ` +
      `parsed ${moves.length} plies, first solution move ${solution[0]}.`
  );
}

export function applyUciMoves(baseFen, uciMoves) {
  const chess = new Chess(baseFen);
  for (const m of uciMoves) {
    if (!m) continue;
    chess.move({
      from: m.slice(0, 2),
      to: m.slice(2, 4),
      promotion: m.length > 4 ? m.slice(4, 5) : undefined,
    });
  }
  return chess.fen();
}

// Board/state after applying `step` solution moves on top of the base FEN.
export function puzzleStateFrom(baseFen, solution, step) {
  const clampedStep = Math.max(0, Math.min(step, solution.length));
  const fen = applyUciMoves(baseFen, solution.slice(0, clampedStep));
  return {
    fen,
    solved: clampedStep >= solution.length,
    step: clampedStep,
    solutionLength: solution.length,
  };
}

// ============================================================================
// Local AI opponent (anonymous "vs AI" mode)
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
    // fall through to a random move
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
        // leave position as-is
      }
    }
  }
}

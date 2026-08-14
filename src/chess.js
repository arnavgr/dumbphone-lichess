import { Chess } from 'chess.js';

// Board sizes. Widths include coordinate labels + 4px border:
//   tiny ~116px (fits 128px-wide screens), small ~156px,
//   normal ~220px (fits 240x320, default).
// NOTE: the old "large" size was removed - dumbphones don't come in larger
// screen sizes. boardSizeSpec() falls back to "normal" for unknown names, so
// a stale bsize=large cookie just becomes "normal".
export const BOARD_SIZES = {
  tiny: { cell: 14, img: 12, coord: 0 },
  small: { cell: 17, img: 14, coord: 8 },
  normal: { cell: 24, img: 20, coord: 12 },
};
export const BOARD_SIZE_KEYS = ['tiny', 'small', 'normal'];

export function boardSizeSpec(name) {
  return BOARD_SIZES[name] || BOARD_SIZES.normal;
}

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const PIECE_FILES = {
  K: 'wK', Q: 'wQ', R: 'wR', B: 'wB', N: 'wN', P: 'wP',
  k: 'bK', q: 'bQ', r: 'bR', b: 'bB', n: 'bN', p: 'bP',
};
const PIECE_NAMES = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };

// Human-readable label like "white pawn e2". Dumbphone browsers use the img
// alt text as the focus label; a distinct, descriptive label per piece/square
// makes D-pad navigation far more reliable than a one-letter alt.
function pieceAltText(code, square) {
  const color = code === code.toUpperCase() ? 'white' : 'black';
  const name = PIECE_NAMES[code.toUpperCase()] || 'piece';
  return square ? `${color} ${name} ${square}` : `${color} ${name}`;
}

function pieceImg(code, img, alt) {
  const f = PIECE_FILES[code];
  if (!f) return '';
  const a = alt || pieceAltText(code);
  return `<img src="/images/${f}.png" width="${img}" height="${img}" alt="${a}" title="${a}" style="display:block;margin:auto;border:0;">`;
}

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

// Squares touched by the last move played, as a UCI string (e.g. "e2e4"
// or "e7e8q"). Returns [] if there's nothing to highlight.
function lastMoveSquares(lastMove) {
  const uci = String(lastMove || '').toLowerCase();
  if (uci.length < 4) return [];
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return [];
  return [from, to];
}

// opts: size, interactive, selected, lastMove (uci string), selectHref(sq),
// moveHref(uci), isOwnPiece(sq,piece)
//
// Dumbphone-focus hardening:
//   - the table gets id="board" and every square gets id="sq-<square>" so a
//     redirect can end in #sq-e4 / #board and the browser stays on the board
//     after a reload instead of jumping to the top of the page;
//   - every cell has explicit width/height so a slow/failed image load can
//     never collapse a square and make that piece unfocusable;
//   - piece images carry descriptive alt/title text.
export function renderBoard(fen, orientation = 'white', opts = {}) {
  const { interactive = false, selected = null, selectHref, moveHref, isOwnPiece, lastMove } = opts;
  const spec = boardSizeSpec(opts.size);
  const CELL = spec.cell;
  const IMG = spec.img;
  const COORD = spec.coord;
  const showCoords = COORD > 0;
  const pieceMap = fenToPieceMap(fen);
  const movesFromSelected = interactive && selected ? legalMovesFrom(fen, selected) : {};
  const lastSquares = lastMoveSquares(lastMove);
  const ranksTopDown = orientation === 'black' ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const filesOrder = orientation === 'black' ? [...FILES].reverse() : FILES;
  const coordStyle = `background:#ccc;font-size:${Math.max(7, COORD - 2)}px;text-align:center;vertical-align:middle;`;
  const fileRow = () => {
    if (!showCoords) return '';
    let row = `<tr><td style="${coordStyle}width:${COORD}px;height:${COORD}px;"></td>`;
    for (const file of filesOrder) row += `<td style="${coordStyle}width:${CELL}px;height:${COORD}px;">${file}</td>`;
    row += `<td style="${coordStyle}width:${COORD}px;height:${COORD}px;"></td></tr>`;
    return row;
  };
  let html = '<table id="board" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:4px auto;border:2px solid #333;">';
  html += fileRow();
  for (const rank of ranksTopDown) {
    html += showCoords ? `<tr><td style="${coordStyle}width:${COORD}px;">${rank}</td>` : '<tr>';
    for (const file of filesOrder) {
      const square = `${file}${rank}`;
      const fileIdx = FILES.indexOf(file);
      const isLight = (rank - 1 + fileIdx) % 2 === 1;
      let bg = isLight ? '#f0d9b5' : '#946f51';
      const piece = pieceMap[square];
      const uci = movesFromSelected[square];
      if (selected === square) bg = '#ffed4a';
      else if (uci) bg = '#7bde7b';
      else if (lastSquares.includes(square)) bg = isLight ? '#cdeaa8' : '#a3cf7d';
      let inner = piece ? pieceImg(piece, IMG, pieceAltText(piece, square)) : `<div style="width:${CELL}px;height:${CELL}px;"></div>`;
      if (uci && moveHref) {
        const dot = Math.max(4, Math.floor(IMG / 2));
        const targetContent = piece
          ? pieceImg(piece, IMG, pieceAltText(piece, square))
          : `<div style="width:${dot}px;height:${dot}px;background:#333;margin:auto;"></div>`;
        inner = `<a href="${moveHref(uci)}" style="display:block;width:${CELL}px;height:${CELL}px;text-decoration:none;">${targetContent}</a>`;
      } else if (interactive && piece && typeof isOwnPiece === 'function' && isOwnPiece(square, piece) && selectHref) {
        inner = `<a href="${selectHref(square)}" style="display:block;width:${CELL}px;height:${CELL}px;text-decoration:none;">${pieceImg(piece, IMG, pieceAltText(piece, square))}</a>`;
      }
      html += `<td id="sq-${square}" width="${CELL}" height="${CELL}" style="width:${CELL}px;height:${CELL}px;min-width:${CELL}px;min-height:${CELL}px;padding:0;text-align:center;vertical-align:middle;background-color:${bg};border:1px solid #666;">${inner}</td>`;
    }
    html += showCoords ? `<td style="${coordStyle}width:${COORD}px;">${rank}</td></tr>` : '</tr>';
  }
  html += fileRow();
  html += '</table>';
  return html;
}

export function sideToMove(fen) {
  return fen.split(' ')[1] === 'w' ? 'white' : 'black';
}

// ---- Puzzle logic (self-healing: validates the derived position and, if it
// doesn't fit the solution, searches nearby plies) ----
export function normalizeUci(move) {
  return String(move || '').trim().toLowerCase().replace(/[^a-h1-8qrbn]/g, '');
}

function pgnToVerboseMoves(pgn) {
  const text = String(pgn || '');
  try {
    const tmp = new Chess();
    tmp.loadPgn(text);
    const hist = tmp.history({ verbose: true });
    if (hist.length) return hist;
  } catch {
    // fall through to manual parser
  }
  const tokens = text
    .replace(/{[^}]*}/g, ' ')
    .replace(/\$\d+/g, ' ')
    .replace(/\d+\.(\.\.)?/g, ' ')
    .replace(/1-0|0-1|1\/2-1\/2|\*/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !/^\d+$/.test(t));
  const tmp = new Chess();
  const out = [];
  for (const t of tokens) {
    try {
      const m = tmp.move(t);
      if (!m) break;
      out.push(m);
    } catch {
      break;
    }
  }
  return out;
}

export function puzzleBasePosition(puzzle) {
  const solution = ((puzzle.puzzle && puzzle.puzzle.solution) || []).map(normalizeUci).filter(Boolean);
  if (!solution.length) throw new Error('Puzzle payload has no solution moves.');
  const pgn = puzzle.game && puzzle.game.pgn;
  const moves = pgnToVerboseMoves(pgn);
  if (!moves.length) {
    const p = String(pgn || '');
    throw new Error(`Could not parse any moves from the puzzle PGN (length ${p.length}, preview: "${p.slice(0, 60)}").`);
  }
  const replay = new Chess();
  const fens = [replay.fen()];
  for (const m of moves) {
    replay.move({ from: m.from, to: m.to, promotion: m.promotion });
    fens.push(replay.fen());
  }
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
  if (fits(claimed)) return { fen: fens[claimed], plyUsed: claimed };
  for (let d = 1; d <= moves.length + 1; d++) {
    if (fits(claimed + d)) return { fen: fens[claimed + d], plyUsed: claimed + d };
    if (fits(claimed - d)) return { fen: fens[claimed - d], plyUsed: claimed - d };
    if (!Number.isFinite(claimed) && fits(d)) return { fen: fens[d], plyUsed: d };
  }
  throw new Error(
    `Could not locate the puzzle position: initialPly=${JSON.stringify(puzzle.puzzle.initialPly)},` +
    `parsed ${moves.length} plies, first solution move ${solution[0]}.`
  );
}

export function applyUciMoves(baseFen, uciMoves) {
  const chess = new Chess(baseFen);
  for (const m of uciMoves) {
    if (!m) continue;
    chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m.length > 4 ? m.slice(4, 5) : undefined });
  }
  return chess.fen();
}

export function puzzleStateFrom(baseFen, solution, step) {
  const clampedStep = Math.max(0, Math.min(step, solution.length));
  const fen = applyUciMoves(baseFen, solution.slice(0, clampedStep));
  return { fen, solved: clampedStep >= solution.length, step: clampedStep, solutionLength: solution.length };
}

// ---- Local AI opponent (anonymous mode) ----
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
    // fall through to random
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

// Returns the move actually played (which may be a random fallback, not
// the requested `move`, if that move turned out illegal) - or null if
// nothing could be played. Callers that want to display/highlight the
// move that was made (e.g. a "last move" indicator) should use this
// return value rather than assuming `move` itself was applied.
export function applyAiMove(chess, move) {
  if (!move) return null;
  try {
    chess.move(move);
    return move;
  } catch {
    const fallback = randomLegalMove(chess);
    if (fallback) {
      try {
        chess.move(fallback);
        return fallback;
      } catch {
        return null;
      }
    }
    return null;
  }
}

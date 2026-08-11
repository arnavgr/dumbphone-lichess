// Renders a FEN position as an HTML <table> board using PNG piece icons
// (served as static assets from /images/*.png - see wrangler.toml [assets]
// and the README for where to put them) plus tap-to-move: tap a piece to
// select it (its legal destination squares light up), then tap a
// destination to play the move - no typing, no JS required, just plain
// <a> links carrying the move in the URL. This mirrors a board/interaction
// design already confirmed to work on real dumbphone browsers (Opera Mini /
// feature-phone OEM browsers).

import { Chess } from 'chess.js';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

const PIECE_FILES = {
  K: 'wK', Q: 'wQ', R: 'wR', B: 'wB', N: 'wN', P: 'wP',
  k: 'bK', q: 'bQ', r: 'bR', b: 'bB', n: 'bN', p: 'bP',
};

const CELL = 24; // px, board square size
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

// Legal destination squares for the piece on `square`, given the current
// FEN, as a map of destination square -> full UCI move (e.g. "e2e4",
// or "e7e8q" for a pawn reaching the last rank - queen promotion is the
// one-tap default; the typed-move fallback form handles underpromotion).
//
// Best-effort only: chess.js doesn't model every Lichess variant exactly
// (Crazyhouse, Atomic, Horde, etc), so on non-standard variants this can be
// incomplete or throw - either way we just fall back to no highlighted
// squares rather than blocking the tap. The real legality check always
// happens server-side when the move is actually submitted to Lichess.
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

// orientation: 'white' (default, white at bottom) or 'black' (black at bottom)
//
// opts:
//   interactive  - if true, own pieces and legal destinations become <a> links
//   selected     - currently-selected square (lowercase, e.g. "e2"), or null
//   selectHref(square)        -> URL for tapping an own piece to select it
//   moveHref(uci)             -> URL for tapping a highlighted destination
//   isOwnPiece(square, piece) -> whether this piece belongs to the person to move
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

  let html = `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:4px auto;border:2px solid #333;">`;
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
        const targetContent = piece
          ? pieceImg(piece)
          : `<div style="width:${IMG / 2}px;height:${IMG / 2}px;background:rgba(0,0,0,.4);border-radius:50%;margin:auto;"></div>`;
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

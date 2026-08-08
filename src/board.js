// Renders a FEN position as a plain HTML <table> board using Unicode chess
// glyphs. No CSS, no JS - just <table>/<tr>/<td> with bgcolor/width/align
// attributes, which is what old Opera Mini / feature-phone browsers render
// reliably (this mirrors the approach used in the earlier dumbphone chess
// site, which fixed rendering bugs caused by relying on CSS layout instead).

const WHITE_GLYPH = {
  k: '\u2654',
  q: '\u2655',
  r: '\u2656',
  b: '\u2657',
  n: '\u2658',
  p: '\u2659',
};
const BLACK_GLYPH = {
  k: '\u265A',
  q: '\u265B',
  r: '\u265C',
  b: '\u265D',
  n: '\u265E',
  p: '\u265F',
};

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

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

// orientation: 'white' (default, white at bottom) or 'black' (black at bottom)
export function renderBoard(fen, orientation = 'white') {
  const pieceMap = fenToPieceMap(fen);
  const ranksTopDown = orientation === 'black' ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const filesOrder = orientation === 'black' ? [...FILES].reverse() : FILES;

  let html = '<table border="1" cellpadding="6" cellspacing="0">';
  for (const rank of ranksTopDown) {
    html += `<tr><td align="center"><b>${rank}</b></td>`;
    for (const file of filesOrder) {
      const fileIdx = FILES.indexOf(file);
      const isLight = (rank - 1 + fileIdx) % 2 === 1;
      const bg = isLight ? '#f0d9b5' : '#946f51';
      const piece = pieceMap[`${file}${rank}`];
      let glyph = '&nbsp;';
      if (piece) {
        glyph = piece === piece.toUpperCase() ? WHITE_GLYPH[piece.toLowerCase()] : BLACK_GLYPH[piece];
      }
      html += `<td align="center" bgcolor="${bg}" width="13%">${glyph}</td>`;
    }
    html += '</tr>';
  }
  html += '<tr><td>&nbsp;</td>';
  for (const file of filesOrder) html += `<td align="center"><b>${file}</b></td>`;
  html += '</tr></table>';
  return html;
}

export function sideToMove(fen) {
  return fen.split(' ')[1] === 'w' ? 'white' : 'black';
}

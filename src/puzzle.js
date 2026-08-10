// Lichess puzzle payloads give a full game PGN plus `initialPly` and a
// `solution` array of UCI moves. `initialPly` already points past the
// opponent's setup/blunder move - the FEN at that ply is the position
// ready for the solver to move. So:
//   solution[0] is the first move the solver must find
//   solution[1] is the opponent's forced reply (auto-played)
//   solution[2] is the solver's second move to find
//   ...and so on.
//
// puzzleState's `step` = number of solution moves already applied on top
// of the base FEN, starting at 0 (the initial, unsolved position).
//
// chess.js runs here on the Worker only (server-side) - the phone never runs
// any JS, it just gets a fresh rendered board + form on every request.

import { Chess } from 'chess.js';

// Position ready for the solver to move (Lichess's initialPly already
// accounts for the opponent's setup move having been played).
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

// Apply a list of UCI moves (e.g. "e2e4", "e7e8q") on top of a base FEN.
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
// far ("step", starting at 0), compute the current board FEN and whether
// the puzzle is solved.
export function puzzleState(puzzle, step) {
  const baseFen = fenAtInitialPly(puzzle.game.pgn, puzzle.puzzle.initialPly);
  const solution = puzzle.puzzle.solution || [];
  const clampedStep = Math.max(0, Math.min(step, solution.length));
  const fen = applyUciMoves(baseFen, solution.slice(0, clampedStep));
  const solved = clampedStep >= solution.length;
  return { fen, solved, step: clampedStep, solutionLength: solution.length };
}

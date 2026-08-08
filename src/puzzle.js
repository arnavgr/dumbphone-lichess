// Lichess puzzle payloads give a full game PGN plus `initialPly` (the ply at
// which the puzzle position occurs) and a `solution` array of UCI moves.
// solution[0] is the opponent's "blunder" move which is auto-played the
// instant the puzzle loads; solution[1] is the first move the solver must
// find; solution[2] is the opponent's forced reply (auto-played); and so on.
//
// chess.js runs here on the Worker only (server-side) - the phone never runs
// any JS, it just gets a fresh rendered board + form on every request.

import { Chess } from 'chess.js';

// Position right before the puzzle starts (before solution[0] is played).
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
// far ("step"), compute the current board FEN and whether the puzzle is solved.
export function puzzleState(puzzle, step) {
  const baseFen = fenAtInitialPly(puzzle.game.pgn, puzzle.puzzle.initialPly);
  const solution = puzzle.puzzle.solution || [];
  const clampedStep = Math.max(0, Math.min(step, solution.length));
  const fen = applyUciMoves(baseFen, solution.slice(0, clampedStep));
  const solved = clampedStep >= solution.length;
  return { fen, solved, step: clampedStep, solutionLength: solution.length };
}

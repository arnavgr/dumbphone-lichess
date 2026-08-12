// ---------------------------------------------------------------------------
// Game configuration.
//
// By design this app only offers standard chess with Rapid/Classical clocks:
//   - the local tap-to-move legality check (chess.js) only understands
//     standard chess, and
//   - standard rapid/classical is what works across every Lichess path we
//     use (Board API games, challenges, matchmaking pool).
// ---------------------------------------------------------------------------

export const TIME_CONTROLS = [
  { value: 'rapid-600-0', label: 'Rapid 10+0', clock: { limit: 600, increment: 0 } },
  { value: 'rapid-600-5', label: 'Rapid 10+5', clock: { limit: 600, increment: 5 } },
  { value: 'rapid-900-10', label: 'Rapid 15+10', clock: { limit: 900, increment: 10 } },
  { value: 'classical-1800-0', label: 'Classical 30+0', clock: { limit: 1800, increment: 0 } },
  { value: 'classical-1800-20', label: 'Classical 30+20', clock: { limit: 1800, increment: 20 } },
];

export function findTimeControl(value) {
  return TIME_CONTROLS.find((t) => t.value === value) || TIME_CONTROLS[0];
}

// AI level for real Lichess-hosted AI games (/game/new/ai), via the Board
// API's /api/challenge/ai - Lichess's own Stockfish, levels 1-8.
export const AI_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8];

// Difficulty for the anonymous, no-login local AI mode (/ai) - a different
// scale on purpose, since it's a different engine path (see chess.js):
// 0 plays uniformly-random legal moves, 1-4 call a remote engine at
// increasing search depth (falling back to random if that call fails).
export const LOCAL_AI_LEVELS = [
  { value: 0, label: '0 - Random moves' },
  { value: 1, label: '1 - Easy' },
  { value: 2, label: '2 - Medium' },
  { value: 3, label: '3 - Hard' },
  { value: 4, label: '4 - Very hard' },
];

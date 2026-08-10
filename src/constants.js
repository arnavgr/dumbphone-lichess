// All variants Lichess supports by default.
export const VARIANTS = [
  { value: 'standard', label: 'Standard' },
  { value: 'chess960', label: 'Chess960' },
  { value: 'crazyhouse', label: 'Crazyhouse' },
  { value: 'antichess', label: 'Antichess' },
  { value: 'atomic', label: 'Atomic' },
  { value: 'horde', label: 'Horde' },
  { value: 'kingOfTheHill', label: 'King of the Hill' },
  { value: 'racingKings', label: 'Racing Kings' },
  { value: 'threeCheck', label: 'Three-check' },
];

// Only Rapid and Classical are offered anywhere in this app (by request) -
// these also happen to be the two speeds guaranteed to work everywhere in
// the Lichess Board API (AI games, direct/open challenges, AND the real
// matchmaking pool used by "quick pair"), so there's no per-feature
// restriction logic needed anymore.
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

export const AI_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8];

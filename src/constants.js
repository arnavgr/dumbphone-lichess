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

// The Board API (which this whole site is built on) only supports certain
// speeds depending on the action:
//   - real matchmaking ("quick pair" / seek): Rapid, Classical, Correspondence only
//   - AI games / direct challenges / open challenges: those three PLUS Blitz
// Bullet is not supported by the Board API in either case, so it's left out
// of every time control list below. This is a Lichess API restriction, not
// a limitation of this site.

// label/value pairs. "clock" entries use clock.limit (seconds) + clock.increment (seconds).
// "days" entries are correspondence (no live clock).
export const TIME_CONTROLS_WITH_BLITZ = [
  { value: 'blitz-180-0', label: 'Blitz 3+0', clock: { limit: 180, increment: 0 } },
  { value: 'blitz-300-0', label: 'Blitz 5+0', clock: { limit: 300, increment: 0 } },
  { value: 'blitz-300-3', label: 'Blitz 5+3', clock: { limit: 300, increment: 3 } },
  { value: 'rapid-600-0', label: 'Rapid 10+0', clock: { limit: 600, increment: 0 } },
  { value: 'rapid-600-5', label: 'Rapid 10+5', clock: { limit: 600, increment: 5 } },
  { value: 'rapid-900-10', label: 'Rapid 15+10', clock: { limit: 900, increment: 10 } },
  { value: 'classical-1800-0', label: 'Classical 30+0', clock: { limit: 1800, increment: 0 } },
  { value: 'classical-1800-20', label: 'Classical 30+20', clock: { limit: 1800, increment: 20 } },
  { value: 'corr-1', label: 'Correspondence 1 day/move', days: 1 },
  { value: 'corr-3', label: 'Correspondence 3 days/move', days: 3 },
  { value: 'corr-7', label: 'Correspondence 7 days/move', days: 7 },
  { value: 'unlimited', label: 'No clock', clock: null },
];

export const TIME_CONTROLS_NO_BLITZ = TIME_CONTROLS_WITH_BLITZ.filter(
  (t) => !t.value.startsWith('blitz-')
);

export function findTimeControl(value, allowBlitz) {
  const list = allowBlitz ? TIME_CONTROLS_WITH_BLITZ : TIME_CONTROLS_NO_BLITZ;
  return list.find((t) => t.value === value) || list[0];
}

export const AI_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8];

// Standard chess only, Rapid/Classical only.
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

// AI games get an "Unlimited" option. clock: null means no clock params are sent.
export const AI_TIME_CONTROLS = [
  { value: 'unlimited', label: 'Unlimited (no timer)', clock: null },
  ...TIME_CONTROLS,
];

export function findAiTimeControl(value) {
  return AI_TIME_CONTROLS.find((t) => t.value === value) || AI_TIME_CONTROLS[0];
}

export const AI_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8];

export const LOCAL_AI_LEVELS = [
  { value: 0, label: '0 - Random moves' },
  { value: 1, label: '1 - Easy' },
  { value: 2, label: '2 - Medium' },
  { value: 3, label: '3 - Hard' },
  { value: 4, label: '4 - Very hard' },
];

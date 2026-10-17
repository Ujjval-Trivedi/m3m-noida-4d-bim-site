
export const STATUS = {
  none: { light: '#d7dde2', dark: '#313a42' },
  wip: { light: '#fab219', dark: '#fab219' },
  done: { light: '#0ca30c', dark: '#0ca30c' },
};

export const TASK_STATUS = [
  ['Not Committed', '#EEDC1D'],
  ['Not Ready', '#FF7261'],
  ['Ready', '#05E344'],
  ['Forced Ready', '#AFD127'],
  ['Started', '#541B60'],
  ['Warning', '#F7BF3F'],
  ['Stopped', '#E40000'],
  ['Complete', '#04962E'],
  ['Rejected at quality check', '#5A55B5'],
  ['Quality checked', '#024009'],
];

export const STATUS_SHOWN_AS = new Map([
  ['quality checked', 'Complete'],
  ['milestone completed', 'Complete'],
]);

export function shownStatus(name) {
  return STATUS_SHOWN_AS.get(String(name).trim().toLowerCase()) ?? name;
}

const STATUS_BY_NAME = new Map(TASK_STATUS.map(([k, v]) => [k.toLowerCase(), v]));
STATUS_BY_NAME.set('milestone completed', '#04962E');

export function taskStatusColor(name) {
  return STATUS_BY_NAME.get(String(name).trim().toLowerCase())
    || (mode === 'dark' ? '#46515b' : '#c9d1d8');
}

export function taskStatusInk(name) {
  const hex = taskStatusColor(name);
  const [r, g, b] = parse(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#0b0b0b' : '#ffffff';
}

export const STATUS_ORDER = new Map(TASK_STATUS.map(([k], i) => [k.toLowerCase(), i]));

export function planStateColor(state) {
  switch (state) {
    case 'done': return '#04962E';
    case 'started': return '#541B60';
    case 'behind': return '#FF7261';
    default: return mode === 'dark' ? '#2b333b' : '#d5dbe0';
  }
}
export const PLAN_STATE_ORDER = ['done', 'started', 'behind', 'notdue'];

export const MARKER = {
  now: { light: '#2a78d6', dark: '#3987e5' },
  plan: { light: '#ec835a', dark: '#ec835a' },
  aop: { light: '#0ca30c', dark: '#0ca30c' },
};

const SEQ = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7',
  '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
const SEQ_DARK = ['#123049', '#143a5c', '#164470', '#184f95', '#1c5cab', '#256abf',
  '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6'];

let mode = 'light';
export function setMode(m) { mode = m === 'dark' ? 'dark' : 'light'; }
export function getMode() { return mode; }

export const surface = () => (mode === 'dark' ? '#161b20' : '#ffffff');
export const surfaceLow = () => (mode === 'dark' ? '#0e1216' : '#f5f6f8');
export const gridInk = () => (mode === 'dark' ? '#2d353d' : '#e0e5e9');
export const textInk = () => (mode === 'dark' ? '#c2ccd3' : '#626e76');
export const textStrong = () => (mode === 'dark' ? '#f4f6f8' : '#2b3237');

export const statusColor = (s) => STATUS[s][mode];
export const markerColor = (k) => MARKER[k][mode];

export function sequential(pct) {
  const ramp = mode === 'dark' ? SEQ_DARK : SEQ;
  if (!Number.isFinite(pct) || pct <= 0) return mode === 'dark' ? '#1b2127' : '#f4f6f9';
  const i = Math.min(ramp.length - 1, Math.max(0, Math.round((pct / 100) * (ramp.length - 1))));
  return ramp[i];
}

export function sequentialInk(pct) {
  if (!Number.isFinite(pct) || pct <= 0) return mode === 'dark' ? '#99aab6' : '#7e8c96';
  const deep = mode === 'dark' ? pct < 45 : pct > 45;
  return deep ? (mode === 'dark' ? '#0b0b0b' : '#ffffff') : (mode === 'dark' ? '#ffffff' : '#0b0b0b');
}

export function diverging(delta, span = 40) {
  if (!Number.isFinite(delta)) return mode === 'dark' ? '#1b2127' : '#f4f6f9';
  const t = Math.max(-1, Math.min(1, delta / span));
  const mid = mode === 'dark' ? [45, 53, 61] : [238, 241, 244];
  const pos = mode === 'dark' ? [57, 135, 229] : [42, 120, 214];
  const neg = mode === 'dark' ? [224, 82, 82] : [208, 59, 59];
  const end = t >= 0 ? pos : neg;
  const k = Math.abs(t);
  const c = mid.map((m, i) => Math.round(m + (end[i] - m) * k));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export const hexToInt = (hex) => parseInt(String(hex).replace('#', ''), 16);

export function mix(a, b, t) {
  const pa = parse(a), pb = parse(b);
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
function parse(h) {
  const s = String(h).replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}

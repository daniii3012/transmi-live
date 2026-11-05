import type { End } from './places';

/** Estaciones y paraderos usados hace poco en el planificador (en el dispositivo, los 6 últimos). */
const KEY = 'transmi-live:recientes:v1';
type Placed = Extract<End, { kind: 'station' | 'stop' }>;

export function recentEnds(): Placed[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}

export function rememberEnd(e: End) {
  if (e.kind !== 'station' && e.kind !== 'stop') return;
  const list = [e, ...recentEnds().filter((x) => !(x.kind === e.kind && x.id === e.id))].slice(0, 6);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* modo privado */ }
}

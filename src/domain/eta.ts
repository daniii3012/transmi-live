import type { Pattern } from './types';

/**
 * Estimación de llegadas (decisiones/009). El horario da, por franja, el tiempo acumulado a lo largo
 * del patrón de la ruta; entre dos paradas se interpola por distancia. El ritmo observado del bus
 * (cuánto tardó realmente en sus últimos minutos frente a lo que dice el horario) ajusta el resultado.
 */
export const BAND_HOURS = [[0, 6], [6, 9], [9, 16], [16, 20], [20, 30]] as const;

export function bandIndex(secOfDay: number): number {
  const h = secOfDay / 3600;
  const i = BAND_HOURS.findIndex(([a, b]) => h >= a && h < b);
  return i < 0 ? 4 : i;
}

/** Tiempos de la franja pedida o, si esa franja no tiene viajes, de la más cercana que sí. */
export function bandTimes(p: Pattern, band: number): number[] | null {
  for (let d = 0; d < 5; d++) {
    for (const b of [band - d, band + d]) if (b >= 0 && b < p.t.length && p.t[b]) return p.t[b];
  }
  return null;
}

/** Tiempo del horario (s desde el inicio del viaje) en la abscisa `s`. */
export function timeAt(p: Pattern, t: number[], s: number): number {
  const S = p.s;
  if (!S.length) return 0;
  if (s <= S[0]) return t[0];
  for (let i = 1; i < S.length; i++) {
    if (s <= S[i]) {
      const f = S[i] > S[i - 1] ? (s - S[i - 1]) / (S[i] - S[i - 1]) : 1;
      return t[i - 1] + (t[i] - t[i - 1]) * f;
    }
  }
  return t[t.length - 1];
}

/** Índice de la primera parada por delante de la abscisa `s` (con 8 m de tolerancia). */
export function nextStopIndex(p: Pattern, s: number): number {
  const S = p.s;
  for (let i = 0; i < S.length; i++) if (S[i] > s + 8) return i;
  return S.length;
}

export interface Sample { at: number; s: number }

/**
 * Ritmo observado: tiempo real / tiempo del horario sobre el tramo recorrido en las muestras (al
 * menos 90 s de horario). Entre 0,6 y 1,8; 1 si no hay con qué medir.
 */
export function pace(p: Pattern, t: number[], hist: Sample[]): number {
  if (hist.length < 2) return 1;
  const a = hist[0], b = hist[hist.length - 1];
  const sched = timeAt(p, t, b.s) - timeAt(p, t, a.s);
  const real = (b.at - a.at) / 1000;
  if (sched < 90 || real <= 0) return 1;
  return Math.min(1.8, Math.max(0.6, real / sched));
}

export interface Eta { index: number; stopId: string; s: number; seconds: number; meters: number }

/**
 * Llegadas estimadas a las paradas que le quedan al bus. `sFix` es la abscisa de la última lectura
 * y `fixAge` cuántos segundos han pasado desde ella: se descuentan.
 */
export function etas(p: Pattern, band: number, sFix: number, fixAge: number, k = 1, limit = 99): Eta[] {
  const t = bandTimes(p, band);
  if (!t) return [];
  const t0 = timeAt(p, t, sFix);
  const out: Eta[] = [];
  for (let i = nextStopIndex(p, sFix); i < p.stops.length && out.length < limit; i++) {
    const sec = Math.max(0, (t[i] - t0) * k - fixAge);
    out.push({ index: i, stopId: p.stops[i], s: p.s[i], seconds: sec, meters: Math.max(0, p.s[i] - sFix) });
  }
  return out;
}

/** «llegando», «3 min», «1 h 05». */
export function etaText(sec: number): string {
  if (sec < 60) return 'llegando';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

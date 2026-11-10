import type { Network } from '../data/network';
import type { Fleet, Bus } from '../live/fleet';
import { DROP_AGE } from '../live/fleet';
import type { Route } from '../domain/types';
import { bandIndex, bandTimes, timeAt, pace, adjust } from '../domain/eta';
import { bogotaSeconds, dayType } from '../domain/time';

/** Buses por ruta, recalculado una vez por instantánea. */
let cache: { fleet: Fleet | null; version: number; map: Map<string, Bus[]> } = { fleet: null, version: -1, map: new Map() };
export function busesByRoute(fleet: Fleet, version: number): Map<string, Bus[]> {
  if (cache.fleet === fleet && cache.version === version) return cache.map;
  const map = new Map<string, Bus[]>();
  for (const b of fleet.buses.values()) {
    if (b.age > DROP_AGE) continue;
    let l = map.get(b.routeId);
    if (!l) map.set(b.routeId, (l = []));
    l.push(b);
  }
  for (const l of map.values()) l.sort((a, b) => a.sFix - b.sFix);
  cache = { fleet, version, map };
  return map;
}

export interface Arrival { route: Route; bus: Bus; seconds: number; meters: number; stopId: string; /** Antigüedad de la lectura (s). */ age: number }

/** Con una lectura más vieja que esto no se estima una llegada (el bus dejó de reportar). */
export const MAX_FIX_AGE = 240;
/** Si por el horario el bus debió llegar hace más de esto, lo más probable es que ya pasó. */
export const PASSED_S = 90;

/**
 * Próximas llegadas a un conjunto de paradas (una estación con sus vagones, o un paradero): para cada
 * bus de las rutas que paran, la primera de esas paradas que tiene por delante y cuánto le falta.
 */
export function arrivals(net: Network, fleet: Fleet, version: number, stopIds: Set<string>, routeIds: string[], now: number): Arrival[] {
  const byRoute = busesByRoute(fleet, version);
  const band = bandIndex(bogotaSeconds(now));
  const out: Arrival[] = [];
  for (const rid of routeIds) {
    const route = net.routes.get(rid);
    const p = net.pattern(rid);
    const buses = byRoute.get(rid);
    if (!route || !p || !buses) continue;
    const t = bandTimes(p, band);
    if (!t) continue;
    const idx: number[] = [];
    p.stops.forEach((s, i) => { if (stopIds.has(s)) idx.push(i); });
    if (!idx.length) continue;
    for (const b of buses) {
      if (!b.onPath) continue;
      const k = idx.find((i) => p.s[i] > b.sFix + 8);
      if (k === undefined) continue;
      // La lectura tiene su edad (1 a 2 min, más si el alimentador omitió el bus): se descuenta. Si es
      // demasiado vieja, o por el horario el bus debió llegar hace rato, no se promete un «llegando».
      const fixAge = (now - b.fixAt) / 1000;
      if (fixAge > MAX_FIX_AGE) continue;
      const raw = adjust(t[k] - timeAt(p, t, b.sFix), pace(p, t, b.hist)) - fixAge;
      if (raw < -PASSED_S) continue;
      const sec = Math.max(0, raw);
      if (sec > 75 * 60) continue;
      out.push({ route, bus: b, seconds: sec, meters: p.s[k] - b.sFix, stopId: p.stops[k], age: fixAge });
    }
  }
  return out.sort((a, b) => a.seconds - b.seconds);
}

/** Salidas programadas en la hora actual y el intervalo medio («cada 4 min»). */
export function frequencyNow(net: Network, routeId: string, now: number): { perHour: number; every: number | null; first: number | null; last: number | null } | null {
  const svc = net.serviceOf(routeId);
  if (!svc) return null;
  const day = svc[dayType(now)];
  if (!day) return { perHour: 0, every: null, first: null, last: null };
  const h = Math.floor(bogotaSeconds(now) / 3600);
  // Las horas del GTFS pasan de 24 de madrugada: la 1 a. m. es la hora 25 del día de servicio anterior.
  const n = day.h[h] || (h < 4 ? day.h[h + 24] || 0 : 0);
  return { perHour: n, every: n ? Math.round(60 / n) : null, first: day.first, last: day.last };
}

/** Normaliza para buscar: sin tildes, minúsculas, sin signos. */
export function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

import type { Network } from '../data/network';
import type { Fleet, Bus } from '../live/fleet';
import type { Route, Station } from '../domain/types';
import { bandIndex, bandTimes, timeAt, pace, adjust } from '../domain/eta';
import { bogotaSeconds } from '../domain/time';
import { busesByRoute, MAX_FIX_AGE, PASSED_S } from '../ui/derive';
import { classOf } from '../domain/filter';
import { KX, KY } from '../domain/geo';
import palette from '../../data/curated/palette.json';

/**
 * Datos del momento (R10.8 y R10.9): lo que «Ahora» muestra en el inicio y lo que el recorrido visita.
 * Todo sale de las lecturas recientes de la flota visible (el filtro de sistemas se respeta); lo
 * estimado (llegadas) se dice como tal en la interfaz.
 */

/** Buses troncales, duales y del cable que llegan a cada estación en los próximos `horizon` s (estimado). */
export function stationLoads(net: Network, fleet: Fleet, version: number, now: number, horizon = 300): Map<string, number> {
  const out = new Map<string, number>();
  const band = bandIndex(bogotaSeconds(now));
  for (const [rid, buses] of busesByRoute(fleet, version)) {
    const route = net.routes.get(rid);
    if (!route || (route.sys !== 'troncal' && route.sys !== 'dual' && route.sys !== 'cable')) continue;
    const p = net.pattern(rid);
    const t = p ? bandTimes(p, band) : null;
    if (!p || !t) continue;
    for (const b of buses) {
      if (!b.onPath || fleet.isHidden(b)) continue;
      const fixAge = (now - b.fixAt) / 1000;
      if (fixAge > MAX_FIX_AGE) continue;
      const k0 = pace(p, t, b.hist), t0 = timeAt(p, t, b.sFix);
      const seen = new Set<string>();
      for (let i = 0; i < p.stops.length; i++) {
        if (p.s[i] <= b.sFix + 8) continue;
        const sec = adjust(t[i] - t0, k0) - fixAge;
        if (sec < -PASSED_S) continue;
        if (sec > horizon) break;
        const st = net.stationOf.get(p.stops[i]);
        if (!st || seen.has(st.id)) continue;
        seen.add(st.id);
        out.set(st.id, (out.get(st.id) ?? 0) + 1);
      }
    }
  }
  return out;
}

export interface NowFacts {
  /** Ruta (por código) con más buses en vía. */
  route: { route: Route; n: number } | null;
  /** Estación con más llegadas en 5 min (estimado). */
  station: { station: Station; n: number } | null;
  /** Estación con más buses troncales detenidos cerca (la fila más larga). */
  queue: { station: Station; n: number } | null;
  /** Troncal (corredor) con la velocidad media más baja de sus buses en marcha. */
  slowZone: { zone: string; name: string; color: string; kmh: number; n: number } | null;
}

const ZONES = palette.zones as Record<string, { name: string; color: string }>;

export function nowFacts(net: Network, fleet: Fleet, version: number, now: number): NowFacts {
  // Ruta con más buses (los dos sentidos juntos), de las clases visibles.
  const byCode = new Map<string, { id: string; n: number }>();
  for (const [rid, list] of busesByRoute(fleet, version)) {
    const r = net.routes.get(rid);
    const cls = r ? classOf(r.sys, r.sub) : undefined;
    if (!r || (cls && fleet.hidden.has(cls))) continue;
    const key = `${r.sys}:${r.code}`;
    const n = list.filter((b) => !b.missing).length;
    const cur = byCode.get(key);
    if (!cur) byCode.set(key, { id: rid, n }); else cur.n += n;
  }
  const top = [...byCode.values()].sort((a, b) => b.n - a.n)[0];
  const route = top && top.n > 0 ? { route: net.routes.get(top.id)!, n: top.n } : null;

  const loads = stationLoads(net, fleet, version, now);
  let station: NowFacts['station'] = null;
  for (const [id, n] of loads) if (!station || n > station.n) { const s = net.stations.get(id); if (s && !s.closed) station = { station: s, n }; }

  // Fila: buses troncales y duales casi quietos (< 4 km/h) a menos de 200 m de una estación. Los
  // portales no cuentan: ahí los buses esperan su salida o se estacionan.
  const stations = [...net.stations.values()].filter((s) => !s.closed && s.kind === 'station');
  const stopped: Bus[] = [];
  const speeds = new Map<string, { s: number; n: number }>();
  for (const b of fleet.buses.values()) {
    if ((b.sys !== 'troncal' && b.sys !== 'dual') || b.missing || b.age > 150 || fleet.isHidden(b) || b.speed == null || !b.onPath) continue;
    if (b.speed < 4 / 3.6) stopped.push(b);
    const z = b.sys === 'troncal' ? b.route?.zone : undefined;
    if (z && ZONES[z] && b.speed > 1.5) { const a = speeds.get(z) ?? { s: 0, n: 0 }; a.s += b.speed; a.n++; speeds.set(z, a); }
  }
  let queue: NowFacts['queue'] = null;
  if (stopped.length) {
    const near = new Map<string, number>();
    for (const b of stopped) {
      let best: Station | null = null, bd = 200 * 200;
      for (const s of stations) {
        const d = (s.lon * KX - b.fixX) ** 2 + (s.lat * KY - b.fixY) ** 2;
        if (d < bd) { bd = d; best = s; }
      }
      if (best) near.set(best.id, (near.get(best.id) ?? 0) + 1);
    }
    for (const [id, n] of near) if (n >= 3 && (!queue || n > queue.n)) queue = { station: net.stations.get(id)!, n };
  }

  let slowZone: NowFacts['slowZone'] = null;
  for (const [z, a] of speeds) {
    if (a.n < 12) continue;
    const kmh = (a.s / a.n) * 3.6;
    if (!slowZone || kmh < slowZone.kmh) slowZone = { zone: z, name: ZONES[z].name, color: ZONES[z].color, kmh, n: a.n };
  }
  return { route, station, queue, slowZone };
}


import type { MetricPath } from '../domain/geo';
import type { Route } from '../domain/types';

/**
 * Variante (y sentido) de nuestra red para una lectura del respaldo por ruta. El servicio responde por
 * código (C15, 5, K86…) con los dos sentidos mezclados, y su `route_id` no basta para el sentido (la
 * app nativa documenta que el K86 del aeropuerto y el de El Dorado comparten id). Entre las variantes
 * con ese código y del mismo sistema, gana la que mejor reúne:
 *
 * - destino: el que reporta el servicio coincide con el de la variante (+3);
 * - rumbo: el del bus (brújula) va con el del recorrido en ese punto (+1,5) o en contra (−3);
 * - el `route_id` del servicio, si es esa variante (+1), y la que el bus ya tenía (+0,5);
 * - cercanía al recorrido (−1 por cada 60 m; a más de 120 m, descartada).
 *
 * Sin variante a menos de 120 m, nada: no se inventa.
 */
export interface Reading {
  routeId: string;
  code: string;
  dest: string;
  sys: 'troncal' | 'zonal';
  /** Metros locales (lon·KX, lat·KY). */
  x: number;
  y: number;
  /** Rumbo de brújula (grados, 0 = norte, horario); negativo si no se conoce. */
  bearing: number;
}

export interface NetLike {
  routes: Map<string, Route>;
  paths: Map<string, MetricPath>;
  resolveRoute(id: string): string | null;
}

export const normName = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** ¿Mismo destino? Uno contiene al otro, o comparten al menos la mitad de sus palabras. */
export function sameDest(a: string, b: string): boolean {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const wa = new Set(x.split(' ')), wb = new Set(y.split(' '));
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size) >= 0.5;
}

export function resolveReading(net: NetLike, r: Reading, prevRouteId?: string): string | null {
  const code = r.code.toUpperCase();
  const direct = r.routeId ? net.resolveRoute(r.routeId) : null;
  const busAng = r.bearing >= 0 ? ((90 - r.bearing) * Math.PI) / 180 : null;
  let best: { id: string; score: number } | null = null;
  for (const route of net.routes.values()) {
    if (route.code.toUpperCase() !== code) continue;
    if ((r.sys === 'zonal') !== (route.sys === 'zonal')) continue;
    const path = net.paths.get(route.id);
    const hit = path?.nearest(r.x, r.y, undefined, 0, Infinity, 120);
    if (!path || !hit || hit.d > 120) continue;
    let score = -hit.d / 60;
    if (sameDest(r.dest, route.dest)) score += 3;
    if (busAng !== null) {
      const c = Math.cos(busAng - path.headingAt(hit.s));
      score += c > 0.5 ? 1.5 : c < -0.5 ? -3 : 0;
    }
    if (route.id === direct) score += 1;
    if (route.id === prevRouteId) score += 0.5;
    if (!best || score > best.score) best = { id: route.id, score };
  }
  return best?.id ?? null;
}

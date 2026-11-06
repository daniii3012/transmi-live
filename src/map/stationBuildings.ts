import type { FilterSpecification, Map as MLMap } from 'maplibre-gl';
import type { Network } from '../data/network';
import { KX, KY } from '../domain/geo';

/**
 * Edificios del mapa base que son la estación misma (OSM `building=bus_station`, cubiertas de
 * plataformas, rampas): en 3D no se levantan, para que no dupliquen la estación propia (cuerpo y techo)
 * ni levanten una provisional, que no se modela. No se levanta un edificio que toque (a ≤ `PAD` m):
 *
 * - una huella de estación (OSM suele partir la estación en una pieza por vagón y la huella estimada
 *   puede correrse);
 * - la franja del separador alrededor de cada estación: su huella alargada `EXT` m por punta y ensanchada
 *   `SIDE` m por lado (cubiertas y rampas que la huella no alcanza); en una provisional, que no tiene
 *   huella, 260 × 20 m a lo largo del carril más cercano.
 *
 * Se decide por geometría, con la expresión `distance` de MapLibre en el filtro de la capa. Antes se
 * marcaba cada edificio por su id con un estado de entidad, pero las teselas del mapa base repiten ids
 * entre edificios distintos (el mismo id a más de 1 km): al marcar uno se aplanaban muchos de la ciudad,
 * unos segundos después de cargar (revisión del 6 nov.). Con polígonos simples el filtro casi no cuesta;
 * con los ejes de los carriles (miles de tramos) la carga de teselas tardaba diez veces más.
 */
const PAD = 6; // m
const EXT = 25; // m
const SIDE = 4; // m

type Ring = [number, number][];
type P = [number, number];

/** Rectángulo (lon, lat) de centro `c`, eje `u` (metros locales), semilargo `a` y semiancho `b`. */
function rect(c: P, u: P, a: number, b: number): Ring {
  const v: P = [-u[1], u[0]];
  const r = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([sa, sb]) => [(c[0] + u[0] * a * sa + v[0] * b * sb) / KX, (c[1] + u[1] * a * sa + v[1] * b * sb) / KY] as P);
  return r;
}

/** Eje (lado más largo), centro, largo y ancho de un conjunto de anillos en metros locales. */
function frameOf(rings: P[][]): { c: P; u: P; L: number; W: number } {
  const all = rings.flat();
  let best = 0, u: P = [1, 0];
  for (const r of rings) for (let i = 1; i < r.length; i++) {
    const l = Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]);
    if (l > best) { best = l; u = [(r[i][0] - r[i - 1][0]) / l, (r[i][1] - r[i - 1][1]) / l]; }
  }
  const o = all[0];
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const p of all) {
    const a = (p[0] - o[0]) * u[0] + (p[1] - o[1]) * u[1], b = -(p[0] - o[0]) * u[1] + (p[1] - o[1]) * u[0];
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
  }
  const ma = (a0 + a1) / 2, mb = (b0 + b1) / 2;
  return { c: [o[0] + u[0] * ma - u[1] * mb, o[1] + u[1] * ma + u[0] * mb], u, L: a1 - a0, W: b1 - b0 };
}

export function hideStationBuildings(map: MLMap, net: Network) {
  const base: Ring[][] = [];
  for (const s of net.stations.values()) {
    if (s.kind === 'cable' || !s.fp?.length) continue;
    for (const r of s.fp) {
      const ring = r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r : [...r, r[0]];
      if (ring.length >= 4) base.push([ring as Ring]);
    }
    if (s.kind === 'portal') continue;
    const f = frameOf(s.fp.map((r) => r.map(([lo, la]) => [lo * KX, la * KY] as P)));
    base.push([rect(f.c, f.u, f.L / 2 + EXT, f.W / 2 + SIDE)]);
  }
  /** Provisionales (sin huella): a lo largo del carril más cercano. */
  const provisional = (): Ring[][] => {
    if (!net.lanes) return [];
    const out: Ring[][] = [];
    for (const s of net.stations.values()) {
      if (!s.prov) continue;
      const p: P = [s.lon * KX, s.lat * KY];
      let best = Infinity, u: P = [1, 0];
      for (const l of net.lanes) {
        const c = l.c;
        for (let i = 2; i < c.length; i += 2) {
          const ax = c[i - 2] * KX, ay = c[i - 1] * KY, bx = c[i] * KX, by = c[i + 1] * KY;
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
          const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
          const d = Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy);
          if (d < best) { best = d; const l = Math.sqrt(l2); u = [dx / l, dy / l]; }
        }
      }
      if (best < 60) out.push([rect(p, u, 130, 10)]);
    }
    return out;
  };
  const apply = () => {
    if (!map.getLayer('building-3d')) return;
    const geo = { type: 'MultiPolygon', coordinates: [...base, ...provisional()] };
    map.setFilter('building-3d', ['>', ['distance', geo], PAD] as unknown as FilterSpecification);
  };
  apply();
  // Los carriles llegan al acercarse (Network.loadLanes): con ellos se suman las provisionales.
  if (!net.lanes) void net.loadLanes().then(apply);
  return apply;
}

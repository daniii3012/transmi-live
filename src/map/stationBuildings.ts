import type { Map as MLMap } from 'maplibre-gl';
import type { Network } from '../data/network';
import { KX, KY } from '../domain/geo';

/**
 * Edificios del mapa base que son la estación misma (OSM `building=bus_station`, cubiertas de
 * plataformas, rampas): en 3D se aplanan con un estado de entidad para que no dupliquen la estación
 * propia (cuerpo y techo) ni levanten una provisional, que no se modela. Un edificio se aplana si:
 *
 * - se solapa con una huella de estación (con `PAD` de holgura; no basta con que su centro caiga
 *   dentro: OSM suele partir la estación en una pieza por vagón y la huella estimada puede correrse);
 * - o es una estructura sobre el separador de la troncal (centro a ≤ `MEDIAN` del eje de un carril
 *   exclusivo) a menos de `NEAR` de una estación que no sea portal: así caen las cubiertas de las
 *   provisionales y las piezas que la huella no alcanza. Los edificios de la calle quedan más lejos.
 *
 * Los edificios partidos entre teselas llegan en varias piezas con el mismo id: se revisa cada pieza.
 * Se recorre lo cargado al quedar quieto el mapa, solo en 3D y desde z14,5.
 */
type Ring = [number, number][];
interface Fp { box: [number, number, number, number]; rings: Ring[] }

const PAD = 6; // m
const MEDIAN = 8; // m
const NEAR = 250; // m
const G = 60; // m, celda de los índices

function inside(p: [number, number], ring: Ring): boolean {
  let ok = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) ok = !ok;
  }
  return ok;
}
function segDist(p: [number, number], ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
  const f = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
  return Math.hypot(p[0] - ax - f * dx, p[1] - ay - f * dy);
}
function distToRing(p: [number, number], ring: Ring): number {
  let best = Infinity;
  for (let i = 1; i < ring.length; i++) best = Math.min(best, segDist(p, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]));
  return best;
}
/** ¿Se tocan (con holgura `pad`) dos anillos? */
function overlaps(a: Ring, b: Ring, pad: number): boolean {
  for (const p of a) if (inside(p, b) || distToRing(p, b) <= pad) return true;
  for (const p of b) if (inside(p, a)) return true;
  return false;
}

export function hideStationBuildings(map: MLMap, net: Network) {
  const fps: Fp[] = [];
  const points: [number, number][] = [];
  for (const s of net.stations.values()) {
    if (s.kind !== 'portal' && s.kind !== 'cable') points.push([s.lon * KX, s.lat * KY]);
    if (!s.fp?.length) continue;
    const rings = s.fp.map((r) => r.map(([lo, la]) => [lo * KX, la * KY] as [number, number]));
    const all = rings.flat();
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    fps.push({ box: [Math.min(...xs) - PAD, Math.min(...ys) - PAD, Math.max(...xs) + PAD, Math.max(...ys) + PAD], rings });
  }
  // Índice de los carriles exclusivos (llegan al acercarse; ver Network.loadLanes).
  let lanes: Map<string, number[]> | null = null;
  const indexLanes = () => {
    if (lanes || !net.lanes) return;
    lanes = new Map();
    for (const l of net.lanes) {
      const c = l.c;
      for (let i = 2; i < c.length; i += 2) {
        const ax = c[i - 2] * KX, ay = c[i - 1] * KY, bx = c[i] * KX, by = c[i + 1] * KY;
        for (let gx = Math.floor(Math.min(ax, bx) / G); gx <= Math.floor(Math.max(ax, bx) / G); gx++) {
          for (let gy = Math.floor(Math.min(ay, by) / G); gy <= Math.floor(Math.max(ay, by) / G); gy++) {
            const k = `${gx}:${gy}`;
            let a = lanes.get(k);
            if (!a) lanes.set(k, (a = []));
            a.push(ax, ay, bx, by);
          }
        }
      }
    }
  };
  const nearLane = (p: [number, number]) => {
    const a = lanes?.get(`${Math.floor(p[0] / G)}:${Math.floor(p[1] / G)}`);
    if (!a) return false;
    for (let i = 0; i < a.length; i += 4) if (segDist(p, a[i], a[i + 1], a[i + 2], a[i + 3]) <= MEDIAN) return true;
    return false;
  };
  const nearStation = (p: [number, number]) => points.some((q) => Math.abs(q[0] - p[0]) < NEAR && Math.abs(q[1] - p[1]) < NEAR && Math.hypot(q[0] - p[0], q[1] - p[1]) < NEAR);

  const flagged = new Set<string | number>();
  const seen = new Set<string>();
  const run = () => {
    if (map.getZoom() < 14.5 || map.getLayoutProperty('building-3d', 'visibility') === 'none') return;
    if (!net.lanes) { void net.loadLanes().then(() => { indexLanes(); run(); }); }
    indexLanes();
    for (const f of map.querySourceFeatures('omt', { sourceLayer: 'building' })) {
      if (f.id == null || flagged.has(f.id)) continue;
      const g = f.geometry;
      const outers = g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [];
      for (const outer of outers) {
        if (!outer || outer.length < 3) continue;
        // Pieza ya revisada (con o sin carriles cargados: la regla del separador necesita los carriles).
        const key = `${f.id}:${outer[0][0].toFixed(6)},${outer[0][1].toFixed(6)}:${outer.length}:${lanes ? 1 : 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ring = outer.map(([lo, la]) => [lo * KX, la * KY] as [number, number]);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0;
        for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); cx += x; cy += y; }
        const c: [number, number] = [cx / ring.length, cy / ring.length];
        let hit = false;
        for (const fp of fps) {
          if (x1 < fp.box[0] || x0 > fp.box[2] || y1 < fp.box[1] || y0 > fp.box[3]) continue;
          if (fp.rings.some((r) => overlaps(ring, r, PAD))) { hit = true; break; }
        }
        if (!hit && lanes && Math.max(x1 - x0, y1 - y0) < 400 && nearLane(c) && nearStation(c)) hit = true;
        if (hit) {
          map.setFeatureState({ source: 'omt', sourceLayer: 'building', id: f.id }, { station: true });
          flagged.add(f.id);
          break;
        }
      }
    }
  };
  map.on('idle', run);
  return run;
}

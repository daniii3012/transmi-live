import type { Map as MLMap } from 'maplibre-gl';
import type { Network } from '../data/network';
import { KX, KY } from '../domain/geo';

/**
 * Edificios del mapa base que son la estación misma (OSM `building=bus_station`, cubiertas de
 * plataformas): en 3D se aplanan con un estado de entidad para que no tapen ni dupliquen la estación
 * propia. Se marcan los edificios cuyo centro cae dentro de una huella (con 3 m de holgura) o que
 * contienen el centro de la huella.
 *
 * Se recorre lo cargado al quedar quieto el mapa, solo en 3D y desde z14,5; cada id se revisa una vez.
 */
type Ring = [number, number][];
interface Fp { box: [number, number, number, number]; rings: Ring[]; c: [number, number] }

const PAD = 3; // m

function inside(p: [number, number], ring: Ring): boolean {
  let ok = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) ok = !ok;
  }
  return ok;
}
function distToRing(p: [number, number], ring: Ring): number {
  let best = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
    const f = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(p[0] - ax - f * dx, p[1] - ay - f * dy));
  }
  return best;
}

export function hideStationBuildings(map: MLMap, net: Network) {
  const fps: Fp[] = [];
  for (const s of net.stations.values()) {
    if (!s.fp?.length) continue;
    const rings = s.fp.map((r) => r.map(([lo, la]) => [lo * KX, la * KY] as [number, number]));
    const all = rings.flat();
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    fps.push({
      box: [Math.min(...xs) - PAD, Math.min(...ys) - PAD, Math.max(...xs) + PAD, Math.max(...ys) + PAD],
      rings,
      c: [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length],
    });
  }
  const done = new Set<string | number>();
  const run = () => {
    if (map.getZoom() < 14.5 || map.getLayoutProperty('building-3d', 'visibility') === 'none') return;
    for (const f of map.querySourceFeatures('omt', { sourceLayer: 'building' })) {
      if (f.id == null || done.has(f.id)) continue;
      done.add(f.id);
      const g = f.geometry;
      const outer = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
      if (!outer || outer.length < 3) continue;
      const ring = outer.map(([lo, la]) => [lo * KX, la * KY] as [number, number]);
      let cx = 0, cy = 0;
      for (const [x, y] of ring) { cx += x; cy += y; }
      const c: [number, number] = [cx / ring.length, cy / ring.length];
      for (const fp of fps) {
        const hitBox = c[0] >= fp.box[0] && c[0] <= fp.box[2] && c[1] >= fp.box[1] && c[1] <= fp.box[3];
        const holds = inside(fp.c, ring);
        if (!hitBox && !holds) continue;
        if (holds || fp.rings.some((r) => inside(c, r) || distToRing(c, r) <= PAD)) {
          map.setFeatureState({ source: 'omt', sourceLayer: 'building', id: f.id }, { station: true });
          break;
        }
      }
    }
  };
  map.on('idle', run);
  return run;
}

import { WALK_MS, DETOUR, type Model, type RoutePattern, type StopInfo } from './raptor';

export interface Sources {
  network: { routes: { id: string }[]; stations: { id: string; lon: number; lat: number; platforms: { id: string; lon: number; lat: number }[] }[] };
  stops: { stops: [string, string, string, number, number, string[]][] };
  patterns: { patterns: Record<string, { stops: string[]; t: (number[] | null)[] }> };
  service: { service: Record<string, Partial<Record<'habil' | 'sabado' | 'festivo', { h: number[] }>>> };
}

export const WALK_RADIUS = 400;

/** Modelo del planificador a partir de los datos compilados, para un tipo de día. */
export function buildModel(src: Sources, day: 'habil' | 'sabado' | 'festivo'): Model {
  const KX = 111_320 * Math.cos((4.65 * Math.PI) / 180), KY = 110_574;
  const where = new Map<string, StopInfo>();
  for (const st of src.network.stations) {
    where.set(st.id, { id: st.id, lon: st.lon, lat: st.lat, station: st.id });
    for (const p of st.platforms) where.set(p.id, { id: p.id, lon: p.lon, lat: p.lat, station: st.id });
  }
  for (const [id, , , lon, lat] of src.stops.stops) where.set(id, { id, lon, lat, station: null });

  const index = new Map<string, number>();
  const stops: StopInfo[] = [];
  const idx = (id: string) => {
    let i = index.get(id);
    if (i === undefined) {
      const w = where.get(id);
      if (!w) return -1;
      i = stops.length;
      index.set(id, i);
      stops.push(w);
    }
    return i;
  };
  const routes: RoutePattern[] = [];
  for (const [rid, p] of Object.entries(src.patterns.patterns)) {
    const perHour = src.service.service[rid]?.[day]?.h;
    if (!perHour || !perHour.some(Boolean)) continue;
    const sIdx = p.stops.map(idx);
    if (sIdx.some((x) => x < 0)) continue;
    routes.push({ id: rid, stops: sIdx, times: p.t, perHour });
  }
  const routesAt: [number, number][][] = stops.map(() => []);
  routes.forEach((r, ri) => r.stops.forEach((s, pos) => routesAt[s].push([ri, pos])));

  // Caminatas entre paradas cercanas: rejilla de celdas del tamaño del radio.
  const cell = (x: number) => Math.floor(x / WALK_RADIUS);
  const grid = new Map<string, number[]>();
  const xy = stops.map((s) => [s.lon * KX, s.lat * KY]);
  xy.forEach(([x, y], i) => {
    const k = `${cell(x)}:${cell(y)}`;
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(i);
  });
  const walks: [number, number][][] = stops.map(() => []);
  xy.forEach(([x, y], i) => {
    const cx = cell(x), cy = cell(y);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
        if (j === i) continue;
        const d = Math.hypot(xy[j][0] - x, xy[j][1] - y);
        if (d > WALK_RADIUS) continue;
        // Entre vagones de la misma estación se camina por dentro: al menos un minuto.
        const same = stops[i].station && stops[i].station === stops[j].station;
        walks[i].push([j, Math.round(Math.max(same ? 60 : 30, (d * DETOUR) / WALK_MS))]);
      }
    }
  });
  return { stops, routes, routesAt, walks };
}

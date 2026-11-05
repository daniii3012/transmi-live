/// <reference lib="webworker" />
import { buildModel, type Sources } from './model';
import { alternatives, accessFrom, type Access, type Journey, type Model } from './raptor';

/** Planificador en su propio hilo: carga los datos, arma el modelo por tipo de día y responde. */
let sources: Promise<Sources> | null = null;
const models = new Map<string, Model>();

async function load(base: string): Promise<Sources> {
  const get = (f: string) => fetch(`${base}data/${f}`).then((r) => r.json());
  const [network, stops, patterns, service] = await Promise.all([get('network.json'), get('stops.json'), get('patterns.json'), get('service.json')]);
  return { network, stops, patterns, service };
}

export type Place = { kind: 'point'; lon: number; lat: number } | { kind: 'stop'; ids: string[]; lon: number; lat: number };
export interface Query { id: number; base: string; from: Place; to: Place; depart: number; day: 'habil' | 'sabado' | 'festivo' }
export interface Answer { id: number; journeys: (Journey & { stopIds: Record<number, string>; routeIds: Record<number, string> })[]; ms: number; error?: string }

function access(m: Model, p: Place): Access[] {
  if (p.kind === 'point') return accessFrom(m, p.lon, p.lat, 700);
  const set = new Set(p.ids);
  const own: Access[] = [];
  m.stops.forEach((s, i) => { if (set.has(s.id) || (s.station && set.has(s.station))) own.push({ stop: i, seconds: 0 }); });
  // Además, lo que está a un par de cuadras (otro paradero de la misma esquina).
  const near = accessFrom(m, p.lon, p.lat, 250).filter((a) => !own.some((o) => o.stop === a.stop));
  return [...own, ...near];
}

self.onmessage = async (e: MessageEvent<Query>) => {
  const q = e.data;
  const t0 = performance.now();
  try {
    sources ??= load(q.base);
    const src = await sources;
    let m = models.get(q.day);
    if (!m) { m = buildModel(src, q.day); models.set(q.day, m); }
    const js = alternatives(m, access(m, q.from), access(m, q.to), q.depart, 4);
    const journeys = js.map((j) => {
      const stopIds: Record<number, string> = {}, routeIds: Record<number, string> = {};
      for (const l of j.legs) {
        if (l.kind === 'ride') { stopIds[l.from] = m!.stops[l.from].id; stopIds[l.to] = m!.stops[l.to].id; routeIds[l.route] = m!.routes[l.route].id; }
        else { if (l.from !== null) stopIds[l.from] = m!.stops[l.from].id; if (l.to !== null) stopIds[l.to] = m!.stops[l.to].id; }
      }
      return { ...j, stopIds, routeIds };
    });
    (self as unknown as Worker).postMessage({ id: q.id, journeys, ms: Math.round(performance.now() - t0) } satisfies Answer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: q.id, journeys: [], ms: 0, error: String(err) } satisfies Answer);
  }
};

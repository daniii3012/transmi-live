import { MetricPath, decodeShape } from '../domain/geo';
import type { Route, Station, StreetStop, SystemInfo, Pattern, RouteService, SystemKey } from '../domain/types';
import { undeltaPatterns } from '../domain/patterns';

const BASE = `${import.meta.env.BASE_URL}data/`;

async function getJSON<T>(name: string): Promise<T> {
  const res = await fetch(BASE + name, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.json() as Promise<T>;
}

interface NetworkFile { v: number; hash: string; systems: SystemInfo[]; routes: Route[]; stations: Station[] }
interface ShapesFile { v: number; hash: string; scale: number; shapes: Record<string, number[]> }
interface StopsFile { cols: string[]; stops: [string, string, string, number, number, string[]][] }
interface PatternsFile { v?: number; bands: string[]; patterns: Record<string, Pattern> }
interface ServiceFile { service: Record<string, RouteService> }
export interface Meta { hash: string; built: string; bands: { from: number; to: number; key: string }[]; counts: Record<string, unknown> }

/**
 * La red estática: rutas, estaciones, paraderos, recorridos y patrones. Lo esencial se carga al
 * abrir (`load`); recorridos zonales, paraderos, patrones y salidas, cuando se necesitan.
 */
export class Network {
  readonly routes = new Map<string, Route>();
  readonly stations = new Map<string, Station>();
  /** Vagón o estación → estación. */
  readonly stationOf = new Map<string, Station>();
  readonly paths = new Map<string, MetricPath>();
  readonly streetStops = new Map<string, StreetStop>();
  systems: SystemInfo[] = [];
  meta!: Meta;
  hash = '';
  bands: string[] = [];
  /** Tramos de corredor troncal con su letra (o null si no se pudo deducir). */
  corridors: { z: string | null; street?: boolean; c: [number, number][] }[] = [];
  private patterns?: Record<string, Pattern>;
  private service?: Record<string, RouteService>;
  private pending = new Map<string, Promise<unknown>>();

  static async load(): Promise<Network> {
    const n = new Network();
    const [meta, net, core, corr] = await Promise.all([
      getJSON<Meta>('meta.json'),
      getJSON<NetworkFile>('network.json'),
      getJSON<ShapesFile>('shapes-core.json'),
      getJSON<{ segments: { z: string | null; street?: boolean; c: [number, number][] }[] }>('corridors.json'),
    ]);
    n.corridors = corr.segments;
    n.meta = meta;
    n.hash = net.hash;
    n.systems = net.systems;
    for (const r of net.routes) n.routes.set(r.id, r);
    for (const s of net.stations) {
      n.stations.set(s.id, s);
      n.stationOf.set(s.id, s);
      for (const p of s.platforms) n.stationOf.set(p.id, s);
    }
    n.addShapes(core);
    return n;
  }

  private addShapes(f: ShapesFile) {
    for (const [id, enc] of Object.entries(f.shapes)) this.paths.set(id, new MetricPath(decodeShape(enc, f.scale)));
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.pending.get(key) as Promise<T> | undefined;
    if (!p) { p = fn(); this.pending.set(key, p); }
    return p;
  }

  loadZonalShapes(): Promise<void> {
    return this.once('zonal', async () => this.addShapes(await getJSON<ShapesFile>('shapes-zonal.json')));
  }

  loadStreetStops(): Promise<void> {
    return this.once('stops', async () => {
      const f = await getJSON<StopsFile>('stops.json');
      for (const [id, code, name, lon, lat, routes] of f.stops) this.streetStops.set(id, { id, code, name, lon, lat, routes });
    });
  }

  loadPatterns(): Promise<Record<string, Pattern>> {
    return this.once('patterns', async () => {
      const f = await getJSON<PatternsFile>('patterns.json');
      undeltaPatterns(f);
      this.bands = f.bands;
      this.patterns = f.patterns;
      return f.patterns;
    });
  }

  loadService(): Promise<Record<string, RouteService>> {
    return this.once('service', async () => (this.service = (await getJSON<ServiceFile>('service.json')).service));
  }

  pattern(id: string): Pattern | undefined { return this.patterns?.[id]; }
  serviceOf(id: string): RouteService | undefined { return this.service?.[id]; }

  routesOf(sys: SystemKey): Route[] { return [...this.routes.values()].filter((r) => r.sys === sys); }

  /** Nombre del lugar de una parada (estación o paradero). */
  placeName(stopId: string): string {
    const st = this.stationOf.get(stopId);
    if (st) return st.short;
    return this.streetStops.get(stopId)?.name ?? stopId;
  }
}

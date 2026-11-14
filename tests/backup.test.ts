import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveReading, sameDest, type NetLike } from '../src/live/backupResolve';
import { Fleet } from '../src/live/fleet';
import { backup } from '../src/live/backup.svelte';
import { MetricPath, KX, KY } from '../src/domain/geo';
import { LAT0, LON0, Q, type VehiclesV1 } from '../src/live/api';
import type { Network } from '../src/data/network';
import type { Route } from '../src/domain/types';

// Ruta Fácil 5 sobre un mismo corredor recto este–oeste: hacia Av. Jiménez (este) y hacia Portal
// Américas (oeste), dos variantes con el mismo código.
const lon0 = -74.15, lat0 = 4.62;
const east = new MetricPath(new Float64Array([lon0, lat0, lon0 + 5000 / KX, lat0]));
const west = new MetricPath(new Float64Array([lon0 + 5000 / KX, lat0 + 8 / KY, lon0, lat0 + 8 / KY])); // la calzada del otro sentido, 8 m al norte
const route = (id: string, code: string, dest: string, sys = 'zonal'): Route => ({ id, code, dest, sys } as unknown as Route);
const routes = new Map<string, Route>([
  ['R5E', route('R5E', '5', 'Av. Jiménez')],
  ['R5W', route('R5W', '5', 'Portal Américas')],
  ['T', route('T', 'F51', 'Portal Américas', 'troncal')],
]);
const paths = new Map([['R5E', east], ['R5W', west], ['T', east]]);
const net: NetLike = { routes, paths, resolveRoute: (id) => (routes.has(id) ? id : null) };
const at = (m: number, north = 0) => ({ x: (lon0 + m / KX) * KX, y: (lat0 + north / KY) * KY });

describe('respaldo: sentido de la lectura', () => {
  it('destinos equivalentes con o sin tildes y abreviaturas', () => {
    expect(sameDest('PORTAL AMERICAS', 'Portal Américas')).toBe(true);
    expect(sameDest('AV JIMENEZ', 'Av. Jiménez')).toBe(true);
    expect(sameDest('Portal Américas', 'Av. Jiménez')).toBe(false);
  });

  it('Ruta Fácil 5: el destino separa los sentidos sobre el mismo corredor', () => {
    expect(resolveReading(net, { routeId: '', code: '5', dest: 'PORTAL AMERICAS', sys: 'zonal', ...at(1000, 4), bearing: -1 })).toBe('R5W');
    expect(resolveReading(net, { routeId: '', code: '5', dest: 'AV JIMENEZ', sys: 'zonal', ...at(1000, 4), bearing: -1 })).toBe('R5E');
  });

  it('sin destino, el rumbo del bus decide', () => {
    expect(resolveReading(net, { routeId: '', code: '5', dest: '', sys: 'zonal', ...at(2000, 4), bearing: 90 })).toBe('R5E'); // hacia el este
    expect(resolveReading(net, { routeId: '', code: '5', dest: '', sys: 'zonal', ...at(2000, 4), bearing: 270 })).toBe('R5W'); // hacia el oeste
  });

  it('un route_id del servicio en el sentido equivocado no gana al destino y al rumbo', () => {
    expect(resolveReading(net, { routeId: 'R5E', code: '5', dest: 'Portal Americas', sys: 'zonal', ...at(3000, 4), bearing: 270 })).toBe('R5W');
  });

  it('una ruta en par se encuentra por el código de su tramo (A153 → CA153)', () => {
    const pair = route('RP', 'CA153', 'Centro');
    (pair as { codes?: string[] }).codes = ['A153', 'C153'];
    const n2: NetLike = { routes: new Map([['RP', pair]]), paths: new Map([['RP', east]]), resolveRoute: (id) => (id === 'RP' ? id : null) };
    expect(resolveReading(n2, { routeId: '', code: 'C153', dest: 'Centro', sys: 'zonal', ...at(800), bearing: 90 })).toBe('RP');
    expect(resolveReading(n2, { routeId: '', code: 'D153', dest: 'Centro', sys: 'zonal', ...at(800), bearing: 90 })).toBeNull();
  });

  it('no cruza sistemas ni inventa: lejos del recorrido, nada', () => {
    expect(resolveReading(net, { routeId: '', code: 'F51', dest: 'Portal Americas', sys: 'zonal', ...at(1000), bearing: -1 })).toBeNull();
    expect(resolveReading(net, { routeId: '', code: '5', dest: 'AV JIMENEZ', sys: 'zonal', ...at(1000, 300), bearing: -1 })).toBeNull();
  });
});

describe('respaldo: reemplaza los buses del GTFS de la ruta consultada', () => {
  const fnet = { routes, paths } as unknown as Network;
  const snap = (t: number, rows: [string, string, number][]): VehiclesV1 => ({
    v: 1, t, n: rows.length, id: rows.map((r) => r[0]), label: rows.map((r) => r[0]), plate: rows.map(() => ''), route: rows.map((r) => r[1]),
    lat: rows.map(() => Math.round((lat0 + 4 / KY - LAT0) * Q)), lon: rows.map((r) => Math.round((lon0 + r[2] / KX - LON0) * Q)),
    age: rows.map(() => 0), stop: rows.map(() => ''), seq: rows.map(() => 0), start: rows.map(() => 0),
  });

  it('el respaldo del 5 quita los buses viejos del 5 y deja los demás; la instantánea repetida no los devuelve', () => {
    const f = new Fleet(fnet);
    const T0 = 1_000_000;
    const gtfs = snap(T0, [['G1', 'R5E', 500], ['G2', 'R5W', 900], ['F1', 'T', 1500]]);
    f.ingest(gtfs, T0 * 1000 + 15_000);
    // El alimentador se detuvo; el respaldo del 5 trae un solo bus (otro).
    f.merge(snap(T0 + 600, [['ruta:X1', 'R5E', 2500]]), T0 * 1000 + 620_000, ['5']);
    expect([...f.buses.keys()].sort()).toEqual(['F1', 'ruta:X1']);
    // El alimentador detenido entrega otra vez la misma instantánea: no reaparecen G1 ni G2.
    f.ingest(gtfs, T0 * 1000 + 640_000);
    expect([...f.buses.keys()].sort()).toEqual(['F1', 'ruta:X1']);
    // Vuelve el alimentador (instantánea nueva): manda el GTFS otra vez. El bus que solo trajo el
    // respaldo no sale de golpe: dura 3 min desde su última lectura (el alimentador puede no traerlo).
    f.ingest(snap(T0 + 700, [['G1', 'R5E', 3000], ['F1', 'T', 1600]]), T0 * 1000 + 715_000);
    expect([...f.buses.keys()].sort()).toEqual(['F1', 'G1', 'ruta:X1']);
    f.ingest(snap(T0 + 900, [['G1', 'R5E', 3400], ['F1', 'T', 1900]]), T0 * 1000 + 915_000);
    expect([...f.buses.keys()].sort()).toEqual(['F1', 'G1']);
  });
});

describe('respaldo: qué rutas se consultan', () => {
  const fnet = { routes, paths } as unknown as Network;
  const one = (t: number, id: string, rid: string): VehiclesV1 => ({
    v: 1, t, n: 1, id: [id], label: [id], plate: [''], route: [rid],
    lat: [Math.round((lat0 - LAT0) * Q)], lon: [Math.round((lon0 + 800 / KX - LON0) * Q)], age: [0], stop: [''], seq: [0], start: [0],
  });

  it('alimentador detenido: las rutas abiertas; en marcha: solo las que no trae (trae parte de la flota)', () => {
    const f = new Fleet(fnet);
    const T0 = 1_000_000;
    f.ingest(one(T0, 'F1', 'T'), T0 * 1000 + 40_000); // el alimentador trae un F51 y ningún 5
    expect(backup.wanted(f, ['F51', '5'], true, 0)).toEqual(['F51', '5']);
    expect(backup.wanted(f, ['F51', '5', '5'], false, 0)).toEqual(['5']);
    expect(f.reporting('f51')).toBe(1);
    // El respaldo trae un bus del 5: no cuenta como «el alimentador lo trae» (se sigue consultando).
    f.merge(one(T0 + 30, 'ruta:X1', 'R5E'), T0 * 1000 + 60_000);
    expect(backup.wanted(f, ['5'], false, 0)).toEqual(['5']);
    // El alimentador omite el F51 en una vuelta: se conserva en el mapa, pero ya no «lo trae».
    f.ingest({ ...one(T0 + 50, 'F1', 'T'), n: 0, id: [], label: [], plate: [], route: [], lat: [], lon: [], age: [], stop: [], seq: [], start: [] }, T0 * 1000 + 90_000);
    expect(f.buses.has('F1')).toBe(true);
    expect(backup.wanted(f, ['F51'], false, 0)).toEqual(['F51']);
  });
});

describe('respaldo: fuente «por ruta» elegida en la ficha de la ruta', () => {
  const tnet = { routes, paths, resolveRoute: (id: string) => (routes.has(id) ? id : null) } as unknown as Network;
  const creds = { appid: 'abcd1234', uuid: 'UUID-0001' };
  const target = { code: '5', dest: 'Av. Jiménez', zonal: true, ciclovia: false };
  const gtfs = (t: number, id: string, m: number): VehiclesV1 => ({
    v: 1, t, n: 1, id: [id], label: [id], plate: [''], route: ['R5E'],
    lat: [Math.round((lat0 + 4 / KY - LAT0) * Q)], lon: [Math.round((lon0 + m / KX - LON0) * Q)], age: [0], stop: [''], seq: [0], start: [0],
  });
  // Respuesta del Worker: un bus del 5 hacia Av. Jiménez (otro que el del alimentador).
  const fromRoute = (t: number) => ({
    v: 1, code: '5', t, n: 1, id: ['fleet:X1'], label: ['X1'], route: [''], rcode: ['5'], dest: ['AV JIMENEZ'], sys: ['zonal'],
    lat: [Math.round((lat0 + 4 / KY - LAT0) * Q)], lon: [Math.round((lon0 + 2500 / KX - LON0) * Q)], bearing: [90], age: [5], occ: [''],
  });
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) });
    vi.stubGlobal('location', { search: '?api=http://api', hostname: 'localhost' });
  });
  afterEach(() => {
    backup.setSource('gtfs');
    backup.clear();
    vi.unstubAllGlobals();
  });

  it('sin UUID no hay respaldo; lo guardado se conserva para completarlo', () => {
    backup.save({ appid: 'abcd1234', uuid: '' });
    expect(backup.creds).toBeNull();
    expect(backup.status).toBe('off');
    expect(backup.stored?.appid).toBe('abcd1234');
    backup.save(creds);
    expect(backup.creds).toEqual(creds);
    expect(backup.status).toBe('ready');
  });

  it('consulta aunque el alimentador traiga la ruta, con su destino; sus buses salen solo del servicio y con GTFS vuelven', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(fromRoute(Math.floor(Date.now() / 1000))), { status: 200 }); });
    backup.save(creds);
    const f = new Fleet(tnet);
    const T0 = Math.floor(Date.now() / 1000);
    f.ingest(gtfs(T0, 'G1', 500), T0 * 1000 + 5_000); // el alimentador, al día, trae un 5
    // Con GTFS y el alimentador trayendo la ruta: no se consulta.
    backup.tick(tnet, f, T0, [target], true, T0 * 1000 + 6_000);
    await Promise.resolve();
    expect(bodies).toHaveLength(0);
    // «Por ruta»: se consulta enseguida, con el destino, el sistema y la marca de ciclovía.
    backup.setSource('ruta');
    backup.tick(tnet, f, T0, [target], true, T0 * 1000 + 7_000);
    await vi.waitFor(() => expect(backup.owned).toEqual(['5']));
    expect(bodies[0]).toEqual({ ruta: '5', destino: 'Av. Jiménez', zonal: true, ciclovia: false, ...creds });
    expect(backup.forced).toBe(true);
    expect([...f.buses.keys()]).toEqual(['ruta:X1']); // el del alimentador sale
    // La siguiente instantánea del alimentador no lo devuelve mientras la ruta sea «por ruta».
    f.ingest(gtfs(T0 + 30, 'G1', 700), T0 * 1000 + 35_000);
    expect(f.buses.has('G1')).toBe(false);
    // De vuelta a GTFS: con la siguiente instantánea vuelve.
    backup.setSource('gtfs');
    expect(backup.owned).toEqual([]);
    f.ingest(gtfs(T0 + 60, 'G1', 900), T0 * 1000 + 65_000);
    expect(f.buses.has('G1')).toBe(true);
  });

  it('al dejar de mirar la ruta, vuelve al alimentador aunque la fuente siga en «por ruta»', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(fromRoute(Math.floor(Date.now() / 1000))), { status: 200 }));
    backup.save(creds);
    backup.setSource('ruta');
    const f = new Fleet(tnet);
    const now = Date.now();
    backup.tick(tnet, f, now / 1000, [target], true, now);
    await vi.waitFor(() => expect(backup.owned).toEqual(['5']));
    backup.tick(tnet, f, now / 1000, [], false, now + 1_000); // la página ya no mira la ruta
    expect(backup.owned).toEqual([]);
    expect(backup.forced).toBe(false);
  });

  it('si el servicio rechaza todas las consultas (503 con retry-after), vuelve al GTFS y espera lo que diga el Worker', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls++; return new Response('{"error":"el servicio por ruta rechaza las consultas"}', { status: 503, headers: { 'retry-after': '300' } }); });
    backup.save(creds);
    backup.setSource('ruta');
    const f = new Fleet(tnet);
    const now = Date.now();
    backup.tick(tnet, f, now / 1000, [target], true, now);
    await vi.waitFor(() => expect(backup.status).toBe('unavailable'));
    expect(backup.owned).toEqual([]);
    backup.tick(tnet, f, now / 1000, [target], true, now + 60_000);
    await Promise.resolve();
    expect(calls).toBe(1); // en pausa: 5 min
    backup.tick(tnet, f, now / 1000, [target], true, now + 301_000);
    await vi.waitFor(() => expect(calls).toBe(2));
  });
});

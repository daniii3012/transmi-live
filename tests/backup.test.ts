import { describe, it, expect } from 'vitest';
import { resolveReading, sameDest, type NetLike } from '../src/live/backupResolve';
import { Fleet } from '../src/live/fleet';
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
    // Vuelve el alimentador (instantánea nueva): manda el GTFS otra vez.
    f.ingest(snap(T0 + 700, [['G1', 'R5E', 3000], ['F1', 'T', 1600]]), T0 * 1000 + 715_000);
    expect([...f.buses.keys()].sort()).toEqual(['F1', 'G1']);
  });
});

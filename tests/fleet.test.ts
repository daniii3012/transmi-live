import { describe, it, expect } from 'vitest';
import { Fleet, HOLD_BACK } from '../src/live/fleet';
import { MetricPath, KX, KY } from '../src/domain/geo';
import { LAT0, LON0, Q, type VehiclesV1 } from '../src/live/api';
import type { Network } from '../src/data/network';

const lon0 = -74.1, lat0 = 4.65;
const path = new MetricPath(new Float64Array([lon0, lat0, lon0 + 5000 / KX, lat0]));
const net = {
  routes: new Map([['R', { id: 'R', code: 'B10', dest: 'Portal Norte', color: '#7cc242', sys: 'troncal', len: 5000 }]]),
  paths: new Map([['R', path]]),
} as unknown as Network;

/** Instantánea con un bus a `m` metros del inicio y `off` metros al norte del recorrido. */
function snap(t: number, m: number, off = 0, route = 'R'): VehiclesV1 {
  const lon = lon0 + m / KX, lat = lat0 + off / KY;
  return {
    v: 1, t, n: 1, id: ['1'], label: ['A1'], plate: ['X'], route: [route],
    lat: [Math.round((lat - LAT0) * Q)], lon: [Math.round((lon - LON0) * Q)], age: [0], stop: ['s'], seq: [1], start: [300],
  };
}

describe('flota', () => {
  it('ubica la lectura sobre el recorrido y avanza sin extrapolar', () => {
    const f = new Fleet(net);
    f.ingest(snap(1000, 1000), 0);
    const b = f.buses.get('1')!;
    expect(b.onPath).toBe(true);
    expect(b.sFix).toBeCloseTo(1000, -1);
    f.ingest(snap(1020, 1200), 20_000);
    f.update(20_000 + f.interval / 2);
    expect(b.s).toBeGreaterThan(1050);
    expect(b.s).toBeLessThan(1200);
    f.update(20_000 + f.interval * 3);
    expect(b.s).toBeCloseTo(b.s1, 6); // se detiene en la lectura
    expect(b.speed).toBeCloseTo(10, 0); // 200 m en 20 s
  });

  it(`un retroceso de menos de ${HOLD_BACK} m es ruido: el bus no retrocede`, () => {
    const f = new Fleet(net);
    f.ingest(snap(1000, 2000), 0);
    f.update(1);
    f.ingest(snap(1020, 1985), 20_000);
    const b = f.buses.get('1')!;
    f.update(40_000);
    expect(b.s).toBeGreaterThanOrEqual(1995);
  });

  it('a más de 60 m del recorrido se dibuja en su punto', () => {
    const f = new Fleet(net);
    f.ingest(snap(1000, 1000, 150), 0);
    expect(f.buses.get('1')!.onPath).toBe(false);
  });

  it('un bus que deja de aparecer en el alimentador sale de la flota', () => {
    const f = new Fleet(net);
    f.ingest(snap(1000, 1000), 0);
    f.ingest({ ...snap(1020, 0), n: 0, id: [], label: [], plate: [], route: [], lat: [], lon: [], age: [], stop: [], seq: [], start: [] }, 20_000);
    expect(f.buses.size).toBe(0);
  });

  it('el buffer de la capa pone al seleccionado al final y marca los atenuados', () => {
    const f = new Fleet(net);
    const d = snap(1000, 1000);
    f.ingest({ ...d, n: 2, id: ['1', '2'], label: ['A', 'B'], plate: ['X', 'Y'], route: ['R', 'Z'], lat: [...d.lat, ...d.lat], lon: [...d.lon, ...d.lon], age: [0, 0], stop: ['s', 's'], seq: [1, 1], start: [0, 0] }, 0);
    f.selectedId = '1';
    f.focusRoute = 'R';
    f.update(10);
    const { data, count } = f.fill(10);
    expect(count).toBe(2);
    expect(data[Fleet.STRIDE * 0 + 9]).toBe(1); // el de otra ruta, atenuado y primero
    expect(data[Fleet.STRIDE * 1 + 9] & 4).toBe(4); // el seleccionado, al final
  });
});

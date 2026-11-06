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
  it('ubica la lectura sobre el recorrido y la reproduce entre lecturas, con retraso', () => {
    const f = new Fleet(net);
    f.ingest(snap(1000, 1000), 1_020_000); // llega 20 s después de la lectura
    const b = f.buses.get('1')!;
    expect(b.onPath).toBe(true);
    expect(b.sFix).toBeCloseTo(1000, -1);
    expect(f.lag).toBeCloseTo(41_000, -2); // intervalo supuesto (20 s) + lo que tardó en llegar + 1 s
    f.ingest(snap(1020, 1200), 1_040_000);
    expect(b.speed).toBeCloseTo(10, 0); // 200 m en 20 s
    for (let now = 1_040_000; now <= 1_100_000; now += 100) f.update(now);
    expect(b.s).toBeGreaterThan(1200); // pasó la última lectura por inercia…
    expect(b.s).toBeLessThan(1200 + 10 * 5 + 1); // …y se detuvo suave, a lo sumo 5 s de su velocidad
  });

  it('se mueve sin paradas ni tirones aunque las lecturas lleguen a destiempo (cada 21 s, consulta cada 15 s)', () => {
    const f = new Fleet(net);
    const v = 10; // m/s
    let ingested = -1;
    let prev = NaN, prevAt = 0;
    const speeds: number[] = [];
    for (let now = 0; now <= 400_000; now += 100) {
      // Una consulta cada 15 s: la instantánea más reciente disponible (cada 21 s, 7 s después de generarse).
      if (now % 15_000 === 0) {
        const k = Math.floor((now - 7_000) / 21_000);
        if (k >= 0 && k !== ingested) { ingested = k; f.ingest(snap(1_000_000 + 21 * k, 100 + v * 21 * k), 1_000_000_000 + now); }
      }
      f.update(1_000_000_000 + now);
      const b = f.buses.get('1');
      if (b && now >= 200_000) {
        if (!Number.isNaN(prev)) speeds.push(((b.s - prev) / (now - prevAt)) * 1000);
        prev = b.s; prevAt = now;
      }
    }
    expect(Math.min(...speeds)).toBeGreaterThan(0.75 * v);
    expect(Math.max(...speeds)).toBeLessThan(1.3 * v);
  });

  it('tras una pausa del alimentador sigue desde donde se ve, sin saltar', () => {
    const f = new Fleet(net);
    // Lecturas cada 21 s a 10 m/s; una pausa de 54 s; cada una llega 15 s después de generarse.
    const feed: [number, number][] = [[0, 100], [21, 310], [42, 520], [96, 1060], [117, 1270], [138, 1480]];
    const T0 = 1_000_000;
    let prev = 0;
    let maxStep = 0;
    for (let now = 0; now <= 260_000; now += 100) {
      for (const [t, s] of feed) if (now === t * 1000 + 15_000) f.ingest(snap(T0 + t, s), T0 * 1000 + now);
      f.update(T0 * 1000 + now);
      const b = f.buses.get('1');
      if (!b) continue;
      if (prev) maxStep = Math.max(maxStep, b.s - prev);
      expect(b.s).toBeGreaterThanOrEqual(prev); // nunca hacia atrás
      prev = b.s;
    }
    expect(maxStep).toBeLessThan(2); // < 20 m/s en ningún cuadro (va a 10 m/s; recupera a ~1,2×): sin saltos
    expect(prev).toBeGreaterThan(1450); // y alcanzó la última lectura
  });

  it(`un retroceso de menos de ${HOLD_BACK} m es ruido: el bus no retrocede`, () => {
    const f = new Fleet(net);
    f.ingest(snap(1000, 2000), 1_020_000);
    f.update(1_020_001);
    f.ingest(snap(1020, 1985), 1_040_000);
    const b = f.buses.get('1')!;
    for (let now = 1_040_000; now <= 1_080_000; now += 100) f.update(now);
    expect(b.s).toBeGreaterThanOrEqual(1995);
  });

  it('una lectura imposible aislada se descarta; si la siguiente la confirma, el bus se reubica', () => {
    const f = new Fleet(net);
    const T0 = 1_000_000;
    f.ingest(snap(T0, 1000), T0 * 1000 + 15_000);
    f.ingest(snap(T0 + 21, 1210), T0 * 1000 + 36_000);
    f.ingest(snap(T0 + 42, 2400), T0 * 1000 + 57_000); // 1,2 km en 21 s: error del GPS
    const b = f.buses.get('1')!;
    expect(b.ts[b.ts.length - 1]).toBeCloseTo(1210, -1);
    f.ingest(snap(T0 + 63, 1630), T0 * 1000 + 78_000); // vuelve a lo esperado: descartada
    expect(b.ts[b.ts.length - 1]).toBeCloseTo(1630, -1);
    expect(b.ts.some((s) => s > 2000)).toBe(false);
    f.ingest(snap(T0 + 84, 4000), T0 * 1000 + 99_000);
    f.ingest(snap(T0 + 105, 4150), T0 * 1000 + 120_000); // confirmada: se reubica
    expect(b.tt.length).toBe(1);
    expect(b.sFix).toBeCloseTo(4150, -1);
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

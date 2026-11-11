import { describe, it, expect } from 'vitest';
import { Fleet } from '../src/live/fleet';
import { MetricPath, KX, KY } from '../src/domain/geo';
import { LAT0, LON0, Q, type VehiclesV1 } from '../src/live/api';
import type { Network } from '../src/data/network';
import { TrailBuilder, TRAIL_STRIDE, SELECTED_MAX } from '../src/map/trails';

const lon0 = -74.1, lat0 = 4.65;
// Recorrido en L: 2 km al este y 2 km al norte (la estela tiene que doblar la esquina).
const path = new MetricPath(new Float64Array([lon0, lat0, lon0 + 2000 / KX, lat0, lon0 + 2000 / KX, lat0 + 2000 / KY]));
const net = {
  routes: new Map([['R', { id: 'R', code: 'B10', dest: 'Portal Norte', color: '#7cc242', sys: 'troncal', len: 4000 }]]),
  paths: new Map([['R', path]]),
} as unknown as Network;

function snap(t: number, m: number): VehiclesV1 {
  // `m` metros por el recorrido en L.
  const lon = lon0 + Math.min(m, 2000) / KX, lat = lat0 + Math.max(0, m - 2000) / KY;
  return { v: 1, t, n: 1, id: ['1'], label: ['A1'], plate: ['X'], route: ['R'], lat: [Math.round((lat - LAT0) * Q)], lon: [Math.round((lon - LON0) * Q)], age: [0], stop: ['s'], seq: [1], start: [300] };
}

/** Un bus a 10 m/s, con lecturas cada 20 s; `until` detiene la reproducción cuando se cumple. */
function moving(until?: (s: number) => boolean) {
  const f = new Fleet(net);
  let now = 1_000_000_000;
  for (let k = 0; k <= 14; k++) {
    f.ingest(snap(1_000_000 + 20 * k, 200 + 200 * k), now);
    for (let i = 0; i < 200; i++) {
      now += 100;
      f.update(now);
      const b = f.buses.get('1')!;
      if (until && k > 3 && until(b.s)) return { f, b, now };
    }
  }
  return { f, b: f.buses.get('1')!, now };
}

describe('estelas sobre el recorrido (R10.5, R10.6)', () => {
  it('dónde iba el bus hace un rato: atrás, nunca adelante, y a su velocidad', () => {
    const { f, b, now } = moving();
    const s25 = f.sAgo(b, now, 25_000);
    expect(s25).toBeLessThan(b.s);
    expect(b.s - s25).toBeGreaterThan(200); // ~250 m a 10 m/s
    expect(b.s - s25).toBeLessThan(300);
    expect(f.sAgo(b, now, 0)).toBeLessThanOrEqual(b.s);
    f.setMotion('directo', now);
    expect(f.sAgo(b, now, 25_000)).toBeLessThanOrEqual(b.s);
  });

  it('la estela del seleccionado sigue el recorrido (dobla la esquina) y mide a lo sumo 150 m', () => {
    // Justo pasada la esquina (la estela llega al tramo que iba hacia el este).
    const { f, b, now } = moving((s) => s > 2040 && s < 2120);
    expect(b.s).toBeGreaterThan(2040);
    f.selectedId = b.id;
    const t = new TrailBuilder().build(f, now, { mpp: 0.5, exposure: false });
    expect(t.count).toBeGreaterThan(4);
    // Cabeza al norte de la esquina; la cola, al oeste de ella (sobre el tramo este-oeste), no en
    // diagonal: algún vértice queda en la esquina misma.
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < t.count; i++) { xs.push(t.data[i * TRAIL_STRIDE]); ys.push(t.data[i * TRAIL_STRIDE + 1]); }
    const west = Math.min(...xs), east = Math.max(...xs);
    expect(east - west).toBeGreaterThan(0);
    // Largo: de la cabeza a la cola por el recorrido, a lo sumo 150 m (más el ancho).
    const span = (Math.max(...ys) - Math.min(...ys)) + (east - west);
    const mercPerM = 1 / (360 * KX);
    expect(span / mercPerM).toBeLessThan(SELECTED_MAX + 20);
  });

  it('larga exposición: solo con la capa y solo de los sistemas visibles', () => {
    const { f, now } = moving();
    expect(new TrailBuilder().build(f, now, { mpp: 5, exposure: false }).count).toBe(0);
    expect(new TrailBuilder().build(f, now, { mpp: 5, exposure: true }).count).toBeGreaterThan(0);
    f.hidden = new Set(['troncal']);
    expect(new TrailBuilder().build(f, now + 200, { mpp: 5, exposure: true }).count).toBe(0);
  });
});

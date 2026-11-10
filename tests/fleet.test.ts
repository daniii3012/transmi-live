import { describe, it, expect } from 'vitest';
import { Fleet, GLIDE, HOLD_BACK, KEEP_S, BACKUP_KEEP, windowSpeed } from '../src/live/fleet';
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

  it('el respaldo por ruta incorpora lecturas sin quitar los demás buses ni mover el retraso', () => {
    const f = new Fleet(net);
    const T0 = 1_000_000;
    const d = snap(T0, 1000);
    f.ingest({ ...d, n: 2, id: ['1', '2'], label: ['A1', 'B2'], plate: ['X', 'Y'], route: ['R', 'R'], lat: [...d.lat, ...d.lat], lon: [d.lon[0], d.lon[0] + 300], age: [0, 0], stop: ['s', 's'], seq: [1, 1], start: [0, 0] }, T0 * 1000 + 15_000);
    const lag = f.lag;
    // El alimentador se quedó quieto; el respaldo trae solo el bus 1, 3 min después.
    f.merge(snap(T0 + 180, 2800), T0 * 1000 + 200_000);
    expect(f.buses.size).toBe(2); // el bus 2 sigue
    expect(f.buses.get('1')!.sFix).toBeCloseTo(2800, -1); // el 1 avanzó con la lectura del respaldo
    expect(f.lag).toBe(lag); // el ritmo del alimentador no cambia
  });

  it('velocidad: ventana de hasta 3 min, al menos 20 s, y nada por encima de 90 km/h', () => {
    expect(windowSpeed([{ at: 0, s: 0 }, { at: 21_000, s: 210 }, { at: 42_000, s: 420 }])).toBeCloseTo(10, 6);
    expect(windowSpeed([{ at: 0, s: 0 }, { at: 15_000, s: 150 }])).toBeNull(); // poca ventana
    expect(windowSpeed([{ at: 0, s: 0 }, { at: 21_000, s: 500 }])! * 3.6).toBeCloseTo(85.7, 0); // rara pero posible: se muestra
    expect(windowSpeed([{ at: 0, s: 0 }, { at: 21_000, s: 600 }])).toBeNull(); // 103 km/h: error del cálculo
    // Lo de hace más de 3 min no cuenta: la ventana empieza en la lectura más vieja dentro de ella.
    expect(windowSpeed([{ at: 0, s: 0 }, { at: 200_000, s: 100 }, { at: 260_000, s: 700 }])).toBeCloseTo(10, 6);
  });

  it('velocidad: una lectura imposible no la contamina; un error del GPS en pocos segundos se diluye', () => {
    const f = new Fleet(net);
    const T0 = 1_000_000;
    f.ingest(snap(T0, 1000), T0 * 1000 + 15_000);
    f.ingest(snap(T0 + 21, 1210), T0 * 1000 + 36_000);
    f.ingest(snap(T0 + 42, 1420), T0 * 1000 + 57_000);
    const b = f.buses.get('1')!;
    expect(b.speed! * 3.6).toBeCloseTo(36, 0);
    f.ingest(snap(T0 + 63, 2900), T0 * 1000 + 78_000); // 1,5 km en 21 s: en espera, no cuenta
    expect(b.speed! * 3.6).toBeCloseTo(36, 0);
    // 6 s después, 60 m de más por error de posición: antes daba ~54 km/h; con la ventana, < 50.
    f.ingest(snap(T0 + 69, 1540), T0 * 1000 + 84_000);
    expect(b.speed! * 3.6).toBeLessThan(50);
  });

  it('a más de 60 m del recorrido se dibuja en su punto', () => {
    const f = new Fleet(net);
    f.ingest(snap(1000, 1000, 150), 0);
    expect(f.buses.get('1')!.onPath).toBe(false);
  });

  /** Instantánea sin buses a la hora `t`. */
  const none = (t: number): VehiclesV1 => ({ v: 1, t, n: 0, id: [], label: [], plate: [], route: [], lat: [], lon: [], age: [], stop: [], seq: [], start: [] });
  /** La misma instantánea de `snap` con otro id y etiqueta. */
  const as = (d: VehiclesV1, id: string, label: string): VehiclesV1 => ({ ...d, id: [id], label: [label] });

  it(`un bus que falta en una instantánea se conserva (el alimentador lo omite y lo devuelve); a los ${KEEP_S} s sin aparecer, sale`, () => {
    const f = new Fleet(net);
    const T0 = 1_000_000;
    f.ingest(snap(T0, 1000), T0 * 1000 + 50_000);
    const b = f.buses.get('1')!;
    const born = b.bornAt;
    f.ingest(none(T0 + 60), T0 * 1000 + 110_000);
    expect(f.buses.get('1')).toBe(b); // sigue, marcado como ausente, y su lectura envejece
    expect(b.missing).toBe(true);
    expect(b.age).toBe(60);
    expect(f.counts().troncal).toBe(0); // en el mapa sí; en el conteo de «buses en vía», no
    // Vuelve en la siguiente, cerca de donde estaba: el mismo bus, sin fundido de aparición.
    f.ingest(snap(T0 + 120, 1040), T0 * 1000 + 170_000);
    expect(f.buses.get('1')).toBe(b);
    expect(b.missing).toBe(false);
    expect(b.bornAt).toBe(born);
    expect(b.sFix).toBeCloseTo(1040, -1);
    // Deja de aparecer del todo: se conserva hasta KEEP_S del reloj del alimentador y sale.
    f.ingest(none(T0 + 120 + KEEP_S), T0 * 1000 + 400_000);
    expect(f.buses.size).toBe(1);
    f.ingest(none(T0 + 121 + KEEP_S), T0 * 1000 + 401_000);
    expect(f.buses.size).toBe(0);
  });

  it('un bus que solo trae el respaldo por ruta no sale con las instantáneas del alimentador mientras el respaldo lo actualice', () => {
    const f = new Fleet(net);
    const T0 = 1_000_000, W0 = T0 * 1000;
    f.ingest(snap(T0, 1000), W0 + 50_000);
    f.merge(as(snap(T0 + 40, 3000), 'ruta:Z9', 'Z9'), W0 + 60_000);
    f.ingest(snap(T0 + 60, 1500), W0 + 110_000); // el alimentador no lo trae
    expect(f.buses.has('ruta:Z9')).toBe(true);
    expect(f.reporting('B10')).toBe(1); // del alimentador, solo el bus 1
    f.merge(as(snap(T0 + 100, 3400), 'ruta:Z9', 'Z9'), W0 + 120_000); // el respaldo lo sigue trayendo
    f.ingest(snap(T0 + 300, 2500), W0 + 290_000);
    expect(f.buses.has('ruta:Z9')).toBe(true);
    // El respaldo deja de traerlo (ya no se mira esa ruta): a los 3 min de su última lectura, sale.
    f.ingest(snap(T0 + 320, 2600), W0 + 120_000 + BACKUP_KEEP + 1000);
    expect(f.buses.has('ruta:Z9')).toBe(false);
    expect(f.buses.has('1')).toBe(true);
  });

  it('si el alimentador trae después el bus del respaldo (misma etiqueta), queda uno solo y la selección pasa a su id', () => {
    const f = new Fleet(net);
    const T0 = 1_000_000, W0 = T0 * 1000;
    f.ingest(none(T0), W0);
    f.merge(as(snap(T0 + 10, 3000), 'ruta:A1', 'A1'), W0 + 20_000);
    f.selectedId = 'ruta:A1';
    const moved: string[] = [];
    f.onReplace = (from, to) => moved.push(`${from}>${to}`);
    f.ingest(snap(T0 + 60, 3200), W0 + 110_000); // el alimentador: id 1, etiqueta A1
    expect([...f.buses.keys()]).toEqual(['1']);
    expect(f.selectedId).toBe('1');
    expect(moved).toEqual(['ruta:A1>1']);
  });

  it('con el alimentador detenido, los buses del respaldo que ya no se actualizan salen por su cuenta (menos el seleccionado)', () => {
    const f = new Fleet(net);
    const T0 = 1_000_000, W0 = T0 * 1000;
    f.ingest(snap(T0, 1000), W0);
    f.merge(as(snap(T0 + 10, 3000), 'ruta:Z9', 'Z9'), W0 + 20_000);
    f.merge(as(snap(T0 + 10, 3500), 'ruta:Z8', 'Z8'), W0 + 20_000);
    f.selectedId = 'ruta:Z8';
    expect(f.prune(W0 + 100_000)).toBe(false);
    expect(f.prune(W0 + 20_000 + BACKUP_KEEP + 1)).toBe(true);
    expect([...f.buses.keys()].sort()).toEqual(['1', 'ruta:Z8']); // el del alimentador no se toca
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

  describe('movimiento directo (a la última lectura)', () => {
    const T0 = 1_000_000;
    function run(f: Fleet, from: number, to: number, step = 16) {
      let moving = false;
      for (let now = from; now <= to; now += step) moving = f.update(now);
      return moving;
    }

    it('va en ~0,4 s por el recorrido a la última lectura, suave, y se queda ahí', () => {
      const f = new Fleet(net);
      f.motion = 'directo';
      f.ingest(snap(T0, 1000), T0 * 1000 + 10_000);
      const b = f.buses.get('1')!;
      run(f, T0 * 1000 + 10_000, T0 * 1000 + 10_500);
      expect(b.s).toBeCloseTo(1000, -1); // la primera lectura: directo, sin retraso
      f.ingest(snap(T0 + 20, 1200), T0 * 1000 + 30_000);
      const t = T0 * 1000 + 30_000;
      f.update(t);
      f.update(t + GLIDE / 4);
      const q1 = b.s;
      f.update(t + GLIDE / 2);
      const half = b.s;
      expect(q1).toBeGreaterThan(1000);
      expect(half - 1000).toBeGreaterThan(q1 - 1000); // acelera al principio…
      expect(half).toBeCloseTo(1100, -1); // …y va por la mitad a mitad de tiempo
      run(f, t + GLIDE / 2, t + GLIDE + 50);
      const last = b.ts[b.ts.length - 1];
      expect(Math.abs(last - 1200)).toBeLessThan(1.5); // (la lectura viene redondeada a ~1 m)
      expect(b.s).toBeCloseTo(last, 6); // llega exacto a la lectura
      expect(run(f, t + GLIDE + 50, t + 15_000, 100)).toBe(false); // y espera quieta: no pide cuadros
      expect(b.s).toBeCloseTo(last, 6);
    });

    it('no retrocede por ruido del GPS', () => {
      const f = new Fleet(net);
      f.motion = 'directo';
      f.ingest(snap(T0, 1000), T0 * 1000);
      run(f, T0 * 1000, T0 * 1000 + 600);
      const s1 = f.buses.get('1')!.s;
      f.ingest(snap(T0 + 20, 990), T0 * 1000 + 20_000); // 10 m atrás
      run(f, T0 * 1000 + 20_000, T0 * 1000 + 21_000);
      expect(f.buses.get('1')!.s).toBeGreaterThanOrEqual(s1 - 0.01);
    });

    it('al cambiar de modo: a directo va a la última lectura; a continuo vuelve a la reproducción con retraso', () => {
      const f = new Fleet(net);
      f.ingest(snap(T0, 1000), T0 * 1000 + 10_000);
      f.ingest(snap(T0 + 20, 1200), T0 * 1000 + 30_000);
      run(f, T0 * 1000 + 30_000, T0 * 1000 + 31_000);
      const b = f.buses.get('1')!;
      expect(b.s).toBeLessThan(1100); // continuo: ~40 s atrás
      f.setMotion('directo', T0 * 1000 + 31_000);
      run(f, T0 * 1000 + 31_000, T0 * 1000 + 31_000 + GLIDE + 50);
      expect(b.s).toBeCloseTo(b.ts[b.ts.length - 1], 6);
      f.setMotion('continuo', T0 * 1000 + 32_000);
      f.update(T0 * 1000 + 32_000);
      expect(b.s).toBeLessThan(1150); // de una vez a la hora de reproducción
    });

    it('con «reducir movimiento» (sin deslizamiento) va de una vez', () => {
      const f = new Fleet(net);
      f.motion = 'directo';
      f.glide = 0;
      f.ingest(snap(T0, 1000), T0 * 1000);
      f.update(T0 * 1000);
      f.ingest(snap(T0 + 20, 1200), T0 * 1000 + 20_000);
      f.update(T0 * 1000 + 20_000);
      f.update(T0 * 1000 + 20_016);
      const b = f.buses.get('1')!;
      expect(b.s).toBeCloseTo(b.ts[b.ts.length - 1], 6);
    });
  });
});

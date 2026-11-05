import { describe, it, expect } from 'vitest';
import { MetricPath, decodeShape, KX, KY } from '../src/domain/geo';
import { etas, timeAt, pace, bandIndex, nextStopIndex, etaText, setSchedScale } from '../src/domain/eta';
import { beforeEach } from 'vitest';
import { textOn, ago, meters } from '../src/domain/time';
import type { Pattern } from '../src/domain/types';
import { undeltaPatterns } from '../src/domain/patterns';

// Recorrido recto hacia el este de 1.000 m, en lon/lat alrededor de Bogotá.
const lon0 = -74.1, lat0 = 4.65;
const straight = (m: number) => new MetricPath(new Float64Array([lon0, lat0, lon0 + m / KX, lat0]));

describe('geometría', () => {
  it('longitud, posición y rumbo sobre un recorrido recto', () => {
    const p = straight(1000);
    expect(p.length).toBeCloseTo(1000, 6);
    const q = p.pointAt(250, [0, 0]);
    expect(q[0] - lon0 * KX).toBeCloseTo(250, 6);
    expect(p.headingAt(500)).toBeCloseTo(0, 6);
  });

  it('proyecta un punto y busca primero cerca de la abscisa anterior', () => {
    // Ida y vuelta por la misma calle (circuito): con pista, se queda en el tramo correcto.
    const loop = new MetricPath(new Float64Array([lon0, lat0, lon0 + 1000 / KX, lat0, lon0, lat0 + 1 / KY]));
    const x = (lon0 + 300 / KX) * KX, y = lat0 * KY;
    expect(loop.nearest(x, y)!.s).toBeCloseTo(300, 0);
    expect(loop.nearest(x, y, 1650, 200, 400)!.s).toBeCloseTo(1700, -1);
  });

  it('decodifica recorridos por diferencias', () => {
    const out = decodeShape([-74100000, 4650000, 1000, -2000]);
    expect(Array.from(out)).toEqual([-74.1, 4.65, -74.099, 4.648]);
  });
});

const pattern: Pattern = {
  stops: ['a', 'b', 'c', 'd'],
  s: [0, 1000, 2000, 3000],
  t: [null, [0, 120, 240, 360], [0, 180, 360, 540], null, null],
  trips: 10,
};

describe('llegadas', () => {
  beforeEach(() => setSchedScale(1));
  it('tiempo del horario interpolado por distancia', () => {
    expect(timeAt(pattern, pattern.t[1]!, 500)).toBe(60);
    expect(timeAt(pattern, pattern.t[1]!, 2500)).toBe(300);
  });

  it('franjas horarias', () => {
    expect(bandIndex(5 * 3600)).toBe(0);
    expect(bandIndex(7 * 3600)).toBe(1);
    expect(bandIndex(12 * 3600)).toBe(2);
    expect(bandIndex(18 * 3600)).toBe(3);
    expect(bandIndex(23 * 3600)).toBe(4);
  });

  it('estimaciones desde la lectura, descontando su antigüedad', () => {
    const e = etas(pattern, 1, 500, 20);
    expect(e.map((x) => x.stopId)).toEqual(['b', 'c', 'd']);
    expect(e[0].seconds).toBe(40); // 120 − 60 − 20
    expect(e[2].meters).toBe(2500);
    expect(nextStopIndex(pattern, 1000)).toBe(2);
  });

  it('una franja sin viajes usa la más cercana', () => {
    expect(etas(pattern, 0, 0, 0)[0].seconds).toBe(120);
    expect(etas(pattern, 3, 0, 0)[0].seconds).toBe(180);
  });

  it('ritmo observado: más lento que el horario, acotado', () => {
    const k = pace(pattern, pattern.t[1]!, [{ at: 0, s: 0 }, { at: 240_000, s: 1000 }]);
    expect(k).toBe(1.8); // 240 s reales frente a 120 del horario → 2, acotado a 1,8
    expect(pace(pattern, pattern.t[1]!, [{ at: 0, s: 0 }])).toBe(1);
  });

  it('la escala del horario acorta la estimación (buses más rápidos que lo programado)', () => {
    setSchedScale(0.95);
    expect(etas(pattern, 1, 0, 0)[0].seconds).toBeCloseTo(114, 6);
    setSchedScale(1);
  });

  it('textos', () => {
    expect(etaText(30)).toBe('llegando');
    expect(etaText(185)).toBe('3 min');
    expect(etaText(3900)).toBe('1 h 05');
    expect(ago(3)).toBe('ahora');
    expect(ago(42)).toBe('42 s');
    expect(meters(420)).toBe('420 m');
    expect(textOn('#f2b705')).toBe('#07090b');
    expect(textOn('#4f6bed')).toBe('#ffffff');
  });
});

describe('patrones v2', () => {
  it('reconstruye abscisas y tiempos acumulados desde las diferencias', () => {
    const f = { v: 2, patterns: { r: { stops: ['a', 'b', 'c'], s: [0, 500, 700], t: [[0, 60, 30], null, [0, 90, 45], null, null], trips: 3 } as unknown as Pattern } };
    const p = undeltaPatterns(f).r;
    expect(p.s).toEqual([0, 500, 1200]);
    expect(p.t[0]).toEqual([0, 60, 90]);
    expect(p.t[1]).toBeNull();
    expect(p.t[2]).toEqual([0, 90, 135]);
    expect(f.v).toBe(1);
    // Una segunda llamada no vuelve a sumar.
    expect(undeltaPatterns(f).r.s).toEqual([0, 500, 1200]);
  });
});

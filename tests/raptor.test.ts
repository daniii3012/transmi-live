import { describe, it, expect } from 'vitest';
import { plan, type Model } from '../src/planner/raptor';

// Red de juguete: A —ruta 0— B —ruta 1— C, y una ruta 2 directa A→C más lenta.
const s = (id: string, lon: number) => ({ id, lon, lat: 4.65, station: null });
const every10 = Array.from({ length: 30 }, (_, h) => (h >= 5 && h < 23 ? 6 : 0)); // cada 10 min → espera 5 min
const model: Model = {
  stops: [s('A', -74.1), s('B', -74.09), s('B2', -74.0899), s('C', -74.08)],
  routes: [
    { id: 'r0', stops: [0, 1], times: [null, [0, 300], [0, 300], [0, 300], [0, 300]], perHour: every10 },
    { id: 'r1', stops: [2, 3], times: [null, [0, 300], [0, 300], [0, 300], [0, 300]], perHour: every10 },
    { id: 'r2', stops: [0, 3], times: [null, [0, 1500], [0, 1500], [0, 1500], [0, 1500]], perHour: every10 },
  ],
  routesAt: [[[0, 0], [2, 0]], [[0, 1]], [[1, 0]], [[1, 1], [2, 1]]],
  walks: [[], [[2, 60]], [[1, 60]], []],
};

describe('planificador', () => {
  it('da la directa (un bus) y la más rápida con transbordo (dos buses)', () => {
    const js = plan(model, [{ stop: 0, seconds: 0 }], [{ stop: 3, seconds: 0 }], 8 * 3600);
    expect(js.length).toBe(2);
    const [fast, direct] = js;
    expect(direct.rides).toBe(1);
    expect(direct.arrive - direct.depart).toBe(300 + 1500); // espera + viaje
    expect(fast.rides).toBe(2);
    // espera 300 + viaje 300 + 60 a pie a la otra parada + espera 300 + viaje 300 (caminar ya cubre
    // el margen de transbordo, que solo se suma al cambiar de bus en la misma parada)
    expect(fast.arrive - fast.depart).toBe(300 + 300 + 60 + 300 + 300);
    expect(fast.legs.map((l) => l.kind)).toEqual(['ride', 'walk', 'ride']);
  });

  it('fuera de horario no hay viaje', () => {
    expect(plan(model, [{ stop: 0, seconds: 0 }], [{ stop: 3, seconds: 0 }], 2 * 3600).length).toBe(0);
  });
});

describe('alternativas', () => {
  it('ofrece la directa y la del transbordo, sin repetidos y por hora de llegada', async () => {
    const { alternatives } = await import('../src/planner/raptor');
    const js = alternatives(model, [{ stop: 0, seconds: 0 }], [{ stop: 3, seconds: 0 }], 8 * 3600);
    expect(js.length).toBe(2);
    expect(js[0].arrive).toBeLessThanOrEqual(js[1].arrive);
  });
});

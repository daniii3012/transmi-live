import { KX, KY } from '../domain/geo';

/**
 * Altura de un bus sobre los puentes de la troncal (F7.5). Cada tramo de puente es una línea (el
 * carril de OSM con `bridge`) con su altura (6,5 m por nivel) y rampas suaves solo en los extremos
 * libres de la red de puentes, la misma regla que sus tableros (tools/build_data.py, `bridge_ramp`).
 * Un bus sube si está a ≤ `NEAR` m de la línea y va en su sentido (|cos| ≥ 0,8): los de la vía de
 * abajo, que la cruzan, se quedan en el suelo.
 */
export interface Bridge { h: number; L: number; d0: number; d1: number; R: number; c: Float64Array }

const NEAR = 5; // m
const G = 50; // m, celda del índice

/**
 * Fracción de la altura a `s` m del inicio de un tramo de puente (ver `bridge_ramp`): la distancia
 * por la red de puentes al extremo libre más cercano (`d0`, `d1` en sus extremos) sobre la rampa `R`.
 */
export function ramp(b: Bridge, s: number): number {
  const dist = Math.min(b.d0 + s, b.d1 + b.L - s);
  const u = b.R > 0 ? Math.max(0, Math.min(1, dist / b.R)) : 1;
  return u * u * (3 - 2 * u);
}

export class Elevation {
  /** Tramos: ax, ay, bx, by, s0 (abscisa en el puente al inicio del tramo), índice del puente. */
  private grid = new Map<string, number[]>();

  constructor(private bridges: Bridge[]) {
    bridges.forEach((b, bi) => {
      const c = b.c;
      let s = 0;
      for (let i = 2; i < c.length; i += 2) {
        const ax = c[i - 2] * KX, ay = c[i - 1] * KY, bx = c[i] * KX, by = c[i + 1] * KY;
        for (let gx = Math.floor((Math.min(ax, bx) - NEAR) / G); gx <= Math.floor((Math.max(ax, bx) + NEAR) / G); gx++) {
          for (let gy = Math.floor((Math.min(ay, by) - NEAR) / G); gy <= Math.floor((Math.max(ay, by) + NEAR) / G); gy++) {
            const k = `${gx}:${gy}`;
            let a = this.grid.get(k);
            if (!a) this.grid.set(k, (a = []));
            a.push(ax, ay, bx, by, s, bi);
          }
        }
        s += Math.hypot(bx - ax, by - ay);
      }
    });
  }

  /** Altura (m) en el punto (metros locales) para un bus con rumbo (hx, hy); 0 fuera de los puentes. */
  at(x: number, y: number, hx: number, hy: number): number {
    const a = this.grid.get(`${Math.floor(x / G)}:${Math.floor(y / G)}`);
    if (!a) return 0;
    let best = NEAR, h = 0;
    for (let i = 0; i < a.length; i += 6) {
      const ax = a[i], ay = a[i + 1], dx = a[i + 2] - ax, dy = a[i + 3] - ay;
      const l = Math.hypot(dx, dy);
      if (l < 1e-6 || Math.abs((dx * hx + dy * hy) / l) < 0.8) continue;
      const f = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (l * l)));
      const d = Math.hypot(x - ax - f * dx, y - ay - f * dy);
      if (d > best) continue;
      best = d;
      const b = this.bridges[a[i + 5]];
      h = b.h * ramp(b, a[i + 4] + f * l);
    }
    return h;
  }
}

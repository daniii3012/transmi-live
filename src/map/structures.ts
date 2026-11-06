import { KX, KY } from '../domain/geo';

/**
 * Altura de un bus sobre los puentes de la troncal (F7.5). Cada pieza (tramo elevado o rampa por el
 * carril que sigue) trae su altura por vértice (tools/build_data.py, `bridge_structures`); la misma
 * que dibuja la capa de estructuras. Un bus sube si está a ≤ `NEAR` m de la pieza y va en su sentido
 * (|cos| ≥ 0,8): los de la vía de abajo, que la cruzan, se quedan en el suelo. En las piezas anchas
 * (los puentes viales que van con la troncal, `k: 'via'`) cuenta medio ancho: un zonal en el carril de
 * afuera también va arriba.
 */
export interface Piece { w: number; z: number[]; c: Float64Array; k?: string; cov?: number }

const NEAR = 5; // m
const G = 50; // m, celda del índice

export class Elevation {
  /** Tramos: ax, ay, bx, by, za, zb, alcance. */
  private grid = new Map<string, number[]>();

  constructor(pieces: Piece[]) {
    for (const pc of pieces) {
      const c = pc.c;
      for (let i = 2; i < c.length; i += 2) {
        const ax = c[i - 2] * KX, ay = c[i - 1] * KY, bx = c[i] * KX, by = c[i + 1] * KY;
        const za = pc.z[i / 2 - 1], zb = pc.z[i / 2];
        if (Math.abs(za) < 0.05 && Math.abs(zb) < 0.05) continue;
        const near = Math.max(NEAR, pc.w / 2 - 0.3);
        for (let gx = Math.floor((Math.min(ax, bx) - near) / G); gx <= Math.floor((Math.max(ax, bx) + near) / G); gx++) {
          for (let gy = Math.floor((Math.min(ay, by) - near) / G); gy <= Math.floor((Math.max(ay, by) + near) / G); gy++) {
            const k = `${gx}:${gy}`;
            let a = this.grid.get(k);
            if (!a) this.grid.set(k, (a = []));
            a.push(ax, ay, bx, by, za, zb, near);
          }
        }
      }
    }
  }

  /** Altura (m) en el punto (metros locales) para un bus con rumbo (hx, hy); 0 fuera de los puentes. */
  at(x: number, y: number, hx: number, hy: number): number {
    const a = this.grid.get(`${Math.floor(x / G)}:${Math.floor(y / G)}`);
    if (!a) return 0;
    let best = Infinity, h = 0;
    for (let i = 0; i < a.length; i += 7) {
      const ax = a[i], ay = a[i + 1], dx = a[i + 2] - ax, dy = a[i + 3] - ay;
      const l = Math.hypot(dx, dy);
      if (l < 1e-6 || Math.abs((dx * hx + dy * hy) / l) < 0.8) continue;
      const f = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (l * l)));
      const d = Math.hypot(x - ax - f * dx, y - ay - f * dy);
      if (d > a[i + 6] || d > best) continue;
      best = d;
      h = a[i + 4] + (a[i + 5] - a[i + 4]) * f;
    }
    return h;
  }
}

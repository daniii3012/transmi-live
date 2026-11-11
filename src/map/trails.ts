import type { Fleet, Bus } from '../live/fleet';
import { ORIGIN, mercator } from '../live/fleet';
import { KX, KY } from '../domain/geo';

/**
 * Estelas sobre el recorrido (R10.5 y R10.6). La estela es el tramo de la ruta que el bus recorrió en
 * los últimos segundos o minutos, dibujado por los vértices del recorrido: sigue las curvas (la de
 * antes era una franja recta detrás del bus y cortaba las esquinas). Se apaga hacia atrás.
 *
 *  - Bus seleccionado: lo recorrido en 25 s, hasta 150 m, claro y algo más ancho que el trazo de su
 *    ruta, para leerse encima.
 *  - Larga exposición (capa «Larga exposición»): cada bus en marcha de los sistemas visibles deja lo
 *    recorrido en los últimos 3 min, fino y del color de su ruta. Los atenuados, no.
 *
 * Geometría en una tira de triángulos por estela (unidas por triángulos degenerados), en coordenadas
 * mercator respecto de `ORIGIN`, como los buses. Para no llamar a `mercator` por vértice, cada estela
 * usa la escala local de su cabeza (en 3 km el error es despreciable).
 */

export const SELECTED_S = 25_000;
export const SELECTED_MAX = 150;
export const EXPOSURE_S = 180_000;
export const EXPOSURE_MAX = 3000;
/** Floats por vértice: x, y (mercator), r, g, b, alfa, lado (−1 / 1). */
export const TRAIL_STRIDE = 7;

export interface TrailOpts {
  /** Metros por píxel a este zoom. */
  mpp: number;
  /** Larga exposición encendida. */
  exposure: boolean;
  /** Rectángulo visible (metros locales). */
  box?: [number, number, number, number];
}

const LIGHT: [number, number, number] = [1, 1, 1];
const m0 = [0, 0];

export class TrailBuilder {
  private buf = new Float32Array(64 * 1024);
  private n = 0;
  private builtAt = 0;
  private count = 0;

  /**
   * Arma las estelas. La larga exposición se rehace a lo sumo cada 100 ms (a escala de ciudad un bus
   * avanza menos de un píxel en ese tiempo); la del seleccionado, en cada cuadro.
   */
  build(fleet: Fleet, now: number, o: TrailOpts): { data: Float32Array; count: number } {
    const sel = fleet.selectedId ? fleet.buses.get(fleet.selectedId) : undefined;
    if (!o.exposure && !sel) { this.count = 0; return { data: this.buf, count: 0 }; }
    if (o.exposure && now - this.builtAt < 100 && !sel) return { data: this.buf, count: this.count };
    this.builtAt = now;
    this.n = 0;
    if (o.exposure) {
      for (const b of fleet.exposureBuses(now, o.box)) {
        if (b === sel) continue;
        const tail = Math.max(b.s - EXPOSURE_MAX, fleet.sAgo(b, now, EXPOSURE_S));
        const c = fleet.rgbOf(b);
        this.strip(b, tail, c, 0.72, 2.8 * o.mpp, 0.9 * o.mpp, o.mpp);
      }
    }
    if (sel && sel.onPath && sel.path && !fleet.isHidden(sel)) {
      const tail = Math.max(sel.s - SELECTED_MAX, fleet.sAgo(sel, now, SELECTED_S));
      const c = fleet.rgbOf(sel);
      const glow: [number, number, number] = [c[0] + (LIGHT[0] - c[0]) * 0.55, c[1] + (LIGHT[1] - c[1]) * 0.55, c[2] + (LIGHT[2] - c[2]) * 0.55];
      this.strip(sel, tail, glow, 0.92, 6.5 * o.mpp, 2 * o.mpp, o.mpp);
    }
    this.count = this.n;
    return { data: this.buf, count: this.n };
  }

  /** Una estela de `b.s` hacia atrás hasta `tail`, por los vértices del recorrido (cada ≥ 2,5 px). */
  private strip(b: Bus, tail: number, c: [number, number, number], alpha: number, w0: number, w1: number, mpp: number) {
    const P = b.path;
    if (!P || b.s - tail < 4 * mpp) return;
    const len = b.s - tail;
    // Puntos de la cabeza a la cola: el bus, los vértices intermedios y el punto de la cola.
    const xs: number[] = [b.x], ys: number[] = [b.y], ss: number[] = [b.s];
    let i = P.segmentAt(b.s) - 1;
    const minStep = 2.5 * mpp;
    while (i >= 0 && P.cum[i] > tail) {
      const lx = xs[xs.length - 1], ly = ys[ys.length - 1];
      if (Math.abs(P.x[i] - lx) + Math.abs(P.y[i] - ly) >= minStep) { xs.push(P.x[i]); ys.push(P.y[i]); ss.push(P.cum[i]); }
      i--;
      if (xs.length > 400) break;
    }
    const j = Math.max(1, P.segmentAt(tail));
    const a = P.cum[j - 1], l = P.cum[j] - a;
    const f = l > 0 ? Math.min(1, Math.max(0, (tail - a) / l)) : 0;
    xs.push(P.x[j - 1] + (P.x[j] - P.x[j - 1]) * f);
    ys.push(P.y[j - 1] + (P.y[j] - P.y[j - 1]) * f);
    ss.push(tail);
    const k = xs.length;
    if (k < 2) return;
    // Escala mercator local en la cabeza.
    mercator(b.x, b.y, m0);
    const hx = m0[0] - ORIGIN[0], hy = m0[1] - ORIGIN[1];
    // d(mercator)/d(metro): x = (lon + 180) / 360 con lon = x / KX; y crece hacia el sur.
    const lat = (b.y / KY) * (Math.PI / 180);
    const kx = 1 / (360 * KX), ky = 1 / (360 * Math.cos(lat) * KY);
    this.ensure((k * 2 + 2) * TRAIL_STRIDE);
    const out = this.buf;
    let first = true;
    for (let p = 0; p < k; p++) {
      // Normal promedio de los dos tramos vecinos (unión en inglete, acotada).
      const pa = Math.max(0, p - 1), pb = Math.min(k - 1, p + 1);
      let dx = xs[pa] - xs[pb], dy = ys[pa] - ys[pb];
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl; dy /= dl;
      const u = (b.s - ss[p]) / len; // 0 en el bus, 1 en la cola
      const w = (w0 + (w1 - w0) * u) / 2;
      const al = alpha * Math.pow(1 - u, 1.15);
      const nx = -dy * w, ny = dx * w;
      for (const side of [-1, 1]) {
        const x = hx + (xs[p] + nx * side - b.x) * kx;
        const y = hy - (ys[p] + ny * side - b.y) * ky;
        if (first && this.n > 0) this.vertex(x, y, c, al, side); // degenerado: une con la estela anterior
        first = false;
        this.vertex(x, y, c, al, side);
      }
    }
    // Degenerado de cierre: repite el último vértice.
    const o = (this.n - 1) * TRAIL_STRIDE;
    this.vertex(out[o], out[o + 1], c, out[o + 5], out[o + 6]);
  }

  private vertex(x: number, y: number, c: [number, number, number], a: number, side: number) {
    this.ensure(TRAIL_STRIDE);
    const o = this.n * TRAIL_STRIDE, out = this.buf;
    out[o] = x; out[o + 1] = y; out[o + 2] = c[0]; out[o + 3] = c[1]; out[o + 4] = c[2]; out[o + 5] = a; out[o + 6] = side;
    this.n++;
  }

  private ensure(extra: number) {
    if ((this.n + 1) * TRAIL_STRIDE + extra <= this.buf.length) return;
    const b = new Float32Array(Math.max(this.buf.length * 2, (this.n + 1) * TRAIL_STRIDE + extra));
    b.set(this.buf);
    this.buf = b;
  }
}

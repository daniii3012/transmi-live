/**
 * Geometría local. Proyección equirectangular centrada en Bogotá (lat0 = 4,65°), la misma que usa
 * tools/build_data.py: abscisas y longitudes calculadas aquí coinciden con las del compilador.
 * A la escala de la ciudad el error de escala es < 0,1 %.
 */
export const LAT0 = 4.65;
export const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
export const KY = 110_574;

export type XY = [number, number];

export const toXY = (lon: number, lat: number): XY => [lon * KX, lat * KY];
export const toLonLat = (x: number, y: number): [number, number] => [x / KX, y / KY];
export const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lonLatDist = (lon1: number, lat1: number, lon2: number, lat2: number) =>
  Math.hypot((lon1 - lon2) * KX, (lat1 - lat2) * KY);

export interface Hit { s: number; d: number; seg: number }

/**
 * Recorrido métrico: puntos en metros y su longitud acumulada. Permite ubicar un punto (abscisa y
 * distancia) y, al revés, obtener posición y rumbo en una abscisa.
 */
export class MetricPath {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly cum: Float64Array;
  readonly length: number;
  readonly lonlat: Float64Array;

  // Sin propiedades de parámetro: el dominio corre tal cual en Node (herramientas) y se puede portar.
  constructor(lonlat: Float64Array) {
    this.lonlat = lonlat;
    const n = lonlat.length / 2;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.cum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = lonlat[2 * i] * KX;
      this.y[i] = lonlat[2 * i + 1] * KY;
      if (i) this.cum[i] = this.cum[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.y[i] - this.y[i - 1]);
    }
    this.length = n ? this.cum[n - 1] : 0;
  }

  get size() { return this.x.length; }

  /** Segmento que contiene la abscisa `s` (índice del punto final). */
  segmentAt(s: number): number {
    const c = this.cum;
    let lo = 1, hi = c.length - 1;
    if (s <= 0) return 1;
    if (s >= this.length) return hi;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid] < s) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Posición (metros) en la abscisa `s`. Escribe en `out` para no reservar memoria por cuadro. */
  pointAt(s: number, out: Float64Array | number[] = [0, 0]): Float64Array | number[] {
    const n = this.size;
    if (n === 1) { out[0] = this.x[0]; out[1] = this.y[0]; return out; }
    const i = this.segmentAt(s);
    const a = this.cum[i - 1], l = this.cum[i] - a;
    const f = l > 0 ? Math.min(1, Math.max(0, (s - a) / l)) : 0;
    out[0] = this.x[i - 1] + (this.x[i] - this.x[i - 1]) * f;
    out[1] = this.y[i - 1] + (this.y[i] - this.y[i - 1]) * f;
    return out;
  }

  /** Rumbo (radianes, 0 = este, antihorario) suavizado: dirección entre s − w y s + w. */
  headingAt(s: number, w = 12): number {
    const a = this.pointAt(Math.max(0, s - w), [0, 0]);
    const b = this.pointAt(Math.min(this.length, s + w), [0, 0]);
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  }

  /**
   * Proyección de `p` sobre el recorrido. Con `hint` busca primero entre `hint − back` y
   * `hint + ahead` (para no saltar a otro tramo del mismo recorrido que pase cerca, como en los
   * circuitos); si ahí queda a más de `maxOff`, busca en todo el recorrido.
   */
  nearest(px: number, py: number, hint?: number, back = 200, ahead = 3500, maxOff = 60): Hit | null {
    if (this.size < 2) return null;
    if (hint !== undefined) {
      const h = this.scan(px, py, this.segmentAt(hint - back), this.segmentAt(hint + ahead));
      if (h && h.d <= maxOff) return h;
    }
    return this.scan(px, py, 1, this.size - 1);
  }

  private scan(px: number, py: number, from: number, to: number): Hit | null {
    let best: Hit | null = null;
    const X = this.x, Y = this.y, C = this.cum;
    for (let i = Math.max(1, from); i <= to; i++) {
      const ax = X[i - 1], ay = Y[i - 1], dx = X[i] - ax, dy = Y[i] - ay;
      const l2 = dx * dx + dy * dy;
      let f = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      const qx = ax + dx * f - px, qy = ay + dy * f - py;
      const d = Math.sqrt(qx * qx + qy * qy);
      if (!best || d < best.d) best = { s: C[i - 1] + (C[i] - C[i - 1]) * f, d, seg: i };
    }
    return best;
  }

  /** Coordenadas lon/lat entre dos abscisas (para dibujar un tramo). */
  slice(s0: number, s1: number): [number, number][] {
    const out: [number, number][] = [];
    const a = Math.max(0, Math.min(s0, s1)), b = Math.min(this.length, Math.max(s0, s1));
    const p = this.pointAt(a, [0, 0]);
    out.push(toLonLat(p[0], p[1]));
    for (let i = this.segmentAt(a); i < this.size && this.cum[i] < b; i++) out.push([this.lonlat[2 * i], this.lonlat[2 * i + 1]]);
    const q = this.pointAt(b, [0, 0]);
    out.push(toLonLat(q[0], q[1]));
    return out;
  }
}

/** Decodifica un recorrido en enteros de 1e-6 grados por diferencias. */
export function decodeShape(enc: number[], scale = 1e6): Float64Array {
  const out = new Float64Array(enc.length);
  let x = 0, y = 0;
  for (let i = 0; i < enc.length; i += 2) {
    x += enc[i]; y += enc[i + 1];
    out[i] = x / scale; out[i + 1] = y / scale;
  }
  return out;
}

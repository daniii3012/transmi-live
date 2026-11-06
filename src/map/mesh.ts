import earcut from 'earcut';
import { KY } from '../domain/geo';
import { mercator, ORIGIN } from '../live/fleet';

/**
 * Mallas de las estructuras 3D (andenes, puentes, metro, obras) en metros locales (lon·KX, lat·KY) y
 * altura en metros. `Mesh` las pasa a mercator relativo a `ORIGIN`, como los buses. Cada vértice lleva
 * su material; el color y la opacidad de cada material salen del tema (`STRUCT_THEMES`).
 */
export type P2 = [number, number];
type P3 = [number, number, number];

/** Materiales (índice por vértice): troncal, metro (M…), obras (O…), puentes viales que van con la troncal
 *  (Via…, translúcidos), deprimidos (muros, fondo y losa translúcida donde pasa una calle encima) y puentes
 *  peatonales (F…). */
export const M = {
  PlatTop: 0, PlatSide: 1, Roof: 2, Column: 3, DeckTop: 4, DeckSide: 5, Pier: 6, Parapet: 7, Wall: 8,
  MDeck: 9, MDeckSide: 10, MPier: 11, MConcourse: 12, MPlatform: 13, MGlass: 14, MRoof: 15, MFrame: 16, MAccess: 17, MBridge: 18,
  OSite: 19, OStruct: 20, OPlanned: 21,
  ViaTop: 22, ViaSide: 23,
  TWall: 24, TFloor: 25, Lid: 26,
  FDeck: 27, FSide: 28, FRail: 29,
} as const;
export const MATS = 30;

/** Color y opacidad por material (la opacidad solo cuenta en la pasada translúcida). */
type Mat = [string, number];
export const STRUCT_THEMES: Record<'dark' | 'light', Mat[]> = {
  dark: [
    ['#5d6872', 1], ['#3f4850', 1], ['#76828d', 0.82], ['#4c555e', 1], ['#48525c', 1], ['#363f47', 1], ['#2e353c', 1], ['#58626c', 1], ['#9fb0bf', 0.13],
    ['#525c66', 1], ['#3b444d', 1], ['#434c55', 1], ['#56616c', 1], ['#69737d', 1], ['#a7b8c7', 0.12], ['#a7b1bb', 1], ['#4f5962', 1], ['#4d5761', 1], ['#5a646e', 1],
    ['#3a3f45', 0.55], ['#5c666f', 1], ['#c8ccd1', 0.18],
    ['#66717c', 0.3], ['#4e5862', 0.26],
    ['#3a444e', 1], ['#2a323a', 1], ['#5d6872', 0.5],
    ['#626d78', 1], ['#47515b', 1], ['#a7b8c7', 0.22],
  ],
  light: [
    ['#dde1e5', 1], ['#b7bec5', 1], ['#c4ccd4', 0.86], ['#9aa3ac', 1], ['#d3d9df', 1], ['#b3bbc3', 1], ['#a2abb4', 1], ['#c6cdd4', 1], ['#7f93a6', 0.16],
    ['#c9cfd5', 1], ['#a9b1b9', 1], ['#b0b8c0', 1], ['#d2d7dc', 1], ['#e4e8eb', 1], ['#8aa1b6', 0.14], ['#eef1f3', 1], ['#a3acb5', 1], ['#c7cdd3', 1], ['#bcc3ca', 1],
    ['#c9c3b8', 0.5], ['#b7bfc7', 1], ['#7d8691', 0.18],
    ['#c3cad1', 0.42], ['#a7b0b9', 0.36],
    ['#b3bcc5', 1], ['#c9d1d9', 1], ['#c9d0d7', 0.55],
    ['#e1e5e9', 1], ['#bcc4cb', 1], ['#7f93a6', 0.25],
  ],
};

export class Mesh {
  v: number[] = [];
  private m = [0, 0];
  private push(x: number, y: number, z: number, n: P3, mat: number) {
    mercator(x, y, this.m);
    const k = 1 / (40_075_016.686 * Math.cos((y / KY) * (Math.PI / 180)));
    this.v.push(this.m[0] - ORIGIN[0], this.m[1] - ORIGIN[1], z * k, n[0], -n[1], n[2], mat);
  }
  tri(a: P3, b: P3, c: P3, mat: number, n?: P3) {
    if (!n) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const l = Math.hypot(...n) || 1;
      n = [n[0] / l, n[1] / l, n[2] / l];
    }
    this.push(a[0], a[1], a[2], n, mat); this.push(b[0], b[1], b[2], n, mat); this.push(c[0], c[1], c[2], n, mat);
  }
  quad(a: P3, b: P3, c: P3, d: P3, mat: number) {
    this.tri(a, b, c, mat); this.tri(a, c, d, mat);
  }
  /** Pared vertical de p a q, de z0 a z1 (en p) y z0b a z1b (en q), con la cara hacia la izquierda de p→q. */
  wall(p: P2, q: P2, z0: number, z1: number, mat: number, z0b = z0, z1b = z1) {
    this.quad([p[0], p[1], z0], [q[0], q[1], z0b], [q[0], q[1], z1b], [p[0], p[1], z1], mat);
  }
  /** Prisma vertical de un anillo (sin repetir el primer punto), de z0 a z1, con tapa arriba (y abajo si `bottom`). */
  prism(ring: P2[], z0: number, z1: number, top: number, side: number, bottom = false) {
    if (ring.length < 3) return;
    const r = ccw(ring); // antihorario: las paredes miran hacia afuera
    const flat: number[] = [];
    for (const p of r) flat.push(p[0], p[1]);
    const idx = earcut(flat);
    for (let i = 0; i < idx.length; i += 3) {
      const A = r[idx[i]], B = r[idx[i + 1]], C = r[idx[i + 2]];
      this.tri([A[0], A[1], z1], [B[0], B[1], z1], [C[0], C[1], z1], top, [0, 0, 1]);
      if (bottom) this.tri([A[0], A[1], z0], [C[0], C[1], z0], [B[0], B[1], z0], side, [0, 0, -1]);
    }
    for (let i = 0; i < r.length; i++) this.wall(r[i], r[(i + 1) % r.length], z0, z1, side);
  }
  /** Caja centrada en `c`, con el eje `u` (unitario), de semilargo `along` y semiancho `across`. */
  box(c: P2, u: P2, along: number, across: number, z0: number, z1: number, top: number, side: number, bottom = false) {
    const v: P2 = [-u[1], u[0]];
    const pt = (sa: number, sb: number): P2 => [c[0] + u[0] * along * sa + v[0] * across * sb, c[1] + u[1] * along * sa + v[1] * across * sb];
    this.prism([pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1)], z0, z1, top, side, bottom);
  }
  /** Sólido entre dos anillos del mismo número de vértices (abajo en z0, arriba en z1): capiteles que se
   *  ensanchan hacia arriba. Tapa arriba y, si `bottom`, abajo. */
  loft(lo: P2[], z0: number, hi: P2[], z1: number, top: number, side: number, bottom = false) {
    if (lo.length !== hi.length || lo.length < 3) return;
    const flip = area(hi) < 0;
    const a = flip ? [...lo].reverse() : lo, b = flip ? [...hi].reverse() : hi, n = a.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.quad([a[i][0], a[i][1], z0], [a[j][0], a[j][1], z0], [b[j][0], b[j][1], z1], [b[i][0], b[i][1], z1], side);
    }
    const cap = (r: P2[], z: number, mat: number, up: boolean) => {
      const flat: number[] = [];
      for (const p of r) flat.push(p[0], p[1]);
      const idx = earcut(flat);
      for (let i = 0; i < idx.length; i += 3) {
        const A = r[idx[i]], B = r[idx[i + 1]], C = r[idx[i + 2]];
        if (up) this.tri([A[0], A[1], z], [B[0], B[1], z], [C[0], C[1], z], mat, [0, 0, 1]);
        else this.tri([A[0], A[1], z], [C[0], C[1], z], [B[0], B[1], z], mat, [0, 0, -1]);
      }
    };
    cap(b, z1, top, true);
    if (bottom) cap(a, z0, side, false);
  }
  /** Rectángulo centrado en `c` con eje `u`, semilargo `along` y semiancho `across`. */
  static rect(c: P2, u: P2, along: number, across: number): P2[] {
    const v: P2 = [-u[1], u[0]];
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sa, sb]) => [c[0] + u[0] * along * sa + v[0] * across * sb, c[1] + u[1] * along * sa + v[1] * across * sb] as P2);
  }
  /** Paral delgado: dos paneles cruzados (12 vértices; una caja son 30). De lejos se ve igual. */
  post(c: P2, u: P2, r: number, z0: number, z1: number, mat: number) {
    const v: P2 = [-u[1], u[0]];
    for (const d of [u, v]) this.wall([c[0] - d[0] * r, c[1] - d[1] * r], [c[0] + d[0] * r, c[1] + d[1] * r], z0, z1, mat);
  }
  /** Cilindro (pila redonda) de radio `r`, de z0 a z1. */
  cyl(c: P2, r: number, z0: number, z1: number, mat: number, sides = 12) {
    const ring: P2[] = [];
    for (let i = 0; i < sides; i++) { const a = (i / sides) * 2 * Math.PI; ring.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); }
    this.prism(ring, z0, z1, mat, mat);
  }
}

export function area(ring: P2[]) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

/** El anillo en sentido antihorario. */
export function ccw(ring: P2[]): P2[] {
  return area(ring) > 0 ? ring : [...ring].reverse();
}

/** Anillo sin repetir el primer punto al final. */
export function open(ring: P2[]): P2[] {
  return ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
}

/**
 * Centro, eje, largo y ancho de un anillo. El eje es el dado (`axis`) o el del lado más largo; el
 * centro es el del rectángulo que lo encierra en ese eje (no el promedio de los vértices, que se corre
 * si están repartidos de forma desigual).
 */
export function frame(ring: P2[], axis?: P2): { c: P2; u: P2; L: number; W: number } {
  const n = ring.length;
  let cx = 0, cy = 0;
  for (const p of ring) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  let u: P2 = axis ?? [1, 0];
  if (!axis) {
    let best = 0;
    for (let i = 0; i < n; i++) {
      const p = ring[i], q = ring[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l > best) { best = l; u = [(q[0] - p[0]) / l, (q[1] - p[1]) / l]; }
    }
  }
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const p of ring) {
    const a = (p[0] - cx) * u[0] + (p[1] - cy) * u[1], b = -(p[0] - cx) * u[1] + (p[1] - cy) * u[0];
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
  }
  const mid = (a0 + a1) / 2, midB = (b0 + b1) / 2;
  return { c: [cx + u[0] * mid - u[1] * midB, cy + u[1] * mid + u[0] * midB], u, L: a1 - a0, W: b1 - b0 };
}

/** Anillo desplazado hacia afuera `d` m (inglete limitado). */
export function grow(ring: P2[], d: number): P2[] {
  const n = ring.length;
  const s = area(ring) > 0 ? 1 : -1;
  return ring.map((p, i) => {
    const pr = ring[(i - 1 + n) % n], nx = ring[(i + 1) % n];
    const e1 = [p[0] - pr[0], p[1] - pr[1]], e2 = [nx[0] - p[0], nx[1] - p[1]];
    const l1 = Math.hypot(e1[0], e1[1]) || 1, l2 = Math.hypot(e2[0], e2[1]) || 1;
    // Normales hacia afuera (anillo antihorario: a la derecha del avance).
    const n1 = [(e1[1] / l1) * s, (-e1[0] / l1) * s], n2 = [(e2[1] / l2) * s, (-e2[0] / l2) * s];
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml; my /= ml;
    const k = Math.min(2.5, 1 / Math.max(0.2, mx * n1[0] + my * n1[1]));
    return [p[0] + mx * d * k, p[1] + my * d * k];
  });
}

/** ¿El punto cae dentro del anillo? (par-impar) */
export function inside(p: P2, ring: P2[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * Eje central de un andén largo y angosto, aunque esté quebrado (los de Portal 80): cortes
 * perpendiculares al eje general cada `step` m; en cada uno, el punto medio del ancho y el ancho.
 */
export function slices(ring: P2[], step: number, inset = 0): { c: P2; w: number; t: number }[] {
  const f = frame(ring);
  const v: P2 = [-f.u[1], f.u[0]];
  const loc = ring.map((p) => [(p[0] - f.c[0]) * f.u[0] + (p[1] - f.c[1]) * f.u[1], (p[0] - f.c[0]) * v[0] + (p[1] - f.c[1]) * v[1]] as P2);
  const a0 = Math.min(...loc.map((p) => p[0])) + inset, a1 = Math.max(...loc.map((p) => p[0])) - inset;
  if (a1 <= a0) return [];
  const n = Math.max(1, Math.round((a1 - a0) / step));
  const out: { c: P2; w: number; t: number }[] = [];
  for (let k = 0; k <= n; k++) {
    const t = a0 + ((a1 - a0) * k) / n;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < loc.length; i++) {
      const p = loc[i], q = loc[(i + 1) % loc.length];
      if ((p[0] - t) * (q[0] - t) > 0 || p[0] === q[0]) continue;
      const b = p[1] + ((q[1] - p[1]) * (t - p[0])) / (q[0] - p[0]);
      lo = Math.min(lo, b); hi = Math.max(hi, b);
    }
    if (hi < lo) continue;
    const b = (lo + hi) / 2;
    out.push({ c: [f.c[0] + f.u[0] * t + v[0] * b, f.c[1] + f.u[1] * t + v[1] * b], w: hi - lo, t });
  }
  return out;
}

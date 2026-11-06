import earcut from 'earcut';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from 'maplibre-gl';
import type { Network } from '../data/network';
import { KX, KY } from '../domain/geo';
import { mercator, ORIGIN } from '../live/fleet';

/**
 * Estructuras de la troncal en 3D (H7), en WebGL propio como los buses: las extrusiones de MapLibre
 * solo hacen prismas planos con una opacidad por capa (tableros en escalones, estaciones como cajas).
 * Aquí, con la geometría de OSM (vía el simulador):
 *
 * - andenes: prisma de 0,9 m con su forma real (islas, andenes de OSM o módulos estimados);
 * - cubierta translúcida a 4,2 m, un poco más ancha que el andén, sobre columnas cada ~8 m;
 * - puentes: tablero con su pendiente real (rampas por los carriles que siguen), cara inferior,
 *   barandas de 0,9 m y pilas cada ~24 m donde el tablero pasa de 2,5 m.
 *
 * Dos pasadas: `solid` (opaco, antes de los buses: los tapa si pasan detrás o debajo) y `glass`
 * (cubiertas, después de los buses: los tiñe si pasan debajo).
 */
const PLATFORM_H = 0.9;
const ROOF_Z = 4.2;
const ROOF_T = 0.25;
const ROOF_PAD = 0.6;
const COL = 0.3;
const COL_STEP = 8;
const DECK = 0.8;
const PARAPET = 0.9;
const PARAPET_T = 0.25;
const PIER_STEP = 24;

/** Materiales (índice por vértice). */
const enum M { PlatTop, PlatSide, Roof, Column, DeckTop, DeckSide, Pier, Parapet }
const MATS = 8;

export const STRUCT_THEMES = {
  dark: { colors: ['#5d6872', '#3f4850', '#a3afba', '#4c555e', '#48525c', '#363f47', '#2e353c', '#58626c'], roofAlpha: 0.3 },
  light: { colors: ['#dde1e5', '#b7bec5', '#b9c4ce', '#9aa3ac', '#d3d9df', '#b3bbc3', '#a2abb4', '#c6cdd4'], roofAlpha: 0.45 },
};

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_norm;
layout(location=2) in float a_mat;
uniform mat4 u_matrix;
uniform vec3 u_colors[${MATS}];
out vec3 v_color;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 1.0);
  vec3 L = normalize(vec3(-0.35, -0.45, 0.82));
  float shade = 0.62 + 0.38 * max(dot(normalize(a_norm), L), 0.0);
  v_color = u_colors[int(a_mat + 0.5)] * shade;
}`;
const FS = `#version 300 es
precision mediump float;
in vec3 v_color;
uniform float u_alpha;
out vec4 frag;
void main() { frag = vec4(v_color * u_alpha, u_alpha); }`;

type P2 = [number, number];

/** Constructor de mallas en metros locales; `flush` las pasa a mercator relativo al origen. */
class Mesh {
  v: number[] = [];
  private m = [0, 0];
  private push(x: number, y: number, z: number, n: [number, number, number], mat: number) {
    mercator(x, y, this.m);
    const k = 1 / (40_075_016.686 * Math.cos((y / KY) * (Math.PI / 180)));
    this.v.push(this.m[0] - ORIGIN[0], this.m[1] - ORIGIN[1], z * k, n[0], -n[1], n[2], mat);
  }
  tri(a: [number, number, number], b: [number, number, number], c: [number, number, number], mat: number, n?: [number, number, number]) {
    if (!n) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const l = Math.hypot(...n) || 1;
      n = [n[0] / l, n[1] / l, n[2] / l];
    }
    this.push(a[0], a[1], a[2], n, mat); this.push(b[0], b[1], b[2], n, mat); this.push(c[0], c[1], c[2], n, mat);
  }
  quad(a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number], mat: number) {
    this.tri(a, b, c, mat); this.tri(a, c, d, mat);
  }
  /** Pared vertical de p a q, de z0 a z1 (en p) y z0b a z1b (en q), con la cara hacia la izquierda de p→q. */
  wall(p: P2, q: P2, z0: number, z1: number, mat: number, z0b = z0, z1b = z1) {
    this.quad([p[0], p[1], z0], [q[0], q[1], z0b], [q[0], q[1], z1b], [p[0], p[1], z1], mat);
  }
  /** Prisma vertical de un anillo (sin repetir el primer punto), de z0 a z1, con tapa arriba (y abajo si `bottom`). */
  prism(ring: P2[], z0: number, z1: number, top: number, side: number, bottom = false) {
    if (ring.length < 3) return;
    let a = 0;
    for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; a += p[0] * q[1] - q[0] * p[1]; }
    const r = a > 0 ? ring : [...ring].reverse(); // antihorario: las paredes miran hacia afuera
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
  box(c: P2, u: P2, along: number, across: number, z0: number, z1: number, top: number, side: number) {
    const v: P2 = [-u[1], u[0]];
    const pt = (sa: number, sb: number): P2 => [c[0] + u[0] * along * sa + v[0] * across * sb, c[1] + u[1] * along * sa + v[1] * across * sb];
    this.prism([pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1)], z0, z1, top, side);
  }
}

function open(ring: P2[]): P2[] {
  return ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
}

/** Centro, eje y largo de un andén (por su lado más largo). */
function frame(ring: P2[]): { c: P2; u: P2; L: number; W: number } {
  const n = ring.length;
  let cx = 0, cy = 0;
  for (const p of ring) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  let best = 0, u: P2 = [1, 0];
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l > best) { best = l; u = [(q[0] - p[0]) / l, (q[1] - p[1]) / l]; }
  }
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const p of ring) {
    const a = (p[0] - cx) * u[0] + (p[1] - cy) * u[1], b = -(p[0] - cx) * u[1] + (p[1] - cy) * u[0];
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
  }
  const mid = (a0 + a1) / 2, midB = (b0 + b1) / 2;
  return { c: [cx + u[0] * mid - u[1] * midB, cy + u[1] * mid + u[0] * midB], u, L: a1 - a0, W: b1 - b0 };
}

/** Anillo desplazado hacia afuera `d` m (inglete limitado), para la cubierta. */
function grow(ring: P2[], d: number): P2[] {
  const n = ring.length;
  let a = 0;
  for (let i = 0; i < n; i++) { const p = ring[i], q = ring[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
  const s = a > 0 ? 1 : -1;
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

export function buildStations(net: Network, solid: Mesh, glass: Mesh) {
  for (const s of net.stations.values()) {
    if ((!s.fp?.length && !s.roof?.length) || s.prov || s.closed) continue;
    const plats = (s.fp ?? []).map((r) => open(r.map(([lo, la]) => [lo * KX, la * KY] as P2)));
    for (const r of plats) {
      solid.prism(r, 0, PLATFORM_H, M.PlatTop, M.PlatSide);
      // Columnas a lo largo del eje del andén.
      const f = frame(r);
      if (f.L < 8) continue;
      const n = Math.max(2, Math.floor((f.L - 4) / COL_STEP) + 1);
      for (let i = 0; i < n; i++) {
        const t = -f.L / 2 + 2 + ((f.L - 4) * i) / (n - 1);
        solid.box([f.c[0] + f.u[0] * t, f.c[1] + f.u[1] * t], f.u, COL / 2, COL / 2, PLATFORM_H, ROOF_Z, M.Column, M.Column);
      }
    }
    // Cubiertas: las de OSM (building=roof) si están; si no, sobre cada andén, algo más anchas.
    const roofs = s.roof?.length ? s.roof.map((r) => open(r.map(([lo, la]) => [lo * KX, la * KY] as P2))) : plats.map((r) => grow(r, ROOF_PAD));
    for (const r of roofs) glass.prism(r, ROOF_Z, ROOF_Z + ROOF_T, M.Roof, M.Roof, true);
  }
}

export interface Piece { w: number; z: number[]; c: Float64Array }

/**
 * Puentes de la troncal. En los cruces varias piezas se encuentran (la glorieta de la Calle 6 y sus
 * accesos): la baranda de una pieza que cae dentro del tablero de otra a la misma altura no se dibuja
 * (cruzaba sobre el tablero vecino), y cada pieza va unos centímetros desfasada en altura para que dos
 * tableros que se superponen no parpadeen.
 */
export function buildBridges(pieces: Piece[], solid: Mesh) {
  // Índice de los ejes de todas las piezas (metros), para saber si un borde cae sobre otro tablero.
  const G = 40;
  const grid = new Map<string, number[]>();
  const geo = pieces.map((pc) => {
    const n = pc.c.length / 2;
    const P: P2[] = [];
    for (let i = 0; i < n; i++) P.push([pc.c[2 * i] * KX, pc.c[2 * i + 1] * KY]);
    return P;
  });
  geo.forEach((P, pi) => {
    for (let j = 1; j < P.length; j++) {
      const [ax, ay] = P[j - 1], [bx, by] = P[j];
      for (let gx = Math.floor(Math.min(ax, bx) / G) - 1; gx <= Math.floor(Math.max(ax, bx) / G) + 1; gx++) {
        for (let gy = Math.floor(Math.min(ay, by) / G) - 1; gy <= Math.floor(Math.max(ay, by) / G) + 1; gy++) {
          const k = `${gx}:${gy}`;
          let a = grid.get(k);
          if (!a) grid.set(k, (a = []));
          a.push(pi, j);
        }
      }
    }
  });
  /** ¿El punto (x, y, z) cae sobre el tablero de otra pieza a la misma altura? */
  const onOther = (x: number, y: number, z: number, self: number) => {
    const a = grid.get(`${Math.floor(x / G)}:${Math.floor(y / G)}`);
    if (!a) return false;
    for (let i = 0; i < a.length; i += 2) {
      const pi = a[i], j = a[i + 1];
      if (pi === self) continue;
      const P = geo[pi], pc = pieces[pi];
      const [ax, ay] = P[j - 1], [bx, by] = P[j];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
      const f = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      if (Math.hypot(x - ax - f * dx, y - ay - f * dy) > pc.w / 2 - 0.2) continue;
      const zo = pc.z[j - 1] + (pc.z[j] - pc.z[j - 1]) * f;
      if (Math.abs(zo - z) < 1.2) return true;
    }
    return false;
  };
  pieces.forEach((pc, pi) => {
    const P = geo[pi];
    const n = P.length;
    if (n < 2) return;
    const bias = (pi % 3) * 0.03;
    const Z = pc.z.map((z) => (z > 0.05 ? z + bias : z));
    const hw = pc.w / 2;
    // Normales por vértice (promedio de los tramos vecinos) para que las juntas no se abran.
    const N: P2[] = P.map((p, j) => {
      const a = P[Math.max(0, j - 1)], b = P[Math.min(n - 1, j + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      return [-dy / l, dx / l];
    });
    const L = (j: number, o: number): P2 => [P[j][0] + N[j][0] * o, P[j][1] + N[j][1] * o];
    let since = PIER_STEP / 2;
    for (let j = 1; j < n; j++) {
      const za = Z[j - 1], zb = Z[j];
      if (za < 0.05 && zb < 0.05) continue;
      const al = L(j - 1, hw), bl = L(j, hw), ar = L(j - 1, -hw), br = L(j, -hw);
      const bot = (z: number) => Math.max(0, z - DECK);
      // Tablero: cara superior y la de abajo.
      solid.quad([ar[0], ar[1], za], [br[0], br[1], zb], [bl[0], bl[1], zb], [al[0], al[1], za], M.DeckTop);
      solid.quad([al[0], al[1], bot(za)], [bl[0], bl[1], bot(zb)], [br[0], br[1], bot(zb)], [ar[0], ar[1], bot(za)], M.DeckSide);
      const zm = (za + zb) / 2;
      const leftFree = !onOther((al[0] + bl[0]) / 2, (al[1] + bl[1]) / 2, zm, pi);
      const rightFree = !onOther((ar[0] + br[0]) / 2, (ar[1] + br[1]) / 2, zm, pi);
      const ail = L(j - 1, hw - PARAPET_T), bil = L(j, hw - PARAPET_T), air = L(j - 1, -hw + PARAPET_T), bir = L(j, -hw + PARAPET_T);
      // Costado y baranda: solo donde el borde no cae sobre otro tablero.
      if (leftFree) {
        solid.wall(bl, al, bot(zb), zb + PARAPET, M.DeckSide, bot(za), za + PARAPET);
        solid.wall(ail, bil, za, za + PARAPET, M.Parapet, zb, zb + PARAPET);
        solid.quad([ail[0], ail[1], za + PARAPET], [bil[0], bil[1], zb + PARAPET], [bl[0], bl[1], zb + PARAPET], [al[0], al[1], za + PARAPET], M.Parapet);
      }
      if (rightFree) {
        solid.wall(ar, br, bot(za), za + PARAPET, M.DeckSide, bot(zb), zb + PARAPET);
        solid.wall(bir, air, zb, zb + PARAPET, M.Parapet, za, za + PARAPET);
        solid.quad([ar[0], ar[1], za + PARAPET], [br[0], br[1], zb + PARAPET], [bir[0], bir[1], zb + PARAPET], [air[0], air[1], za + PARAPET], M.Parapet);
      }
      // Pilas bajo el tablero, cada ~24 m donde ya va alto.
      const seg = Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]);
      since += seg;
      if (since >= PIER_STEP && zb > 2.5) {
        since = 0;
        const u: P2 = [N[j][1], -N[j][0]];
        solid.box(P[j], u, 0.6, Math.min(hw * 0.7, 1.6), 0, zb - DECK, M.Pier, M.Pier);
      }
    }
  });
}

export class StructuresLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  /** Solo con la vista 3D (lo pone el controlador). */
  visible = false;
  private map!: MLMap;
  private gl!: WebGL2RenderingContext;
  private prog!: WebGLProgram;
  private vao: WebGLVertexArrayObject | null = null;
  private buf: WebGLBuffer | null = null;
  private count = 0;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private colors = new Float32Array(MATS * 3);
  private alpha = 1;
  private pieces: Piece[] = [];

  constructor(private net: Network, private pass: 'solid' | 'glass') {
    this.id = pass === 'solid' ? 'structures' : 'structures-glass';
  }

  setTheme(theme: 'dark' | 'light') {
    const T = STRUCT_THEMES[theme];
    T.colors.forEach((hex, i) => { for (let k = 0; k < 3; k++) this.colors[i * 3 + k] = parseInt(hex.slice(1 + 2 * k, 3 + 2 * k), 16) / 255; });
    this.alpha = this.pass === 'glass' ? T.roofAlpha : 1;
    this.map?.triggerRepaint();
  }

  setBridges(pieces: Piece[]) {
    this.pieces = pieces;
    if (this.gl) this.upload();
  }

  onAdd(map: MLMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl as WebGL2RenderingContext;
    const g = this.gl;
    const sh = (type: number, src: string) => {
      const s = g.createShader(type)!;
      g.shaderSource(s, src);
      g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = g.createProgram()!;
    g.attachShader(p, sh(g.VERTEX_SHADER, VS));
    g.attachShader(p, sh(g.FRAGMENT_SHADER, FS));
    g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) ?? 'link');
    this.prog = p;
    for (const n of ['u_matrix', 'u_colors', 'u_alpha']) this.u[n] = g.getUniformLocation(p, n);
    this.upload();
  }

  private upload() {
    const solid = new Mesh(), glass = new Mesh();
    buildStations(this.net, solid, glass);
    if (this.pass === 'solid') buildBridges(this.pieces, solid);
    const data = new Float32Array(this.pass === 'solid' ? solid.v : glass.v);
    const g = this.gl;
    if (!this.vao) {
      this.vao = g.createVertexArray();
      this.buf = g.createBuffer();
      g.bindVertexArray(this.vao);
      g.bindBuffer(g.ARRAY_BUFFER, this.buf);
      g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 3, g.FLOAT, false, 28, 0);
      g.enableVertexAttribArray(1); g.vertexAttribPointer(1, 3, g.FLOAT, false, 28, 12);
      g.enableVertexAttribArray(2); g.vertexAttribPointer(2, 1, g.FLOAT, false, 28, 24);
      g.bindVertexArray(null);
    }
    g.bindBuffer(g.ARRAY_BUFFER, this.buf);
    g.bufferData(g.ARRAY_BUFFER, data, g.STATIC_DRAW);
    this.count = data.length / 7;
    this.map.triggerRepaint();
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, opts: CustomRenderMethodInput) {
    if (!this.visible || !this.count || this.map.getZoom() < 14.8) return;
    const g = gl as WebGL2RenderingContext;
    g.useProgram(this.prog);
    const m = opts.defaultProjectionData.mainMatrix as unknown as ArrayLike<number>;
    const [ox, oy] = ORIGIN;
    const mm = new Float32Array(16);
    for (let i = 0; i < 16; i++) mm[i] = m[i];
    for (let r = 0; r < 4; r++) mm[12 + r] = m[r] * ox + m[4 + r] * oy + m[12 + r];
    g.uniformMatrix4fv(this.u.u_matrix, false, mm);
    g.uniform3fv(this.u.u_colors, this.colors);
    g.uniform1f(this.u.u_alpha, this.alpha);
    g.bindVertexArray(this.vao);
    g.enable(g.DEPTH_TEST);
    g.depthFunc(g.LEQUAL);
    if (this.pass === 'solid') {
      g.disable(g.BLEND);
      g.depthMask(true);
    } else {
      g.enable(g.BLEND);
      g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
      g.depthMask(false);
    }
    g.drawArrays(g.TRIANGLES, 0, this.count);
    g.bindVertexArray(null);
  }

  onRemove() {
    this.gl?.deleteProgram(this.prog);
    if (this.buf) this.gl.deleteBuffer(this.buf);
    if (this.vao) this.gl.deleteVertexArray(this.vao);
  }
}

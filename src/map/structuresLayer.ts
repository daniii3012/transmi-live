import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from 'maplibre-gl';
import type { Network } from '../data/network';
import { KX, KY } from '../domain/geo';
import { ORIGIN } from '../live/fleet';
import { M, MATS, Mesh, STRUCT_THEMES, ccw, frame, grow, open, type P2 } from './mesh';

/**
 * Estructuras en 3D (H7), en WebGL propio como los buses: las extrusiones de MapLibre solo hacen
 * prismas planos con una opacidad por capa (tableros en escalones, estaciones como cajas). Por grupos,
 * cada uno con su visibilidad y su zoom mínimo:
 *
 * - `tm`, la troncal (geometría de OSM vía el simulador):
 *   - vagones: andén de 0,9 m con su forma real, paredes de vidrio con parales cada ~6 m y la cubierta
 *     apoyada en ellas, sin columnas en el medio (como las estaciones de la troncal: el vagón por dentro
 *     queda libre);
 *   - portales: la cubierta grande sobre columnas a lo largo de cada andén;
 *   - puentes: tablero con su pendiente real (rampas por los carriles que siguen), cara inferior,
 *     barandas de 0,9 m y pilas cada ~24 m donde el tablero pasa de 2,5 m.
 * - `metro`, la Línea 1 en obra (metro3d.ts), con la capa del metro.
 * - `obras`, las troncales en construcción (obras3d.ts), con el modo de obras.
 *
 * Dos pasadas: `solid` (opaco, antes de los buses: los tapa si pasan detrás o debajo) y `glass`
 * (vidrios y cubiertas de portal, después de los buses: los tiñen si pasan detrás o debajo).
 */
const PLATFORM_H = 0.9;
/** Vagón: cubierta sobre las paredes; en las fotos, apenas por encima del techo de un bus. */
const ROOF_Z = 3.8;
const ROOF_T = 0.22;
const ROOF_PAD = 0.35;
const POST = 0.14;
const POST_STEP = 6;
/** Portal: cubierta grande sobre columnas. */
const CANOPY_Z = 4.6;
const COL = 0.35;
const COL_STEP = 8;
const DECK = 0.8;
const PARAPET = 0.9;
const PARAPET_T = 0.25;
const PIER_STEP = 24;

const toXY = (r: [number, number][]) => open(r.map(([lo, la]) => [lo * KX, la * KY] as P2));

/** Paredes de vidrio alrededor del andén, con un paral en cada esquina y cada ~6 m. */
function walls(ring: P2[], solid: Mesh, glass: Mesh) {
  const r = ccw(ring), n = r.length;
  const post = (p: P2, u: P2) => {
    const c: P2 = [p[0] - u[1] * POST / 2, p[1] + u[0] * POST / 2]; // hacia adentro (izquierda del avance)
    solid.box(c, u, POST / 2, POST / 2, PLATFORM_H, ROOF_Z, M.Column, M.Column);
  };
  let acc = 0; // metros desde el último paral
  for (let i = 0; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n], pr = r[(i - 1 + n) % n];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l < 1e-3) continue;
    const u: P2 = [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
    glass.wall(p, q, PLATFORM_H, ROOF_Z, M.Wall);
    const lp = Math.hypot(p[0] - pr[0], p[1] - pr[1]) || 1;
    const corner = ((p[0] - pr[0]) * u[0] + (p[1] - pr[1]) * u[1]) / lp < Math.cos((25 * Math.PI) / 180);
    if (i === 0 || corner) { post(p, u); acc = 0; }
    let t = POST_STEP - acc;
    for (; t < l - 1; t += POST_STEP) post([p[0] + u[0] * t, p[1] + u[1] * t], u);
    acc = l - (t - POST_STEP);
  }
}

export function buildStations(net: Network, solid: Mesh, glass: Mesh) {
  for (const s of net.stations.values()) {
    if ((!s.fp?.length && !s.roof?.length) || s.prov || s.closed) continue;
    const plats = (s.fp ?? []).map(toXY);
    const portal = s.kind === 'portal';
    for (const r of plats) {
      solid.prism(r, 0, PLATFORM_H, M.PlatTop, M.PlatSide);
      if (!portal) { walls(r, solid, glass); continue; }
      // Portal: columnas a lo largo del eje del andén, bajo la cubierta grande.
      const f = frame(r);
      if (f.L < 8) continue;
      const k = Math.max(2, Math.floor((f.L - 4) / COL_STEP) + 1);
      for (let i = 0; i < k; i++) {
        const t = -f.L / 2 + 2 + ((f.L - 4) * i) / (k - 1);
        solid.box([f.c[0] + f.u[0] * t, f.c[1] + f.u[1] * t], f.u, COL / 2, COL / 2, PLATFORM_H, CANOPY_Z, M.Column, M.Column);
      }
    }
    // Cubiertas: las de OSM (building=roof) si están; si no, sobre cada andén, algo más anchas. La del
    // vagón es de lámina (opaca); la del portal, translúcida: los buses paran debajo.
    const z = portal ? CANOPY_Z : ROOF_Z;
    const roofs = s.roof?.length ? s.roof.map(toXY) : plats.map((r) => grow(r, portal ? 0.6 : ROOF_PAD));
    // La translúcida, sin cara de abajo: dos capas casi juntas dejaban ver las aristas de los triángulos.
    for (const r of roofs) (portal ? glass : solid).prism(r, z, z + ROOF_T, M.Roof, M.Roof, !portal);
  }
}

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_norm;
layout(location=2) in float a_mat;
uniform mat4 u_matrix;
uniform vec4 u_colors[${MATS}];
out vec4 v_color;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 1.0);
  vec3 L = normalize(vec3(-0.35, -0.45, 0.82));
  float shade = 0.62 + 0.38 * max(dot(normalize(a_norm), L), 0.0);
  vec4 c = u_colors[int(a_mat + 0.5)];
  v_color = vec4(c.rgb * shade, c.a);
}`;
const FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 frag;
void main() { frag = vec4(v_color.rgb * v_color.a, v_color.a); }`;

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

interface Group { data: Float32Array; vao: WebGLVertexArrayObject | null; buf: WebGLBuffer | null; count: number; on: boolean; minZoom: number; dirty: boolean }

/** Una pasada (opaca o translúcida) de todos los grupos. Se arma desde `Structures`. */
export class StructuresLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  private map!: MLMap;
  private gl!: WebGL2RenderingContext;
  private prog!: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private colors = new Float32Array(MATS * 4);
  private groups = new Map<string, Group>();

  constructor(private pass: 'solid' | 'glass') {
    this.id = pass === 'solid' ? 'structures' : 'structures-glass';
  }

  setTheme(theme: 'dark' | 'light') {
    STRUCT_THEMES[theme].forEach(([hex, a], i) => {
      for (let k = 0; k < 3; k++) this.colors[i * 4 + k] = parseInt(hex.slice(1 + 2 * k, 3 + 2 * k), 16) / 255;
      this.colors[i * 4 + 3] = this.pass === 'glass' ? a : 1;
    });
    this.map?.triggerRepaint();
  }

  setGroup(name: string, v: number[], minZoom: number) {
    const g = this.groups.get(name);
    const data = new Float32Array(v);
    if (g) Object.assign(g, { data, minZoom, dirty: true });
    else this.groups.set(name, { data, vao: null, buf: null, count: 0, on: false, minZoom, dirty: true });
    this.map?.triggerRepaint();
  }

  show(name: string, on: boolean) {
    const g = this.groups.get(name);
    if (g && g.on !== on) { g.on = on; this.map?.triggerRepaint(); }
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
    for (const n of ['u_matrix', 'u_colors']) this.u[n] = g.getUniformLocation(p, n);
  }

  /** Sube a la GPU los grupos nuevos o cambiados (en el cuadro, con el contexto listo). */
  private upload(gr: Group) {
    const g = this.gl;
    if (!gr.vao) {
      gr.vao = g.createVertexArray();
      gr.buf = g.createBuffer();
      g.bindVertexArray(gr.vao);
      g.bindBuffer(g.ARRAY_BUFFER, gr.buf);
      g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 3, g.FLOAT, false, 28, 0);
      g.enableVertexAttribArray(1); g.vertexAttribPointer(1, 3, g.FLOAT, false, 28, 12);
      g.enableVertexAttribArray(2); g.vertexAttribPointer(2, 1, g.FLOAT, false, 28, 24);
      g.bindVertexArray(null);
    }
    g.bindBuffer(g.ARRAY_BUFFER, gr.buf);
    g.bufferData(g.ARRAY_BUFFER, gr.data, g.STATIC_DRAW);
    gr.count = gr.data.length / 7;
    gr.data = new Float32Array(0);
    gr.dirty = false;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, opts: CustomRenderMethodInput) {
    const zoom = this.map.getZoom();
    const live = [...this.groups.values()].filter((gr) => gr.on && zoom >= gr.minZoom && (gr.dirty || gr.count));
    if (!live.length) return;
    const g = gl as WebGL2RenderingContext;
    for (const gr of live) if (gr.dirty) this.upload(gr);
    g.useProgram(this.prog);
    const m = opts.defaultProjectionData.mainMatrix as unknown as ArrayLike<number>;
    const [ox, oy] = ORIGIN;
    const mm = new Float32Array(16);
    for (let i = 0; i < 16; i++) mm[i] = m[i];
    for (let r = 0; r < 4; r++) mm[12 + r] = m[r] * ox + m[4 + r] * oy + m[12 + r];
    g.uniformMatrix4fv(this.u.u_matrix, false, mm);
    g.uniform4fv(this.u.u_colors, this.colors);
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
    for (const gr of live) {
      if (!gr.count) continue;
      g.bindVertexArray(gr.vao);
      g.drawArrays(g.TRIANGLES, 0, gr.count);
    }
    g.bindVertexArray(null);
  }

  onRemove() {
    this.gl?.deleteProgram(this.prog);
    for (const gr of this.groups.values()) {
      if (gr.buf) this.gl.deleteBuffer(gr.buf);
      if (gr.vao) this.gl.deleteVertexArray(gr.vao);
    }
  }
}

/** Las dos pasadas juntas: cada grupo se arma una vez y reparte lo opaco y lo translúcido. */
export class Structures {
  readonly solid = new StructuresLayer('solid');
  readonly glass = new StructuresLayer('glass');

  set(name: string, build: (solid: Mesh, glass: Mesh) => void, minZoom = 14.8) {
    const s = new Mesh(), g = new Mesh();
    build(s, g);
    this.solid.setGroup(name, s.v, minZoom);
    this.glass.setGroup(name, g.v, minZoom);
  }

  show(name: string, on: boolean) {
    this.solid.show(name, on);
    this.glass.show(name, on);
  }

  setTheme(t: 'dark' | 'light') {
    this.solid.setTheme(t);
    this.glass.setTheme(t);
  }
}

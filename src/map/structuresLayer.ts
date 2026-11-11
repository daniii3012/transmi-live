import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from 'maplibre-gl';
import type { Network } from '../data/network';
import { KX, KY } from '../domain/geo';
import { ORIGIN } from '../live/fleet';
import { M, MATS, Mesh, STRUCT_THEMES, area, ccw, frame, grow, inside, open as openRing, slices, type P2 } from './mesh';

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

const toXY = (r: [number, number][]) => openRing(r.map(([lo, la]) => [lo * KX, la * KY] as P2));

/** Paredes de vidrio alrededor del andén, con un paral en cada esquina y cada ~6 m. */
function walls(ring: P2[], solid: Mesh, glass: Mesh, z0 = 0) {
  const r = ccw(ring), n = r.length;
  const post = (p: P2, u: P2) => {
    const c: P2 = [p[0] - u[1] * POST / 2, p[1] + u[0] * POST / 2]; // hacia adentro (izquierda del avance)
    solid.post(c, u, POST / 2, z0 + PLATFORM_H, z0 + ROOF_Z, M.Column);
  };
  let acc = 0; // metros desde el último paral
  for (let i = 0; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n], pr = r[(i - 1 + n) % n];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l < 1e-3) continue;
    const u: P2 = [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
    glass.wall(p, q, z0 + PLATFORM_H, z0 + ROOF_Z, M.Wall);
    const lp = Math.hypot(p[0] - pr[0], p[1] - pr[1]) || 1;
    const corner = ((p[0] - pr[0]) * u[0] + (p[1] - pr[1]) * u[1]) / lp < Math.cos((25 * Math.PI) / 180);
    if (i === 0 || corner) { post(p, u); acc = 0; }
    let t = POST_STEP - acc;
    for (; t < l - 1; t += POST_STEP) post([p[0] + u[0] * t, p[1] + u[1] * t], u);
    acc = l - (t - POST_STEP);
  }
}

/** Fracción de los puntos del andén (vértices y centro) que caen bajo una cubierta, con 1 m de holgura:
 *  una cubierta de OSM que es el mismo polígono que el andén (el centro de Banderas) deja los vértices
 *  justo en el borde, y la prueba de «dentro» los descartaba. */
function covered(plat: P2[], roof: P2[]): number {
  let cx = 0, cy = 0;
  for (const p of plat) { cx += p[0]; cy += p[1]; }
  const pts = [...plat, [cx / plat.length, cy / plat.length] as P2];
  const big = grow(roof, 1);
  return pts.filter((p) => inside(p, big)).length / pts.length;
}

/**
 * Estaciones. Cada andén lleva su techo: la cubierta de OSM que lo cubre o, si ninguna, una propia algo
 * más ancha (antes, con una cubierta de OSM en la estación, los andenes que ella no cubría quedaban sin
 * techo: Ricaurte, Banderas). Dos estilos:
 *
 * - vagón (lo común): paredes de vidrio con parales y la cubierta apoyada en ellas;
 * - abierto (los portales, y los andenes de más de 8 m bajo una cubierta de OSM, como el centro de
 *   Banderas): sin paredes, con columnas a lo largo del eje del andén (quebrado o no) bajo la cubierta.
 *
 * Las cubiertas de OSM que no cubren ningún andén (pasillos, accesos) también se dibujan.
 */
export function buildStations(net: Network, solid: Mesh, glass: Mesh, pieces: Piece[] = [], deep: P2[][] = []) {
  const depth = new Depth(pieces);
  for (const s of net.stations.values()) {
    if ((!s.fp?.length && !s.roof?.length) || s.prov || s.closed) continue;
    const roofs = (s.roof ?? []).map(toXY);
    const portal = s.kind === 'portal';
    // Estación bajo tierra (Museo Nacional): a la cota del deprimido que la rodea, con la losa de la
    // calle encima (translúcida, para ver los buses).
    const z0 = depth.station((s.fp ?? []).map(toXY));
    if (z0 < -1.5) for (const r of (s.fp ?? []).map(toXY)) { deep.push(r); glass.prism(grow(r, 1), -0.3, 0.02, M.Lid, M.Lid); }
    const plats = (s.fp ?? []).map(toXY).map((r) => {
      const sl = slices(r, COL_STEP, 2);
      const len = sl.length > 1 ? Math.hypot(sl[sl.length - 1].c[0] - sl[0].c[0], sl[sl.length - 1].c[1] - sl[0].c[1]) + 4 : 4;
      const ri = roofs.findIndex((q) => covered(r, q) >= 0.6);
      return { r, sl, ri, open: portal || (ri >= 0 && area(r) / len > 8) };
    });
    for (const { r, sl, ri, open } of plats) {
      const z = z0 + (open ? CANOPY_Z : ROOF_Z);
      solid.prism(r, z0, z0 + PLATFORM_H, M.PlatTop, M.PlatSide);
      if (open) {
        // Columnas por el eje del andén, bajo la cubierta.
        sl.forEach((k, i) => {
          const a = sl[Math.max(0, i - 1)].c, b = sl[Math.min(sl.length - 1, i + 1)].c;
          const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          solid.box(k.c, [(b[0] - a[0]) / l, (b[1] - a[1]) / l], COL / 2, COL / 2, z0 + PLATFORM_H, z, M.Column, M.Column);
        });
      } else {
        walls(r, solid, glass, z0);
      }
      // Techo propio si ninguna cubierta de OSM lo cubre: el del vagón, de lámina (opaco); el abierto,
      // translúcido (los buses paran debajo) y sin cara de abajo (dos capas casi juntas dejaban ver las
      // aristas de los triángulos).
      if (ri < 0) (open ? glass : solid).prism(grow(r, open ? 0.6 : ROOF_PAD), z, z + ROOF_T, M.Roof, M.Roof, !open);
    }
    // Cubiertas de OSM: translúcidas sobre andenes abiertos (o en un portal); si no, opacas. Una cubierta
    // sin andén modelado debajo (en Ricaurte, sobre un vagón que OSM no trae) no queda flotando: lleva su
    // andén con paredes, un poco más angosto que ella.
    roofs.forEach((q, i) => {
      const big = portal || plats.some((p) => p.ri === i && p.open);
      const z = z0 + (big ? CANOPY_Z : ROOF_Z);
      (big ? glass : solid).prism(q, z, z + ROOF_T, M.Roof, M.Roof, !big);
      if (!portal && !plats.some((p) => p.ri === i)) {
        const r = grow(q, -ROOF_PAD);
        solid.prism(r, z0, z0 + PLATFORM_H, M.PlatTop, M.PlatSide);
        walls(r, solid, glass, z0);
      }
    });
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

export interface Piece { w: number; z: number[]; c: Float64Array; k?: string; cov?: number; wv?: number[] }

/**
 * Puentes de la troncal y, donde van en la misma estructura, los de la vía de carros (`k: 'via'`,
 * tools/build_data.py). En los cruces varias piezas se encuentran (la glorieta de la Calle 6 y sus
 * accesos): la baranda de una pieza que cae dentro del tablero de otra a la misma altura no se dibuja
 * (cruzaba sobre el tablero vecino), y cada pieza va unos centímetros desfasada en altura para que dos
 * tableros que se superponen no parpadeen. Los viales van translúcidos y sin cara de abajo: el énfasis
 * queda en el de la troncal, y su baranda (la barrera con los carriles mixtos) no la tapa un vial.
 */
export function buildBridges(pieces: Piece[], solid: Mesh, glass: Mesh) {
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
      if (pi === self || (pieces[pi].k === 'via' && pieces[self].k !== 'via')) continue;
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
    if (pc.k === 'tunel') return; // deprimidos: buildTrenches
    const via = pc.k === 'via';
    const mesh = via ? glass : solid;
    const TOP = via ? M.ViaTop : M.DeckTop, SIDE = via ? M.ViaSide : M.DeckSide, RAIL = via ? M.ViaSide : M.Parapet, PIER = via ? M.ViaSide : M.Pier;
    const bias = (pi % 3) * 0.03;
    const Z = pc.z.map((z) => (z > 0.05 ? z + bias : z));
    // Medio ancho por vértice: constante, o el de cada vértice en las rampas viales que se angostan.
    const HW = pc.wv && pc.wv.length === n ? pc.wv.map((w) => w / 2) : P.map(() => pc.w / 2);
    // Normales por vértice (promedio de los tramos vecinos) para que las juntas no se abran.
    const N: P2[] = P.map((p, j) => {
      const a = P[Math.max(0, j - 1)], b = P[Math.min(n - 1, j + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      return [-dy / l, dx / l];
    });
    /** Punto a `o` medios anchos (±1) o a `o` metros (`abs`) del eje en el vértice j. */
    const L = (j: number, o: number, abs = false): P2 => { const d = abs ? o : o * HW[j]; return [P[j][0] + N[j][0] * d, P[j][1] + N[j][1] * d]; };
    // Estribo donde la pieza termina en alto sin que siga otro tablero (un puente vial cuya vía sigue
    // montada sobre otra estructura).
    for (const j of [0, n - 1]) {
      if (Z[j] > 0.3 && !onOther(P[j][0], P[j][1], Z[j], pi)) mesh.wall(L(j, 1), L(j, -1), 0, Z[j], SIDE);
    }
    let since = PIER_STEP / 2;
    for (let j = 1; j < n; j++) {
      const za = Z[j - 1], zb = Z[j];
      if (za < 0.05 && zb < 0.05) continue;
      const al = L(j - 1, 1), bl = L(j, 1), ar = L(j - 1, -1), br = L(j, -1);
      const bot = (z: number) => Math.max(0, z - DECK);
      // Tablero: cara superior y la de abajo.
      mesh.quad([ar[0], ar[1], za], [br[0], br[1], zb], [bl[0], bl[1], zb], [al[0], al[1], za], TOP);
      if (!via) solid.quad([al[0], al[1], bot(za)], [bl[0], bl[1], bot(zb)], [br[0], br[1], bot(zb)], [ar[0], ar[1], bot(za)], M.DeckSide);
      const zm = (za + zb) / 2;
      const leftFree = !onOther((al[0] + bl[0]) / 2, (al[1] + bl[1]) / 2, zm, pi);
      const rightFree = !onOther((ar[0] + br[0]) / 2, (ar[1] + br[1]) / 2, zm, pi);
      const ail = L(j - 1, HW[j - 1] - PARAPET_T, true), bil = L(j, HW[j] - PARAPET_T, true), air = L(j - 1, -HW[j - 1] + PARAPET_T, true), bir = L(j, -HW[j] + PARAPET_T, true);
      // Costado y baranda: solo donde el borde no cae sobre otro tablero.
      if (leftFree) {
        mesh.wall(bl, al, bot(zb), zb + PARAPET, SIDE, bot(za), za + PARAPET);
        if (!via) solid.wall(ail, bil, za, za + PARAPET, M.Parapet, zb, zb + PARAPET);
        mesh.quad([ail[0], ail[1], za + PARAPET], [bil[0], bil[1], zb + PARAPET], [bl[0], bl[1], zb + PARAPET], [al[0], al[1], za + PARAPET], RAIL);
      }
      if (rightFree) {
        mesh.wall(ar, br, bot(za), za + PARAPET, SIDE, bot(zb), zb + PARAPET);
        if (!via) solid.wall(bir, air, zb, zb + PARAPET, M.Parapet, za, za + PARAPET);
        mesh.quad([ar[0], ar[1], za + PARAPET], [br[0], br[1], zb + PARAPET], [bir[0], bir[1], zb + PARAPET], [air[0], air[1], za + PARAPET], RAIL);
      }
      // Pilas bajo el tablero, cada ~24 m donde ya va alto.
      const seg = Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]);
      since += seg;
      if (since >= PIER_STEP && zb > 2.5) {
        since = 0;
        const u: P2 = [N[j][1], -N[j][0]];
        mesh.box(P[j], u, 0.6, Math.min(HW[j] * 0.7, 1.6), 0, zb - DECK, PIER, PIER);
      }
    }
  });
}

/** Tramos deprimidos de la troncal, para saber la cota bajo un punto (estaciones bajo tierra). */
class Depth {
  private segs: { ax: number; ay: number; bx: number; by: number; za: number; zb: number }[] = [];
  constructor(pieces: Piece[]) {
    for (const pc of pieces) {
      if (pc.k !== 'tunel') continue;
      for (let i = 2; i < pc.c.length; i += 2) {
        this.segs.push({ ax: pc.c[i - 2] * KX, ay: pc.c[i - 1] * KY, bx: pc.c[i] * KX, by: pc.c[i + 1] * KY, za: pc.z[i / 2 - 1], zb: pc.z[i / 2] });
      }
    }
  }
  /** Cota (m, negativa) del deprimido más hondo a ≤ `r` m del punto y paralelo a `u`; 0 si no hay. */
  at(p: P2, u: P2, r = 25): number {
    let z = 0;
    for (const sg of this.segs) {
      const dx = sg.bx - sg.ax, dy = sg.by - sg.ay, l2 = dx * dx + dy * dy;
      if (l2 < 1e-6 || Math.abs((dx * u[0] + dy * u[1]) / Math.sqrt(l2)) < 0.9) continue;
      const f = Math.max(0, Math.min(1, ((p[0] - sg.ax) * dx + (p[1] - sg.ay) * dy) / l2));
      if (Math.hypot(p[0] - sg.ax - f * dx, p[1] - sg.ay - f * dy) > r) continue;
      z = Math.min(z, sg.za + (sg.zb - sg.za) * f);
    }
    return z;
  }
  /**
   * Cota de una estación bajo tierra: solo si cada andén queda dentro del deprimido a todo su largo (cinco
   * puntos por su eje, la cota del menos hondo). Una estación a nivel junto a un paso deprimido (Bicentenario,
   * junto al de dos niveles de la Av. Comuneros) no baja.
   */
  station(rings: P2[][]): number {
    if (!this.segs.length || !rings.length) return 0;
    let deepest = 0;
    for (const r of rings) {
      const f = frame(r);
      let shallow = -Infinity;
      for (const t of [-0.45, -0.22, 0, 0.22, 0.45]) {
        const p: P2 = [f.c[0] + f.u[0] * f.L * t, f.c[1] + f.u[1] * f.L * t];
        shallow = Math.max(shallow, this.at(p, f.u, 14));
      }
      deepest = Math.min(deepest, shallow);
    }
    return deepest;
  }
}

/**
 * Deprimidos de la troncal (pasos bajo una calle, trincheras): fondo a su cota, muros hasta el suelo y,
 * donde OSM dice que pasan bajo una calle y hay altura para un bus, la losa de la calle encima
 * (translúcida, para ver los buses). Los muros no se dibujan donde el borde da a otra boca o a una
 * estación bajo tierra (`deep`): ahí sigue la calzada o el andén.
 *
 * (Se probó una máscara de profundidad invisible a nivel del suelo para ver la trinchera solo por su boca:
 * en las uniones en curva, como a la salida de Museo Nacional, tapaba parte de la boca vecina y dejaba
 * manchas. Sin ella los muros cierran la vista y se ve limpio; revisión del 6 nov.)
 */
export function buildTrenches(pieces: Piece[], deep: P2[][], solid: Mesh, glass: Mesh) {
  const tun = pieces.filter((pc) => pc.k === 'tunel' && pc.c.length >= 4);
  const geo = tun.map((pc) => {
    const P: P2[] = [];
    for (let i = 0; i < pc.c.length; i += 2) P.push([pc.c[i] * KX, pc.c[i + 1] * KY]);
    return P;
  });
  /** ¿El punto cae dentro de la boca de otro deprimido (o de una estación bajo tierra)? */
  const inOpening = (x: number, y: number, self: number) => {
    for (let k = 0; k < geo.length; k++) {
      if (k === self) continue;
      const P = geo[k], hw = tun[k].w / 2;
      for (let j = 1; j < P.length; j++) {
        if (tun[k].z[j - 1] > -0.05 && tun[k].z[j] > -0.05) continue;
        const [ax, ay] = P[j - 1], [bx, by] = P[j], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
        const f = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
        if (Math.hypot(x - ax - f * dx, y - ay - f * dy) <= hw + 0.3) return true;
      }
    }
    return deep.some((r) => inside([x, y], grow(r, 1.2)));
  };
  tun.forEach((pc, pi) => {
    const P = geo[pi], n = P.length, hw = pc.w / 2;
    const N: P2[] = P.map((_, j) => {
      const a = P[Math.max(0, j - 1)], b = P[Math.min(n - 1, j + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      return [-dy / l, dx / l];
    });
    const L = (j: number, o: number): P2 => [P[j][0] + N[j][0] * o, P[j][1] + N[j][1] * o];
    for (let j = 1; j < n; j++) {
      const za = pc.z[j - 1], zb = pc.z[j];
      if (za > -0.05 && zb > -0.05) continue;
      const al = L(j - 1, 1), bl = L(j, 1), ar = L(j - 1, -1), br = L(j, -1);
      solid.quad([ar[0], ar[1], za], [br[0], br[1], zb], [bl[0], bl[1], zb], [al[0], al[1], za], M.TFloor);
      const ml = [(al[0] + bl[0]) / 2, (al[1] + bl[1]) / 2], mr = [(ar[0] + br[0]) / 2, (ar[1] + br[1]) / 2];
      const nl = L(j, hw + 0.6), nr = L(j, -hw - 0.6);
      if (!inOpening((ml[0] + nl[0]) / 2, (ml[1] + nl[1]) / 2, pi)) solid.wall(al, bl, za, 0, M.TWall, zb, 0);
      if (!inOpening((mr[0] + nr[0]) / 2, (mr[1] + nr[1]) / 2, pi)) solid.wall(br, ar, zb, 0, M.TWall, za, 0);
      if (pc.cov && za < -4 && zb < -4) glass.quad([ar[0], ar[1], 0.02], [br[0], br[1], 0.02], [bl[0], bl[1], 0.02], [al[0], al[1], 0.02], M.Lid);
    }
  });
}

/**
 * Puentes peatonales (OSM vía el simulador, que calcula su altura: 5,5 m por nivel sobre una calle o la
 * troncal y rampas del 10 % desde cada extremo libre). Tablero de 3 m (2,2 en escaleras y rampas) con su
 * canto, barandas de vidrio de 1,1 m y columnas cada 18 m donde va alto. Los tramos a ras del suelo no se
 * dibujan; las rampas que llegan a un andén terminan a su altura (tools/build_data.py).
 */
export function buildFootbridges(foot: { k: string; z: number[]; c: Float64Array }[], solid: Mesh, glass: Mesh) {
  const EDGE = 0.6, RAIL = 1.1, STEP = 18;
  for (const f of foot) {
    const n = f.c.length / 2;
    if (n < 2) continue;
    const P: P2[] = [];
    for (let i = 0; i < n; i++) P.push([f.c[2 * i] * KX, f.c[2 * i + 1] * KY]);
    const hw = f.k === 'deck' ? 1.5 : 1.1;
    const N: P2[] = P.map((_, j) => {
      const a = P[Math.max(0, j - 1)], b = P[Math.min(n - 1, j + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      return [-dy / l, dx / l];
    });
    const L = (j: number, o: number): P2 => [P[j][0] + N[j][0] * o, P[j][1] + N[j][1] * o];
    let run = STEP / 2;
    for (let j = 1; j < n; j++) {
      const za = f.z[j - 1], zb = f.z[j];
      if (za < 0.15 && zb < 0.15) continue;
      const al = L(j - 1, 1), bl = L(j, 1), ar = L(j - 1, -1), br = L(j, -1);
      const bot = (z: number) => Math.max(0, z - EDGE);
      solid.quad([ar[0], ar[1], za], [br[0], br[1], zb], [bl[0], bl[1], zb], [al[0], al[1], za], M.FDeck);
      solid.quad([al[0], al[1], bot(za)], [bl[0], bl[1], bot(zb)], [br[0], br[1], bot(zb)], [ar[0], ar[1], bot(za)], M.FSide);
      solid.wall(bl, al, bot(zb), zb, M.FSide, bot(za), za);
      solid.wall(ar, br, bot(za), za, M.FSide, bot(zb), zb);
      glass.wall(bl, al, zb, zb + RAIL, M.FRail, za, za + RAIL);
      glass.wall(ar, br, za, za + RAIL, M.FRail, zb, zb + RAIL);
      const seg = Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]);
      run += seg;
      if (run >= STEP && zb - EDGE > 1) {
        run = 0;
        solid.post(P[j], [N[j][1], -N[j][0]], 0.25, 0, zb - EDGE, M.FSide);
      }
    }
  }
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

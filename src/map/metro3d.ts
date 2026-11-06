import { KX, KY, MetricPath } from '../domain/geo';
import { M, Mesh, frame, grow, open, type P2 } from './mesh';

/**
 * Metro de Bogotá, Línea 1, en 3D (vista previa: el proyecto está en obra). Con los datos de la capa
 * del metro (tools/import_metro.py, desde el simulador) y lo que muestran las fotos y boletines
 * públicos de la obra:
 *
 * - viaducto: tablero de 9 m con el riel a 13 m (altura publicada), viga de 1,6 m de canto y almas en
 *   U a los lados (el viaducto se arma con vigas U); rampa desde el patio taller en los primeros 300 m;
 * - pilas: redondas, con capitel que se ensancha bajo el tablero, cada 35 m desde el fin de la rampa.
 *   No hay una capa pública con la ubicación de cada pila; 35 m queda entre las luces que dan las
 *   cifras publicadas de columnas (514 de viaducto en ~21 km, ~41 m; 917 en total, ~29 m);
 * - pórticos: donde la pila caería sobre la troncal (una estación a menos de 10 m o un carril debajo),
 *   dos columnas a los costados de la calzada de TransMilenio con su viga cabezal, como en las
 *   estaciones definitivas de la Caracas: «las columnas del viaducto están a los costados»;
 * - estaciones en tres pisos (planos de la Empresa Metro y fotos de la obra, p. ej. Gibraltar en 2026):
 *   el de ingreso, cerrado y claro (6,5–10,5 m); la losa de la plataforma con los dos andenes laterales
 *   y su antepecho; y la cubierta curva sobre arcos cada ~6 m, con alero y cerramiento de vidrio entre
 *   el antepecho y la cubierta. Bajo el piso de ingreso, columnas a ambos lados cada ~30 m. Edificios
 *   de acceso con su cubierta y puentes peatonales al piso de ingreso.
 *
 * Contornos publicados; alturas de cada piso, canto de la viga, almas, pilas y cubierta: estimadas.
 */
const DECK_Z = 13;
const BEAM = 1.6;
const HALF = 4.5;
const WEB = 1.2;
const WEB_T = 0.3;
const RAMP = 300;
const PIER_STEP = 35;
const PIER_R = 1;
const CAP_H = 1.6;
const PORTAL_BEAM = 2;
const CONC0 = 6.5;
const CONC1 = 10.5;
const PARAPET_Z = DECK_Z + 1.4;
const EAVE = 16.5;
const RISE = 3;
const OVER = 1.5;
const ROOF_T = 0.35;
const RIB_STEP = 6;
const COL_STEP = 30;

type FC = GeoJSON.FeatureCollection;
type Ring = [number, number][];

/** Lo de la troncal que el viaducto debe respetar: carriles (lon, lat) y andenes (metros locales). */
export interface TroncalBelow { lanes: Float64Array[]; platforms: P2[][] }

const deckZ = (s: number) => DECK_Z * Math.max(0, Math.min(1, s / RAMP));

/** Índice de los tramos de carril de la troncal, para cortar una recta transversal. */
class LaneIndex {
  private G = 60;
  private grid = new Map<string, number[]>();
  constructor(lanes: Float64Array[]) {
    for (const c of lanes) {
      for (let i = 2; i < c.length; i += 2) {
        const ax = c[i - 2] * KX, ay = c[i - 1] * KY, bx = c[i] * KX, by = c[i + 1] * KY;
        for (let gx = Math.floor(Math.min(ax, bx) / this.G); gx <= Math.floor(Math.max(ax, bx) / this.G); gx++) {
          for (let gy = Math.floor(Math.min(ay, by) / this.G); gy <= Math.floor(Math.max(ay, by) / this.G); gy++) {
            const k = `${gx}:${gy}`;
            let a = this.grid.get(k);
            if (!a) this.grid.set(k, (a = []));
            a.push(ax, ay, bx, by);
          }
        }
      }
    }
  }
  /** Desplazamientos (m, sobre `v`) donde la recta transversal por `c` corta los carriles, a ≤ `reach` m. */
  cross(c: P2, v: P2, reach: number): number[] {
    const out: number[] = [];
    const seen = new Set<string>();
    for (let gx = Math.floor((c[0] - reach) / this.G); gx <= Math.floor((c[0] + reach) / this.G); gx++) {
      for (let gy = Math.floor((c[1] - reach) / this.G); gy <= Math.floor((c[1] + reach) / this.G); gy++) {
        const a = this.grid.get(`${gx}:${gy}`);
        if (!a) continue;
        for (let i = 0; i < a.length; i += 4) {
          const key = `${a[i]},${a[i + 1]},${a[i + 2]},${a[i + 3]}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // c + v·t = A + (B − A)·f
          const ex = a[i + 2] - a[i], ey = a[i + 3] - a[i + 1];
          const den = v[0] * ey - v[1] * ex;
          if (Math.abs(den) < 1e-9) continue;
          const wx = a[i] - c[0], wy = a[i + 1] - c[1];
          const t = (wx * ey - wy * ex) / den, f = (wx * v[1] - wy * v[0]) / den;
          if (f >= 0 && f <= 1 && Math.abs(t) <= reach) out.push(t);
        }
      }
    }
    return out;
  }
}

/** Lo armado, para revisar: pilas, pórticos (y dónde) y estaciones. */
export interface MetroStats { piers: number; portals: number; stations: number; portalAt: [number, number][] }

export function buildMetro(fc: FC, solid: Mesh, glass: Mesh, below?: TroncalBelow): MetroStats {
  const stats: MetroStats = { piers: 0, portals: 0, stations: 0, portalAt: [] };
  const line = fc.features.find((f) => f.properties?.kind === 'alignment')?.geometry;
  if (!line || line.type !== 'LineString') return stats;
  const flat = new Float64Array(line.coordinates.length * 2);
  line.coordinates.forEach((c, i) => { flat[2 * i] = c[0]; flat[2 * i + 1] = c[1]; });
  const path = new MetricPath(flat);
  const pt = (s: number): P2 => { const p = path.pointAt(s); return [p[0], p[1]]; };
  const dir = (s: number): P2 => { const a = path.headingAt(s, 8); return [Math.cos(a), Math.sin(a)]; };

  // Estaciones: su tramo del trazado (sin pilas ni almas; el tablero lo reemplaza la losa) y su modelo.
  const free: [number, number][] = [];
  const cut: [number, number][] = [];
  for (const f of fc.features) {
    if (f.properties?.kind !== 'station-body' || f.geometry.type !== 'Polygon') continue;
    const ring = open((f.geometry.coordinates[0] as Ring).map(([lo, la]) => [lo * KX, la * KY] as P2));
    if (ring.length < 3) continue;
    let cx = 0, cy = 0;
    for (const p of ring) { cx += p[0]; cy += p[1]; }
    const hit = path.nearest(cx / ring.length, cy / ring.length, Number(f.properties.at_m) || undefined, 400, 400, 80);
    if (!hit) continue;
    const u = dir(hit.s);
    const { c, L, W } = frame(ring, u);
    free.push([hit.s - L / 2 - 2, hit.s + L / 2 + 2]);
    cut.push([hit.s - L / 2 + 0.5, hit.s + L / 2 - 0.5]);
    station(solid, glass, c, u, L, W);
    stats.stations++;
  }
  const inSpan = (spans: [number, number][], s: number) => spans.some(([a, b]) => s >= a && s <= b);

  // Edificios de acceso (con su cubierta) y puentes peatonales al piso de ingreso.
  for (const f of fc.features) {
    if (f.properties?.kind !== 'access' || f.geometry.type !== 'Polygon') continue;
    const ring = open((f.geometry.coordinates[0] as Ring).map(([lo, la]) => [lo * KX, la * KY] as P2));
    const z0 = Number(f.properties.z0) || 0, z1 = Number(f.properties.z1) || 0;
    if (f.properties.sub === 'puente') { solid.prism(ring, z0, z1, M.MBridge, M.MBridge, true); continue; }
    solid.prism(ring, z0, z1, M.MAccess, M.MAccess);
    solid.prism(grow(ring, 0.8), z1, z1 + 0.4, M.MAccess, M.MFrame, true);
  }

  // Viaducto: abscisas en los vértices del trazado, cada 10 m en la rampa y en los bordes de cada estación.
  const S = new Set<number>();
  for (let i = 0; i < path.size; i++) S.add(path.cum[i]);
  for (let s = 0; s <= RAMP; s += 10) S.add(s);
  for (const [a, b] of [...free, ...cut]) { S.add(Math.max(0, a)); S.add(Math.min(path.length, b)); }
  const ss = [...S].filter((s) => s >= 0 && s <= path.length).sort((a, b) => a - b);
  const P = ss.map(pt);
  const N: P2[] = P.map((_, j) => {
    const a = P[Math.max(0, j - 1)], b = P[Math.min(P.length - 1, j + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  });
  const off = (j: number, o: number): P2 => [P[j][0] + N[j][0] * o, P[j][1] + N[j][1] * o];
  for (let j = 1; j < P.length; j++) {
    const za = deckZ(ss[j - 1]), zb = deckZ(ss[j]), mid = (ss[j - 1] + ss[j]) / 2;
    if ((za < 0.05 && zb < 0.05) || inSpan(cut, mid)) continue;
    const ba = Math.max(0, za - BEAM), bb = Math.max(0, zb - BEAM);
    const web = !inSpan(free, mid) && za > 2;
    const h = web ? WEB : 0;
    const al = off(j - 1, HALF), bl = off(j, HALF), ar = off(j - 1, -HALF), br = off(j, -HALF);
    solid.quad([ar[0], ar[1], za], [br[0], br[1], zb], [bl[0], bl[1], zb], [al[0], al[1], za], M.MDeck);
    solid.quad([al[0], al[1], ba], [bl[0], bl[1], bb], [br[0], br[1], bb], [ar[0], ar[1], ba], M.MDeckSide);
    solid.wall(bl, al, bb, zb + h, M.MDeckSide, ba, za + h);
    solid.wall(ar, br, ba, za + h, M.MDeckSide, bb, zb + h);
    if (!web) continue;
    // Almas de la viga en U: cara interior y canto superior.
    const ail = off(j - 1, HALF - WEB_T), bil = off(j, HALF - WEB_T), air = off(j - 1, -HALF + WEB_T), bir = off(j, -HALF + WEB_T);
    solid.wall(ail, bil, za, za + WEB, M.MDeckSide, zb, zb + WEB);
    solid.wall(bir, air, zb, zb + WEB, M.MDeckSide, za, za + WEB);
    solid.quad([ail[0], ail[1], za + WEB], [bil[0], bil[1], zb + WEB], [bl[0], bl[1], zb + WEB], [al[0], al[1], za + WEB], M.MDeck);
    solid.quad([ar[0], ar[1], za + WEB], [br[0], br[1], zb + WEB], [bir[0], bir[1], zb + WEB], [air[0], air[1], za + WEB], M.MDeck);
  }

  // Pilas (o pórticos sobre la troncal).
  const lanes = below?.lanes.length ? new LaneIndex(below.lanes) : null;
  const plats = (below?.platforms ?? []).map((r) => frame(r));
  const nearPlatform = (c: P2) => plats.some((f) => {
    const dx = c[0] - f.c[0], dy = c[1] - f.c[1];
    const a = Math.max(0, Math.abs(dx * f.u[0] + dy * f.u[1]) - f.L / 2), b = Math.max(0, Math.abs(-dx * f.u[1] + dy * f.u[0]) - f.W / 2);
    return Math.hypot(a, b) < 10;
  });
  for (let s = RAMP; s < path.length; s += PIER_STEP) {
    if (inSpan(free, s)) continue;
    const c = pt(s), u = dir(s), v: P2 = [-u[1], u[0]], top = deckZ(s) - BEAM;
    const ts = lanes?.cross(c, v, 18) ?? [];
    if (ts.length && (nearPlatform(c) || ts.some((t) => Math.abs(t) < 3.2))) {
      const t0 = Math.min(...ts) - 3.2, t1 = Math.max(...ts) + 3.2;
      if (t1 - t0 < 34) { portal(solid, c, u, v, t0, t1, top); stats.portals++; stats.portalAt.push([c[0] / KX, c[1] / KY]); continue; }
    }
    solid.cyl(c, PIER_R, 0, top - CAP_H, M.MPier, 12);
    // Capitel: de la sección de la pila a la viga cabezal bajo el tablero.
    solid.loft(Mesh.rect(c, u, PIER_R, PIER_R), top - CAP_H, Mesh.rect(c, u, 1.1, 3.6), top - 0.5, M.MPier, M.MPier);
    solid.box(c, u, 1.1, 3.6, top - 0.5, top, M.MPier, M.MPier);
    stats.piers++;
  }
  return stats;
}

/** Pórtico: dos columnas en los desplazamientos t0 y t1 (sobre `v`) y la viga cabezal bajo el tablero. */
function portal(solid: Mesh, c: P2, u: P2, v: P2, t0: number, t1: number, top: number) {
  const at = (t: number): P2 => [c[0] + v[0] * t, c[1] + v[1] * t];
  for (const t of [t0, t1]) solid.box(at(t), u, 0.8, 0.8, 0, top - PORTAL_BEAM, M.MPier, M.MPier);
  solid.box(at((t0 + t1) / 2), u, 1, (t1 - t0) / 2 + 0.8, top - PORTAL_BEAM, top, M.MPier, M.MPier, true);
}

/** Estación: piso de ingreso, losa con andenes y antepecho, cerramiento de vidrio y cubierta curva. */
function station(solid: Mesh, glass: Mesh, c: P2, u: P2, L: number, W: number) {
  const v: P2 = [-u[1], u[0]];
  const at = (a: number, b: number): P2 => [c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b];
  const hw = W / 2;
  // Columnas bajo el piso de ingreso, a ambos lados.
  const n = Math.max(2, Math.round(L / COL_STEP) + 1);
  for (let i = 0; i < n; i++) {
    const t = -(L / 2 - 0.8) + (i * (L - 1.6)) / (n - 1);
    for (const side of [-1, 1]) solid.box(at(t, side * (hw - 0.8)), u, 0.6, 0.6, 0, CONC0, M.MFrame, M.MFrame);
  }
  // Piso de ingreso y losa de la plataforma.
  solid.box(c, u, L / 2, hw, CONC0, CONC1, M.MConcourse, M.MConcourse, true);
  solid.box(c, u, L / 2, hw, CONC1, DECK_Z - 0.02, M.MDeck, M.MDeckSide);
  // Andenes laterales, de las vías (a 3,5 m del eje) al antepecho.
  const pa = 3.5, pb = Math.max(pa + 3, hw - 0.4);
  for (const side of [-1, 1]) solid.box(at(0, side * (pa + pb) / 2), u, L / 2 - 3, (pb - pa) / 2, DECK_Z - 0.02, DECK_Z + 1.05, M.MPlatform, M.MPlatform);
  for (const side of [-1, 1]) solid.box(at(0, side * (hw - 0.2)), u, L / 2, 0.2, DECK_Z, PARAPET_Z, M.MConcourse, M.MConcourse);
  // Cubierta curva (parábola de alero a cumbrera), con su canto y la cara de abajo, como en las fotos de
  // la obra (Timiza, Avenida Boyacá, Portal Américas): blanca, con un lucernario a lo largo sobre las
  // vías, los extremos redondeados en planta y el alero ondulado entre arco y arco. La franja exterior
  // se arma por tramos a lo largo; las del centro, de una pieza.
  const R = hw + OVER, B = hw, SKY = Math.min(3.5, B * 0.4), NOSE = Math.min(6, R * 0.5);
  const zr = (b: number) => EAVE + RISE * (1 - (b / R) ** 2);
  /** Medio largo de la cubierta a la distancia `b` del eje: extremos redondeados. */
  const H = (b: number) => L / 2 + NOSE * Math.sqrt(Math.max(0, 1 - (b / R) ** 2));
  const ribs = Math.max(2, Math.round(L / RIB_STEP) + 1), bay = L / (ribs - 1);
  const T = (x: P2, z: number): [number, number, number] => [x[0], x[1], z];
  const cuts = [-B, ...[1, 2, 3].map((i) => -B + ((B - SKY) * i) / 4), -SKY, 0, SKY, ...[1, 2, 3].map((i) => SKY + ((B - SKY) * i) / 4), B];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const b0 = cuts[k], b1 = cuts[k + 1], z0 = zr(b0), z1 = zr(b1), h0 = H(b0), h1 = H(b1);
    const sky = b0 >= -SKY - 1e-6 && b1 <= SKY + 1e-6;
    const p = at(-h0, b0), q = at(h0, b0), r = at(h1, b1), w = at(-h1, b1);
    if (sky) { glass.quad(T(p, z0), T(q, z0), T(r, z1), T(w, z1), M.MGlass); continue; }
    solid.quad(T(p, z0), T(q, z0), T(r, z1), T(w, z1), M.MRoof);
    solid.quad(T(w, z1 - ROOF_T), T(r, z1 - ROOF_T), T(q, z0 - ROOF_T), T(p, z0 - ROOF_T), M.MFrame);
    for (const e of [-1, 1]) solid.quad(T(at(e * h0, b0), z0 - ROOF_T), T(at(e * h1, b1), z1 - ROOF_T), T(at(e * h1, b1), z1), T(at(e * h0, b0), z0), M.MFrame);
  }
  // Nervios del lucernario, en cada arco.
  for (let i = 0; i < ribs; i++) {
    const t = -L / 2 + (i * L) / (ribs - 1);
    solid.box(at(t, 0), u, 0.12, SKY, zr(SKY) - ROOF_T, zr(0) + 0.08, M.MFrame, M.MFrame);
  }
  // Franja exterior: en cada arco el alero sale 1,5 m y queda abajo; a mitad de vano se recoge a 0,9 m y
  // sube 0,9 m. Hacia los extremos se recoge con la planta redondeada.
  const Hi = H(B), Ho = H(R);
  const edge = (a: number): [number, number] => {
    const ph = Math.sin((Math.PI * (a + L / 2)) / bay) ** 2;
    const r = hw + OVER - 0.6 * ph;
    return [r, zr(r) + 0.9 * ph];
  };
  const steps = Math.max(8, Math.ceil(((2 * Hi) / bay) * 6));
  for (const side of [-1, 1]) {
    const zb = zr(B);
    for (let i = 0; i < steps; i++) {
      const s0 = -Hi + (2 * Hi * i) / steps, s1 = -Hi + (2 * Hi * (i + 1)) / steps;
      const o0 = (s0 * Ho) / Hi, o1 = (s1 * Ho) / Hi;
      const [r0, e0] = edge(o0), [r1, e1] = edge(o1);
      const ia = at(s0, side * B), ib = at(s1, side * B), oa = at(o0, side * r0), ob = at(o1, side * r1);
      solid.quad(T(ia, zb), T(ib, zb), T(ob, e1), T(oa, e0), M.MRoof);
      solid.quad(T(oa, e0 - ROOF_T), T(ob, e1 - ROOF_T), T(ib, zb - ROOF_T), T(ia, zb - ROOF_T), M.MFrame);
      solid.quad(T(oa, e0 - ROOF_T), T(ob, e1 - ROOF_T), T(ob, e1), T(oa, e0), M.MFrame);
    }
    for (const e of [-1, 1]) {
      const [r, z] = edge(e * Ho);
      solid.quad(T(at(e * Hi, side * B), zb - ROOF_T), T(at(e * Ho, side * r), z - ROOF_T), T(at(e * Ho, side * r), z), T(at(e * Hi, side * B), zb), M.MFrame);
    }
  }
  // Arcos cada ~6 m: del antepecho a la cubierta, en los dos costados.
  const zEdge = zr(hw - 0.2) - ROOF_T;
  for (let i = 0; i < ribs; i++) {
    const t = -L / 2 + (i * L) / (ribs - 1);
    for (const side of [-1, 1]) solid.box(at(t, side * (hw - 0.2)), u, 0.15, 0.25, PARAPET_Z, zEdge, M.MFrame, M.MFrame);
  }
  // Cerramiento de vidrio: costados (del antepecho a la cubierta) y testeros (de la losa a la cubierta).
  for (const side of [-1, 1]) glass.wall(at(-L / 2, side * hw), at(L / 2, side * hw), PARAPET_Z, zr(hw) - ROOF_T, M.MGlass);
  const Kg = 10;
  for (const e of [-L / 2, L / 2]) {
    for (let k = 0; k < Kg; k++) {
      const b0 = -hw + (2 * hw * k) / Kg, b1 = -hw + (2 * hw * (k + 1)) / Kg;
      glass.quad([...at(e, b0), DECK_Z] as [number, number, number], [...at(e, b1), DECK_Z] as [number, number, number], [...at(e, b1), zr(b1) - ROOF_T] as [number, number, number], [...at(e, b0), zr(b0) - ROOF_T] as [number, number, number], M.MGlass);
    }
  }
}

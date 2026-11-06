import { KX, KY, MetricPath } from '../domain/geo';
import { M, Mesh, frame, open, type P2 } from './mesh';

/**
 * Metro de Bogotá, Línea 1, en 3D (vista previa: el proyecto está en obra). Con los datos de la capa
 * del metro (tools/import_metro.py, desde el simulador):
 *
 * - viaducto: tablero de 9 m con el riel a 13 m (altura publicada), viga de 1,6 m de canto y almas en
 *   U a los lados (el viaducto se arma con vigas U); rampa desde el patio taller en los primeros 300 m;
 * - pilas: redondas, con su viga capitel, cada 35 m desde el fin de la rampa. No hay una capa pública
 *   con la ubicación de cada pila; 35 m queda entre las luces que dan las cifras publicadas de
 *   columnas (514 de viaducto en ~21 km, ~41 m; 917 en total, ~29 m). Bajo las estaciones no van:
 *   las sostienen sus propias columnas, a los lados;
 * - estaciones en tres pisos, como en los planos de la Empresa Metro: el de ingreso bajo el tablero
 *   (6,5–10,5 m), la plataforma con dos andenes laterales a la altura del riel y la cubierta a 19,5 m;
 *   fachadas de vidrio, columnas a ambos lados cada ~30 m, y los edificios de acceso y sus puentes.
 *
 * Contornos publicados; alturas de cada piso, canto de la viga, almas y pilas: estimadas.
 */
const DECK_Z = 13;
const BEAM = 1.6;
const HALF = 4.5;
const WEB = 1.2;
const WEB_T = 0.3;
const RAMP = 300;
const PIER_STEP = 35;
const PIER_R = 1;
const CAP_ALONG = 1.3;
const CAP_ACROSS = 3.4;
const CAP_H = 1.4;
const COL_STEP = 30;

type FC = GeoJSON.FeatureCollection;
type Ring = [number, number][];

const deckZ = (s: number) => DECK_Z * Math.max(0, Math.min(1, s / RAMP));

export function buildMetro(fc: FC, solid: Mesh, glass: Mesh) {
  const line = fc.features.find((f) => f.properties?.kind === 'alignment')?.geometry;
  if (!line || line.type !== 'LineString') return;
  const flat = new Float64Array(line.coordinates.length * 2);
  line.coordinates.forEach((c, i) => { flat[2 * i] = c[0]; flat[2 * i + 1] = c[1]; });
  const path = new MetricPath(flat);
  const pt = (s: number): P2 => { const p = path.pointAt(s); return [p[0], p[1]]; };
  const dir = (s: number): P2 => { const a = path.headingAt(s, 8); return [Math.cos(a), Math.sin(a)]; };

  // Estaciones: su tramo del trazado (para quitar pilas y almas) y su marco.
  const spans: [number, number][] = [];
  for (const f of fc.features) {
    if (f.properties?.kind !== 'station-body' || f.geometry.type !== 'Polygon') continue;
    const ring = open((f.geometry.coordinates[0] as Ring).map(([lo, la]) => [lo * KX, la * KY] as P2));
    if (ring.length < 3) continue;
    let cx = 0, cy = 0;
    for (const p of ring) { cx += p[0]; cy += p[1]; }
    const hit = path.nearest(cx / ring.length, cy / ring.length, Number(f.properties.at_m) || undefined, 400, 400, 80);
    if (!hit) continue;
    const u = dir(hit.s), v: P2 = [-u[1], u[0]];
    const { c, L, W } = frame(ring, u);
    spans.push([hit.s - L / 2 - 2, hit.s + L / 2 + 2]);
    const at = (a: number, b: number): P2 => [c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b];
    solid.prism(ring, 6.5, 10.5, M.MConcourse, M.MConcourse, true);
    for (const side of [-1, 1]) solid.box(at(0, side * 5.5), u, (L - 6) / 2, 2, DECK_Z, DECK_Z + 1.05, M.MPlatform, M.MPlatform);
    glass.box(c, u, (L + 2) / 2, (W + 2) / 2, 19.5, 20.2, M.MRoof, M.MRoof, true);
    for (const side of [-1, 1]) {
      glass.box(at(0, side * (W / 2 + 0.9)), u, L / 2, 0.125, 6.5, 19.5, M.MGlass, M.MGlass);
      glass.box(at((side * L) / 2, 0), u, 0.125, (W + 2) / 2, 6.5, 19.5, M.MGlass, M.MGlass);
    }
    const n = Math.max(2, Math.round(L / COL_STEP) + 1);
    for (let i = 0; i < n; i++) {
      const t = -(L / 2 - 0.6) + (i * (L - 1.2)) / (n - 1);
      for (const side of [-1, 1]) solid.box(at(t, side * (W / 2 + 0.4)), u, 0.6, 0.6, 0, 19.6, M.MFrame, M.MFrame);
    }
  }
  const inStation = (s: number) => spans.some(([a, b]) => s >= a && s <= b);

  // Edificios de acceso y puentes peatonales.
  for (const f of fc.features) {
    if (f.properties?.kind !== 'access' || f.geometry.type !== 'Polygon') continue;
    const ring = open((f.geometry.coordinates[0] as Ring).map(([lo, la]) => [lo * KX, la * KY] as P2));
    const bridge = f.properties.sub === 'puente';
    solid.prism(ring, Number(f.properties.z0) || 0, Number(f.properties.z1) || 0, bridge ? M.MBridge : M.MAccess, bridge ? M.MBridge : M.MAccess, bridge);
  }

  // Viaducto: abscisas en los vértices del trazado, cada 10 m en la rampa y en los bordes de cada
  // estación (donde empiezan y terminan las almas).
  const S = new Set<number>();
  for (let i = 0; i < path.size; i++) S.add(path.cum[i]);
  for (let s = 0; s <= RAMP; s += 10) S.add(s);
  for (const [a, b] of spans) { S.add(Math.max(0, a)); S.add(Math.min(path.length, b)); }
  const ss = [...S].filter((s) => s >= 0 && s <= path.length).sort((a, b) => a - b);
  const P = ss.map(pt);
  const N: P2[] = P.map((_, j) => {
    const a = P[Math.max(0, j - 1)], b = P[Math.min(P.length - 1, j + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  });
  const off = (j: number, o: number): P2 => [P[j][0] + N[j][0] * o, P[j][1] + N[j][1] * o];
  for (let j = 1; j < P.length; j++) {
    const za = deckZ(ss[j - 1]), zb = deckZ(ss[j]);
    if (za < 0.05 && zb < 0.05) continue;
    const ba = Math.max(0, za - BEAM), bb = Math.max(0, zb - BEAM);
    const web = !inStation((ss[j - 1] + ss[j]) / 2) && za > 2;
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

  // Pilas con su viga capitel.
  for (let s = RAMP; s < path.length; s += PIER_STEP) {
    if (inStation(s)) continue;
    const c = pt(s), u = dir(s), top = deckZ(s) - BEAM;
    solid.cyl(c, PIER_R, 0, top - CAP_H, M.MPier, 12);
    solid.box(c, u, CAP_ALONG / 2, CAP_ACROSS, top - CAP_H, top, M.MPier, M.MPier, true);
  }
}

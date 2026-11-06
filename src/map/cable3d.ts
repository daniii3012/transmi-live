import cableUrl from '../../data/curated/transmicable.json?url';
import { KX, KY, MetricPath } from '../domain/geo';
import { M, type Mesh, grow, inside, open, type P2 } from './mesh';

/**
 * TransMiCable en 3D (vista 3D): en 2D su trazado son tramos rectos a ras del suelo, y en 3D un cable
 * aéreo dibujado en el suelo no es coherente. Con OSM (tools/import_cable.py): la línea de la góndola,
 * sus torres y el contorno de sus estaciones.
 *
 * - torres de ~25 m con su travesaño (la altura de cada una no está en OSM y el mapa es plano: la cota
 *   es sobre el terreno);
 * - dos cables, uno por sentido, a 3 m del eje y del color de la ruta (en 3D reemplazan su trazo en el
 *   suelo): arriba en cada torre, a ~8 m al entrar a cada estación, y con una catenaria suave entre
 *   apoyos (flecha del 3 % del vano);
 * - estaciones con su contorno (altura de OSM si la trae; si no, 10 m) y cubierta.
 *
 * Solo la línea que llega a las estaciones en servicio (Portal Tunal – Mirador del Paraíso); las
 * estaciones lejos de ella (las de la extensión en obra) no se dibujan.
 */
export interface Cable {
  lines: { id: number; name?: string; points: [number, number][] }[];
  pylons: [number, number][];
  stations: { id: number; name?: string; height: number | null; outline: [number, number][] }[];
}

const TOWER = 25;
const ENTRY = 8;
const WIRE = 3;
const SAG = 0.03;

let data: Promise<Cable> | null = null;
export function loadCable(): Promise<Cable> {
  data ??= fetch(cableUrl).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }).catch((e) => { data = null; throw e; });
  return data;
}

const xy = ([lo, la]: [number, number]): P2 => [lo * KX, la * KY];

export function buildCable(d: Cable, solid: Mesh, _glass: Mesh) {
  const stations = d.stations.map((s) => ({ ...s, ring: open(s.outline.map(xy)) }));
  for (const line of d.lines) {
    const P = line.points.map(xy);
    const flat = new Float64Array(line.points.length * 2);
    line.points.forEach((p, i) => { flat[2 * i] = p[0]; flat[2 * i + 1] = p[1]; });
    const path = new MetricPath(flat);
    // Estaciones de esta línea: las que toca.
    const mine = stations.filter((s) => P.some((p) => inside(p, s.ring) || inside(p, grow(s.ring, 25))));
    if (mine.length < 2) continue;
    // Apoyos sobre el eje: torres (a ≤ 15 m de la línea) y estaciones (su centro).
    const anchors: { s: number; z: number }[] = [];
    for (const t of d.pylons) {
      const q = xy(t), hit = path.nearest(q[0], q[1], undefined, 0, Infinity, 15);
      if (hit && hit.d <= 15) anchors.push({ s: hit.s, z: TOWER });
    }
    for (const st of mine) {
      let cx = 0, cy = 0;
      for (const p of st.ring) { cx += p[0]; cy += p[1]; }
      const hit = path.nearest(cx / st.ring.length, cy / st.ring.length, undefined, 0, Infinity, 80);
      if (hit) anchors.push({ s: hit.s, z: ENTRY });
    }
    anchors.sort((a, b) => a.s - b.s);
    if (anchors.length < 2) continue;
    const zAt = (s: number) => {
      if (s <= anchors[0].s) return anchors[0].z;
      for (let i = 1; i < anchors.length; i++) {
        const a = anchors[i - 1], b = anchors[i];
        if (s > b.s) continue;
        const span = b.s - a.s || 1, u = (s - a.s) / span;
        const sag = Math.min(SAG * span, 0.4 * Math.min(a.z, b.z));
        return a.z + (b.z - a.z) * u - sag * 4 * u * (1 - u);
      }
      return anchors[anchors.length - 1].z;
    };
    // Cables: cintas delgadas (de canto y de plano) cada 6 m.
    const s0 = anchors[0].s, s1 = anchors[anchors.length - 1].s;
    const n = Math.max(2, Math.ceil((s1 - s0) / 6));
    let prev: { p: P2; nrm: P2; z: number } | null = null;
    for (let k = 0; k <= n; k++) {
      const s = s0 + ((s1 - s0) * k) / n;
      const pp = path.pointAt(s), h = path.headingAt(s, 6);
      const cur = { p: [pp[0], pp[1]] as P2, nrm: [-Math.sin(h), Math.cos(h)] as P2, z: zAt(s) };
      if (prev) {
        for (const side of [-1, 1]) {
          const a: P2 = [prev.p[0] + prev.nrm[0] * WIRE * side, prev.p[1] + prev.nrm[1] * WIRE * side];
          const b: P2 = [cur.p[0] + cur.nrm[0] * WIRE * side, cur.p[1] + cur.nrm[1] * WIRE * side];
          solid.wall(a, b, prev.z - 0.25, prev.z, M.Cable, cur.z - 0.25, cur.z);
          const w = 0.12;
          solid.quad([a[0] - prev.nrm[0] * w, a[1] - prev.nrm[1] * w, prev.z], [b[0] - cur.nrm[0] * w, b[1] - cur.nrm[1] * w, cur.z], [b[0] + cur.nrm[0] * w, b[1] + cur.nrm[1] * w, cur.z], [a[0] + prev.nrm[0] * w, a[1] + prev.nrm[1] * w, prev.z], M.Cable);
        }
      }
      prev = cur;
    }
    // Torres con su travesaño.
    for (const t of d.pylons) {
      const q = xy(t), hit = path.nearest(q[0], q[1], undefined, 0, Infinity, 15);
      if (!hit || hit.d > 15) continue;
      const h = path.headingAt(hit.s, 6), u: P2 = [Math.cos(h), Math.sin(h)];
      solid.box(q, u, 0.8, 0.8, 0, TOWER + 0.6, M.MPier, M.MPier);
      solid.box(q, u, 0.5, WIRE + 1, TOWER - 0.4, TOWER + 0.6, M.MPier, M.MPier, true);
    }
    // Estaciones.
    for (const st of mine) {
      const h = st.height ?? 10;
      solid.prism(st.ring, 0, h, M.MConcourse, M.MConcourse);
      solid.prism(grow(st.ring, 0.6), h, h + 0.5, M.MRoof, M.MFrame, true);
    }
  }
}

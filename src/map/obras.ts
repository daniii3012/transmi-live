import type { FilterSpecification, Map as MLMap, GeoJSONSource } from 'maplibre-gl';
import obrasUrl from '../../data/curated/troncales_obra.json?url';
import { KX, KY } from '../domain/geo';
import type { Theme } from '../app/theme';
import { M, type Mesh, type P2 } from './mesh';

/**
 * Modo de obras (H7): las troncales en construcción que ninguna ruta usa todavía (Av. 68, Séptima,
 * Soacha fases II y III, la intersección de Puente Aranda en la Calle 13), apagado por defecto (Capas).
 * Datos: tools/import_obras.py, desde el simulador (trazado de OSM; estado, avance y fuente de cada obra).
 *
 * - En el mapa: el trazado punteado donde falta y continuo donde ya está construido, el contorno de las
 *   áreas (Portal El Vínculo) y un rótulo por obra con su estado y avance.
 * - En 3D (`buildObras`): los tramos con nivel se levantan con el diseño terminado, 5,5 m por nivel y
 *   rampas del 7 % en los extremos libres (la regla del simulador): tablero, barandas y pilas en un
 *   puente; muros de contención en un deprimido. Lo construido, opaco; lo que falta, translúcido.
 *
 * Las estaciones previstas solo tienen nombre en la fuente (no ubicación): no se dibujan.
 */
export interface Way { built: boolean; level?: number; lanes?: number; points: [number, number][] }
export interface Work { id: string; name: string; status?: string; progress_pct?: number | null; opening?: string; notes?: string; source?: string; ways: Way[]; areas: { name?: string; points: [number, number][] }[] }
export interface Works { works: Work[] }

const IDS = ['obras-casing', 'obras-plan', 'obras-built', 'obras-area', 'obras-label'];
/** Grises de cada tema (como el metro): el borde y el halo negros fijos pesaban en el tema claro. */
const THEMES = {
  dark: { casing: '#07090b', line: '#9aa4ae', text: '#a7b0b9', bg: '#101418' },
  light: { casing: '#ffffff', line: '#7d8792', text: '#4a5560', bg: '#e9ecef' },
} as const;
let theme: Theme = 'dark';
let data: Promise<Works> | null = null;
let loaded = false;
const want = { on: false };

export function loadObras(): Promise<Works> {
  data ??= fetch(obrasUrl).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }).catch((e) => { data = null; throw e; });
  return data;
}

/** Nombre corto de la obra: lo que va antes de la coma o el paréntesis. */
export const shortName = (w: Work) => w.name.split(/[,(]/)[0].trim();

function toGeoJSON(d: Works): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const w of d.works) {
    for (const way of w.ways) {
      features.push({ type: 'Feature', properties: { work: w.id, built: way.built }, geometry: { type: 'LineString', coordinates: way.points } });
    }
    for (const a of w.areas) features.push({ type: 'Feature', properties: { work: w.id, kind: 'area' }, geometry: { type: 'LineString', coordinates: a.points } });
    // Rótulo a la mitad del tramo más largo.
    const longest = w.ways.reduce<Way | null>((a, b) => (!a || b.points.length > a.points.length ? b : a), null);
    if (longest) {
      const label = `${shortName(w)} · ${w.status ?? 'en obra'}${w.progress_pct ? ` · ${w.progress_pct} %` : ''}`;
      features.push({ type: 'Feature', properties: { work: w.id, label }, geometry: { type: 'Point', coordinates: longest.points[longest.points.length >> 1] } });
    }
  }
  return { type: 'FeatureCollection', features };
}

export async function setObras(map: MLMap, on: boolean) {
  want.on = on;
  if (on && !loaded) {
    loaded = true;
    let d: Works;
    try { d = await loadObras(); } catch { loaded = false; return; }
    map.addSource('obras', { type: 'geojson', data: toGeoJSON(d) });
    // Los trazados, debajo del recorrido en foco y del plan; los rótulos, encima de los trazados.
    const before = 'route-focus-glow', top = 'street-stops';
    const lines = ['all', ['==', ['geometry-type'], 'LineString'], ['!=', ['get', 'kind'], 'area']] as unknown as FilterSpecification;
    const width = ['interpolate', ['linear'], ['zoom'], 10, 1.4, 16, 3.6] as unknown as number;
    map.addLayer({ id: 'obras-casing', type: 'line', source: 'obras', filter: lines, layout: { 'line-join': 'round' }, paint: { 'line-opacity': 0.7, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.4, 16, 8] } }, before);
    map.addLayer({ id: 'obras-plan', type: 'line', source: 'obras', filter: ['all', lines, ['==', ['get', 'built'], false]] as unknown as FilterSpecification, layout: { 'line-join': 'round' }, paint: { 'line-width': width, 'line-dasharray': [1.6, 1.4] } }, before);
    map.addLayer({ id: 'obras-built', type: 'line', source: 'obras', filter: ['all', lines, ['==', ['get', 'built'], true]] as unknown as FilterSpecification, layout: { 'line-join': 'round' }, paint: { 'line-width': width } }, before);
    map.addLayer({ id: 'obras-area', type: 'line', source: 'obras', filter: ['==', ['get', 'kind'], 'area'], paint: { 'line-width': 1.2, 'line-dasharray': [3, 2] } }, before);
    map.addLayer({
      id: 'obras-label', type: 'symbol', source: 'obras', filter: ['has', 'label'], minzoom: 11,
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-optional': true, 'symbol-placement': 'point' },
      paint: { 'text-halo-width': 1.6 },
    }, top);
    paint(map);
  }
  if (!map.getSource('obras')) return;
  for (const id of IDS) map.setLayoutProperty(id, 'visibility', want.on ? 'visible' : 'none');
}

/** Colores de la capa según el tema (al crearla y al cambiar de tema). */
export function setObrasTheme(map: MLMap, t: Theme) {
  theme = t;
  if (map.getSource('obras')) paint(map);
}

function paint(map: MLMap) {
  const T = THEMES[theme];
  map.setPaintProperty('obras-casing', 'line-color', T.casing);
  for (const id of ['obras-plan', 'obras-built', 'obras-area']) map.setPaintProperty(id, 'line-color', T.line);
  map.setPaintProperty('obras-label', 'text-color', T.text);
  map.setPaintProperty('obras-label', 'text-halo-color', T.bg);
}

export function obrasSource(map: MLMap) { return map.getSource('obras') as GeoJSONSource | undefined; }

const LEVEL = 5.5;
const SLOPE = 0.07;
const DECK = 1.4;
const PARAPET = 0.9;
const PIER_STEP = 30;

/** Alturas por tramo con nivel: rampas en los extremos libres (que no siguen en otro tramo del mismo nivel). */
function levels(ways: Way[]) {
  const key = (p: P2) => `${Math.round(p[0])},${Math.round(p[1])}`;
  const seen = new Map<string, number>();
  const xy = (w: Way) => w.points.map(([lo, la]) => [lo * KX, la * KY] as P2);
  for (const w of ways) if (w.level) for (const p of xy(w)) { const k = `${key(p)}:${w.level}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
  const out: { w: Way; P: P2[]; Z: number[] }[] = [];
  for (const w of ways) {
    if (!w.level) continue;
    const pts = xy(w);
    const P: P2[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
      for (let k = 1; k <= n; k++) P.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const L = cum[cum.length - 1], H = w.level * LEVEL, ramp = Math.min(Math.abs(H) / SLOPE, L / 3);
    const closed = key(pts[0]) === key(pts[pts.length - 1]);
    const free = (p: P2) => !closed && (seen.get(`${key(p)}:${w.level}`) ?? 0) < 2;
    const r0 = free(pts[0]), r1 = free(pts[pts.length - 1]);
    out.push({ w, P, Z: cum.map((s) => H * Math.min(1, r0 ? s / ramp : 1, r1 ? (L - s) / ramp : 1)) });
  }
  return out;
}

export function buildObras(d: Works, solid: Mesh, glass: Mesh) {
  for (const work of d.works) {
    for (const { w, P, Z } of levels(work.ways)) {
      const mesh = w.built ? solid : glass, mat = w.built ? M.OStruct : M.OPlanned;
      const W = (w.lanes ?? 1) * 1.75 + 0.6;
      const N: P2[] = P.map((_, j) => {
        const a = P[Math.max(0, j - 1)], b = P[Math.min(P.length - 1, j + 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
        return [-dy / l, dx / l];
      });
      const at = (j: number, o: number): P2 => [P[j][0] + N[j][0] * o, P[j][1] + N[j][1] * o];
      let since = PIER_STEP / 2;
      for (let j = 1; j < P.length; j++) {
        const za = Z[j - 1], zb = Z[j];
        if (Math.abs(za) < 0.3 && Math.abs(zb) < 0.3) continue;
        const al = at(j - 1, W), bl = at(j, W), ar = at(j - 1, -W), br = at(j, -W);
        mesh.quad([ar[0], ar[1], za], [br[0], br[1], zb], [bl[0], bl[1], zb], [al[0], al[1], za], mat);
        if (za > 0 || zb > 0) {
          // Puente: costados con baranda y pilas.
          const bot = (z: number) => Math.max(0, z - DECK);
          mesh.wall(bl, al, bot(zb), zb + PARAPET, mat, bot(za), za + PARAPET);
          mesh.wall(ar, br, bot(za), za + PARAPET, mat, bot(zb), zb + PARAPET);
          since += Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]);
          if (since >= PIER_STEP && zb > 2.5) {
            since = 0;
            mesh.box(P[j], [N[j][1], -N[j][0]], 0.7, Math.min(W * 0.6, 2), 0, zb - DECK, mat, mat);
          }
        } else {
          // Deprimido: muros de contención del fondo al suelo.
          mesh.wall(bl, al, zb, 0, mat, za, 0);
          mesh.wall(ar, br, za, 0, mat, zb, 0);
        }
      }
    }
  }
}

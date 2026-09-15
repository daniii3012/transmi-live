import type { Map as MLMap, GeoJSONSource, ExpressionSpecification } from 'maplibre-gl';
import type { Network } from '../data/network';
import type { SystemKey } from '../domain/types';

type FC = GeoJSON.FeatureCollection;
const W = (stops: [number, number][]): ExpressionSpecification =>
  ['interpolate', ['exponential', 1.5], ['zoom'], ...stops.flat()] as ExpressionSpecification;

const BG = '#07090b';

/** Mezcla opaca de `color` sobre el fondo. Las líneas translúcidas superpuestas se suman (veinte
 * rutas zonales por calle acaban brillando como una sola opaca); un color ya mezclado no. */
export function mix(color: string, k: number, bg = BG): string {
  const h = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const a = h(color), b = h(bg);
  return '#' + a.map((v, i) => Math.round(b[i] + (v - b[i]) * k).toString(16).padStart(2, '0')).join('');
}
const ZONAL = { alimentador: '#3fbf6f', zonal: '#3d8bfd' };
const zonalColor = (k: number): ExpressionSpecification =>
  ['match', ['get', 'sys'], 'alimentador', mix(ZONAL.alimentador, k), mix(ZONAL.zonal, k)];
/** Orden de dibujo (de abajo hacia arriba): numerados y zonas de tonos grises debajo, para que en
 * los corredores compartidos predomine un color saturado. */
const ZONE_ORDER = 'ZSJPKMELGDCHFBA';

/**
 * Capas de la red: trazados por sistema, estaciones, paraderos y el resaltado de la ruta en foco.
 * La visibilidad por sistema y el atenuado se resuelven con expresiones de pintura, sin rehacer
 * las fuentes.
 */
export class NetworkLayers {
  private focusId: string | null = null;
  private hidden = new Set<SystemKey>();
  private drawAnim = 0;

  constructor(private map: MLMap, private net: Network) {}

  mount() {
    const m = this.map;
    this.addImages();
    m.addSource('routes-zonal', { type: 'geojson', data: empty(), tolerance: 0.6 });
    m.addSource('routes-core', { type: 'geojson', data: this.routesFC(['troncal', 'dual', 'cable']), tolerance: 0.3 });
    m.addSource('route-focus', { type: 'geojson', data: empty(), lineMetrics: true });
    m.addSource('stations', { type: 'geojson', data: this.stationsFC() });
    m.addSource('street-stops', { type: 'geojson', data: empty() });

    m.addLayer({
      id: 'routes-zonal', type: 'line', source: 'routes-zonal',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': zonalColor(0.3), 'line-width': W([[10, 0.4], [13, 0.9], [16, 2], [19, 4]]) },
    });
    m.addLayer({
      id: 'routes-core-casing', type: 'line', source: 'routes-core',
      layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': ['get', 'z'] },
      paint: { 'line-color': BG, 'line-width': W([[10, 2.4], [13, 4], [16, 7], [19, 12]]) },
    });
    m.addLayer({
      id: 'routes-core', type: 'line', source: 'routes-core',
      layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': ['get', 'z'] },
      paint: { 'line-color': ['get', 'color'], 'line-width': W([[10, 1.1], [13, 2], [16, 3.6], [19, 7]]) },
    });
    m.addLayer({
      id: 'route-focus-glow', type: 'line', source: 'route-focus',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': W([[10, 8], [14, 14], [18, 24]]), 'line-blur': W([[10, 6], [18, 14]]), 'line-opacity': 0.28 },
    });
    m.addLayer({
      id: 'route-focus', type: 'line', source: 'route-focus',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-width': W([[10, 2.6], [13, 3.6], [16, 6], [19, 10]]), 'line-gradient': gradient('#ffffff', 1) },
    });
    m.addLayer({
      id: 'street-stops', type: 'circle', source: 'street-stops', minzoom: 15,
      paint: {
        'circle-radius': W([[15, 1.6], [18, 3.5]]),
        'circle-color': '#0c0f12',
        'circle-stroke-color': '#6b8fc7',
        'circle-stroke-width': W([[15, 0.8], [18, 1.4]]),
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.5, 1],
        'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.5, 1],
      },
    });
    m.addLayer({
      id: 'stations', type: 'symbol', source: 'stations', minzoom: 10.5,
      layout: {
        'icon-image': ['case', ['get', 'closed'], 'st-closed', ['==', ['get', 'kind'], 'portal'], 'st-portal', 'st'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10.5, 0.55, 13, 0.8, 16, 1.1, 19, 1.4],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['case', ['==', ['get', 'kind'], 'portal'], 0, 1],
      },
      paint: { 'icon-opacity': ['interpolate', ['linear'], ['zoom'], 10.5, 0, 11, 1] },
    });
    m.addLayer({
      id: 'stations-label', type: 'symbol', source: 'stations', minzoom: 12.5,
      filter: ['any', ['>=', ['zoom'], 13.6], ['==', ['get', 'kind'], 'portal']],
      layout: {
        'text-field': ['get', 'short'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 12.5, 10, 16, 12],
        'text-anchor': 'left',
        'text-offset': [0.9, 0],
        'text-max-width': 9,
        'text-letter-spacing': 0.02,
        'text-optional': true,
        'symbol-sort-key': ['case', ['==', ['get', 'kind'], 'portal'], 0, 1],
      },
      paint: {
        'text-color': ['case', ['get', 'closed'], '#4d5560', '#a3abb5'],
        'text-halo-color': BG, 'text-halo-width': 1.6,
      },
    });
  }

  /** Recorridos de alimentador y zonal: se dibujan cuando llegan. */
  async loadZonal() {
    await this.net.loadZonalShapes();
    (this.map.getSource('routes-zonal') as GeoJSONSource).setData(this.routesFC(['alimentador', 'zonal']));
  }

  async loadStreetStops() {
    await this.net.loadStreetStops();
    const features = [...this.net.streetStops.values()].map((s) => ({
      type: 'Feature' as const, id: Number(s.id) || undefined,
      properties: { id: s.id, name: s.name },
      geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
    }));
    (this.map.getSource('street-stops') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }

  /** Sistemas ocultos por el filtro. */
  setHidden(hidden: Set<SystemKey>) {
    this.hidden = hidden;
    this.applyFilters();
  }

  /** Resalta una ruta (o ninguna) y atenúa el resto. El trazo se dibuja de origen a destino. */
  setFocus(routeId: string | null) {
    if (routeId === this.focusId) return;
    this.focusId = routeId;
    const src = this.map.getSource('route-focus') as GeoJSONSource;
    cancelAnimationFrame(this.drawAnim);
    if (!routeId) {
      src.setData(empty());
      this.applyFilters();
      return;
    }
    const r = this.net.routes.get(routeId);
    const path = this.net.paths.get(routeId);
    if (!r || !path) { src.setData(empty()); this.applyFilters(); return; }
    src.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { color: r.color }, geometry: { type: 'LineString', coordinates: coords(path.lonlat) } }],
    });
    this.applyFilters();
    const t0 = performance.now();
    const dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 900;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      this.map.setPaintProperty('route-focus', 'line-gradient', gradient(r.color, e));
      if (k < 1) this.drawAnim = requestAnimationFrame(step);
    };
    step();
  }

  private applyFilters() {
    const m = this.map;
    const hidden = [...this.hidden];
    const visible: ExpressionSpecification = ['!', ['in', ['get', 'sys'], ['literal', hidden]]];
    m.setFilter('routes-core', visible);
    m.setFilter('routes-core-casing', visible);
    m.setFilter('routes-zonal', visible);
    const f = this.focusId;
    m.setPaintProperty('routes-core', 'line-color', f ? '#252c34' : ['get', 'color']);
    m.setPaintProperty('routes-zonal', 'line-color', zonalColor(f ? 0.12 : 0.3));
  }

  private routesFC(systems: SystemKey[]): FC {
    const features: GeoJSON.Feature[] = [];
    for (const r of this.net.routes.values()) {
      if (!systems.includes(r.sys)) continue;
      const path = this.net.paths.get(r.id);
      if (!path) continue;
      const zi = r.zone ? ZONE_ORDER.indexOf(r.zone) + 1 : 0;
      features.push({
        type: 'Feature',
        properties: { id: r.id, code: r.code, color: r.color, sys: r.sys, z: (r.sys === 'troncal' ? 100 : r.sys === 'dual' ? 50 : 10) + zi },
        geometry: { type: 'LineString', coordinates: coords(path.lonlat) },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  private stationsFC(): FC {
    return {
      type: 'FeatureCollection',
      features: [...this.net.stations.values()].map((s) => ({
        type: 'Feature',
        properties: { id: s.id, short: s.short, kind: s.kind, closed: !!s.closed },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })),
    };
  }

  /** Marcas de estación dibujadas en lienzo: cuadrado claro con borde oscuro; portal más grande;
   * estación sin servicio, hueca. A 2× para pantallas densas. */
  private addImages() {
    const make = (size: number, fill: string, stroke: string, hollow = false) => {
      const px = size * 2;
      const c = new OffscreenCanvas(px, px);
      const g = c.getContext('2d')!;
      g.fillStyle = stroke;
      g.fillRect(0, 0, px, px);
      g.fillStyle = hollow ? stroke : fill;
      g.fillRect(3, 3, px - 6, px - 6);
      if (hollow) {
        g.strokeStyle = fill;
        g.lineWidth = 2;
        g.strokeRect(4, 4, px - 8, px - 8);
      }
      return g.getImageData(0, 0, px, px);
    };
    this.map.addImage('st', make(9, '#dfe3e8', BG), { pixelRatio: 2 });
    this.map.addImage('st-portal', make(13, '#ffffff', BG), { pixelRatio: 2 });
    this.map.addImage('st-closed', make(9, '#4d5560', BG, true), { pixelRatio: 2 });
  }
}

function empty(): FC { return { type: 'FeatureCollection', features: [] }; }

function coords(lonlat: Float64Array): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < lonlat.length; i += 2) out.push([lonlat[i], lonlat[i + 1]]);
  return out;
}

/** Gradiente que dibuja el trazo hasta `p` (0–1): blanco en la punta, el color de la ruta detrás. */
function gradient(color: string, p: number): ExpressionSpecification {
  const q = Math.max(0.001, Math.min(1, p));
  if (q >= 1) return ['interpolate', ['linear'], ['line-progress'], 0, color, 1, color] as ExpressionSpecification;
  const stops: [number, string][] = [[0, color], [q - 0.035, color], [q, '#ffffff'], [q + 0.0005, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0)']];
  const flat: (number | string)[] = [];
  let last = -1;
  for (const [k, c] of stops) {
    if (k <= last || k < 0 || k > 1) continue;
    flat.push(k, c);
    last = k;
  }
  return ['interpolate', ['linear'], ['line-progress'], ...flat] as ExpressionSpecification;
}

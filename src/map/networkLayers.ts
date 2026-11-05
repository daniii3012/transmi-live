import type { Map as MLMap, GeoJSONSource, ExpressionSpecification } from 'maplibre-gl';
import type { Network } from '../data/network';
import type { SystemKey } from '../domain/types';
import palette from '../../data/curated/palette.json';

type FC = GeoJSON.FeatureCollection;
const W = (stops: [number, number][]): ExpressionSpecification =>
  ['interpolate', ['exponential', 1.5], ['zoom'], ...stops.flat()] as ExpressionSpecification;

import type { Theme } from '../app/theme';

/** Colores de la red que dependen del tema (fondo de las mezclas, atenuado, nombres, estaciones). */
const THEMES = {
  dark: { bg: '#101418', dim: '#2a3139', label: '#a7b0b9', labelDim: '#3d4650', closed: '#56606b', station: '#e3e7eb', stopFill: '#161b20', stopStroke: '#7b93b8', light: '#e9ecef', fp: '#3a434d', fpEdge: '#8b96a1', fpBody: '#363e46', fpRoof: '#6a747e' },
  light: { bg: '#e9ecef', dim: '#cfd5db', label: '#4a5560', labelDim: '#b4bbc2', closed: '#a3abb4', station: '#ffffff', stopFill: '#fbfbfc', stopStroke: '#5f7aa3', light: '#12171c', fp: '#ffffff', fpEdge: '#7d8892', fpBody: '#aeb6be', fpRoof: '#dde2e7' },
} as const;
let BG: string = THEMES.dark.bg;

/** Mezcla opaca de `color` sobre el fondo. Las líneas translúcidas superpuestas se suman (veinte
 * rutas zonales por calle acaban brillando como una sola opaca); un color ya mezclado no. */
export function mix(color: string, k: number, bg: string = BG): string {
  const h = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const a = h(color), b = h(bg);
  return '#' + a.map((v, i) => Math.round(b[i] + (v - b[i]) * k).toString(16).padStart(2, '0')).join('');
}
const ZONAL = { alimentador: '#5d9c7b', zonal: '#6f86ab' };
/** Troncal: a escala de ciudad la línea baja a la mitad para que los buses (del mismo color) se lean
 * encima; desde z14, el color pleno. */
const CORE_COLOR: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 11, ['get', 'dcolor'], 14, ['get', 'color']];
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

  private theme: Theme = 'dark';
  /** Recorridos duales de fondo (capa opcional, apagada por defecto). */
  private dual = false;
  setDual(on: boolean) { this.dual = on; this.applyFilters(); }

  constructor(private map: MLMap, private net: Network, theme: Theme = 'dark') {
    this.theme = theme;
    BG = THEMES[theme].bg;
  }

  /** Cambia los colores de la red al tema dado. */
  setTheme(theme: Theme) {
    this.theme = theme;
    const T = THEMES[theme];
    BG = T.bg;
    const m = this.map;
    for (const id of ['routes-core-casing', 'plan-casing']) m.setPaintProperty(id, 'line-color', T.bg);
    (m.getSource('corridors') as GeoJSONSource)?.setData(this.corridorsFC());
    m.setPaintProperty('stations-label', 'text-halo-color', T.bg);
    m.setPaintProperty('stations-label', 'text-color', ['case', ['get', 'closed'], T.closed, ['boolean', ['feature-state', 'dim'], false], T.labelDim, T.label]);
    m.setPaintProperty('street-stops', 'circle-color', T.stopFill);
    m.setPaintProperty('station-fp', 'fill-color', T.fp);
    m.setPaintProperty('station-fp-line', 'line-color', ['case', ['boolean', ['feature-state', 'sel'], false], T.light, T.fpEdge]);
    m.setPaintProperty('station-fp-3d', 'fill-extrusion-color', T.fpBody);
    m.setPaintProperty('station-fp-roof', 'fill-extrusion-color', T.fpRoof);
    m.setPaintProperty('street-stops', 'circle-stroke-color', T.stopStroke);
    m.setPaintProperty('user', 'circle-stroke-color', T.bg);
    m.setPaintProperty('plan-walk', 'line-color', T.light);
    m.setPaintProperty('plan-ends', 'circle-color', ['case', ['get', 'dest'], T.light, T.bg]);
    m.setPaintProperty('plan-ends', 'circle-stroke-color', T.light);
    this.addImages(true);
    // El trazado de dual y cable a escala de ciudad va premezclado con el fondo: se rehace.
    (m.getSource('routes-core') as GeoJSONSource)?.setData(this.routesFC(['troncal', 'dual', 'cable']));
    if (this.net.paths.size > 200) (m.getSource('routes-zonal') as GeoJSONSource)?.setData(this.routesFC(['alimentador', 'zonal']));
    this.applyFilters();
  }

  mount() {
    const m = this.map;
    this.addImages();
    m.addSource('routes-zonal', { type: 'geojson', data: empty(), tolerance: 0.6 });
    m.addSource('routes-core', { type: 'geojson', data: this.routesFC(['troncal', 'dual', 'cable']), tolerance: 0.3 });
    m.addSource('corridors', { type: 'geojson', data: this.corridorsFC(), tolerance: 0.3 });
    m.addSource('route-focus', { type: 'geojson', data: empty(), lineMetrics: true });
    m.addSource('stations', { type: 'geojson', data: this.stationsFC(), promoteId: 'id' });
    m.addSource('station-fp', { type: 'geojson', data: this.footprintsFC(), promoteId: 'id' });
    m.addSource('selected-place', { type: 'geojson', data: empty() });
    m.addSource('user', { type: 'geojson', data: empty() });
    m.addSource('plan', { type: 'geojson', data: empty(), lineMetrics: true });
    m.addSource('street-stops', { type: 'geojson', data: empty() });

    m.addLayer({
      id: 'routes-zonal', type: 'line', source: 'routes-zonal',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': zonalColor(0.3), 'line-width': W([[10, 0.4], [13, 0.9], [16, 2], [19, 4]]) },
    });
    // Corredores troncales (R2): una guía fina y tenue del color de su troncal, sin borde. Marca dónde
    // está la troncal sin competir con los buses; el recorrido de una ruta aparece solo en foco (bus,
    // ruta o viaje). Color premezclado con el fondo: los tramos que se cruzan no se suman.
    // Un eje por corredor, sobre el separador; los tramos en que la troncal va por calle (tráfico
    // mixto), punteados.
    m.addLayer({
      id: 'corridors', type: 'line', source: 'corridors', filter: ['!', ['get', 'street']],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'soft'], 'line-width': W([[10, 1.1], [13, 1.6], [16, 2.2], [19, 2.6]]) },
    });
    m.addLayer({
      id: 'corridors-street', type: 'line', source: 'corridors', filter: ['get', 'street'],
      layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: { 'line-color': ['get', 'soft'], 'line-width': W([[10, 1.1], [13, 1.6], [16, 2.2], [19, 2.6]]), 'line-dasharray': [2, 2] },
    });
    m.addLayer({
      id: 'routes-core-casing', type: 'line', source: 'routes-core',
      layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': ['get', 'z'] },
      paint: { 'line-color': BG, 'line-width': W([[10, 2.2], [13, 3.4], [16, 4.6], [19, 5.4]]) },
    });
    m.addLayer({
      id: 'routes-core', type: 'line', source: 'routes-core',
      layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': ['get', 'z'] },
      paint: { 'line-color': CORE_COLOR, 'line-width': W([[10, 1], [13, 1.6], [16, 2.4], [19, 3]]) },
    });
    m.addLayer({
      id: 'route-focus-glow', type: 'line', source: 'route-focus',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': W([[10, 8], [14, 12], [18, 14]]), 'line-blur': W([[10, 6], [18, 10]]), 'line-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.26, 16, 0.12] },
    });
    m.addLayer({
      id: 'route-focus', type: 'line', source: 'route-focus',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-width': W([[10, 2.6], [13, 3.4], [16, 4], [19, 4.6]]), 'line-gradient': gradient('#ffffff', 1) },
    });
    // Viaje planeado: tramos en bus del color de su ruta, caminatas punteadas, extremos.
    m.addLayer({
      id: 'plan-casing', type: 'line', source: 'plan', filter: ['==', ['get', 'kind'], 'ride'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': BG, 'line-width': W([[10, 6], [14, 8], [18, 9]]) },
    });
    m.addLayer({
      id: 'plan-ride', type: 'line', source: 'plan', filter: ['==', ['get', 'kind'], 'ride'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': W([[10, 3.4], [14, 4.4], [18, 5]]) },
    });
    m.addLayer({
      id: 'plan-walk', type: 'line', source: 'plan', filter: ['==', ['get', 'kind'], 'walk'],
      layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: { 'line-color': '#eceff2', 'line-width': W([[10, 1.6], [16, 2.6]]), 'line-dasharray': [1.2, 1.6] },
    });
    m.addLayer({
      id: 'plan-ends', type: 'circle', source: 'plan', filter: ['==', ['get', 'kind'], 'end'],
      paint: {
        'circle-radius': 5, 'circle-color': ['case', ['get', 'dest'], '#eceff2', BG],
        'circle-stroke-color': '#eceff2', 'circle-stroke-width': 2,
      },
    });
    // En 3D, los edificios tapan las líneas que quedan detrás de ellos: van encima de los trazados y
    // del viaje, debajo de paraderos, estaciones y nombres (orden de capas en DISENO.md).
    m.moveLayer('building-3d');
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
    // Huellas de estación (F7.7): desde z15 la estación es su planta real, entre los carriles; en 3D,
    // cuerpo de vidrio y techo. El cuadro de la estación se desvanece donde hay huella.
    const T0 = THEMES[this.theme];
    const fpOn: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 14.8, 0, 15.6, ['case', ['boolean', ['feature-state', 'dim'], false], 0.35, 1]];
    m.addLayer({
      id: 'station-fp', type: 'fill', source: 'station-fp', minzoom: 14.8,
      paint: { 'fill-color': T0.fp, 'fill-opacity': fpOn },
    });
    m.addLayer({
      id: 'station-fp-line', type: 'line', source: 'station-fp', minzoom: 14.8,
      paint: {
        'line-color': ['case', ['boolean', ['feature-state', 'sel'], false], T0.light, T0.fpEdge],
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 15, ['case', ['boolean', ['feature-state', 'sel'], false], 1.6, 0.6], 18, ['case', ['boolean', ['feature-state', 'sel'], false], 2.4, 1.2]],
        'line-opacity': fpOn,
      },
    });
    m.addLayer({
      id: 'station-fp-3d', type: 'fill-extrusion', source: 'station-fp', minzoom: 14.8, layout: { visibility: 'none' },
      paint: { 'fill-extrusion-color': T0.fpBody, 'fill-extrusion-base': 0, 'fill-extrusion-height': 3.3, 'fill-extrusion-opacity': 0.92 },
    });
    m.addLayer({
      id: 'station-fp-roof', type: 'fill-extrusion', source: 'station-fp', minzoom: 14.8, layout: { visibility: 'none' },
      paint: { 'fill-extrusion-color': T0.fpRoof, 'fill-extrusion-base': 3.3, 'fill-extrusion-height': 3.8, 'fill-extrusion-opacity': 0.96 },
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
      paint: {
        'icon-opacity': ['interpolate', ['linear'], ['zoom'],
          10.5, 0,
          11, ['case', ['boolean', ['feature-state', 'dim'], false], 0.22, 1],
          15.4, ['case', ['boolean', ['feature-state', 'dim'], false], 0.22, 1],
          15.9, ['case', ['get', 'fp'], 0, ['boolean', ['feature-state', 'dim'], false], 0.22, 1]],
      },
    });
    m.addLayer({
      id: 'selected-place', type: 'symbol', source: 'selected-place',
      layout: { 'icon-image': 'sel', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 17, 1.1] },
      paint: { 'icon-opacity': ['interpolate', ['linear'], ['zoom'], 15.2, 1, 15.8, ['case', ['get', 'fp'], 0, 1]] },
    });
    m.addLayer({
      id: 'user-accuracy', type: 'circle', source: 'user',
      paint: {
        'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, ['/', ['get', 'acc'], 76], 20, ['*', ['get', 'acc'], 13]],
        'circle-color': '#eceff2', 'circle-opacity': 0.06, 'circle-stroke-color': '#eceff2', 'circle-stroke-opacity': 0.25, 'circle-stroke-width': 1,
      },
    });
    m.addLayer({
      id: 'user', type: 'circle', source: 'user',
      paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': '#07090b', 'circle-stroke-width': 2.5 },
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
        'text-color': ['case', ['get', 'closed'], '#4d5560', ['boolean', ['feature-state', 'dim'], false], '#3a414a', '#a3abb5'],
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

  /** Marca de selección (escuadras) sobre una estación o paradero; `null` la quita. */
  private selFp: string | null = null;
  setSelectedPlace(id: string | null) {
    const st = id ? this.net.stations.get(id) : undefined;
    const s = st ?? (id ? this.net.streetStops.get(id) : undefined);
    // Estación con huella: se resalta su contorno (desde z15 la escuadra quedaría en medio de una
    // plataforma de 100 m); la escuadra queda para la escala de ciudad y los paraderos.
    if (this.selFp) this.map.setFeatureState({ source: 'station-fp', id: this.selFp }, { sel: false });
    this.selFp = st?.fp ? st.id : null;
    if (this.selFp) this.map.setFeatureState({ source: 'station-fp', id: this.selFp }, { sel: true });
    (this.map.getSource('selected-place') as GeoJSONSource).setData(s
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { fp: !!st?.fp }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } }] }
      : empty());
  }

  setUserLocation(c: [number, number], accuracy: number) {
    (this.map.getSource('user') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { acc: Math.min(accuracy, 500) }, geometry: { type: 'Point', coordinates: c } }],
    });
  }

  private planOn = false;
  private planFull: FC | null = null;
  private planAnim = 0;
  /** Dibuja un viaje (o lo quita con `null`); con viaje, la red se atenúa como con una ruta en foco. */
  setPlan(fc: FC | null) {
    cancelAnimationFrame(this.planAnim);
    this.planFull = fc;
    (this.map.getSource('plan') as GeoJSONSource).setData(fc ?? empty());
    this.planOn = !!fc;
    this.applyFilters();
  }

  /** Recorrido del viaje tramo a tramo, en orden, como si se viajara (R1.15). Las líneas se van
   * revelando cortando su geometría: cada tramo tiene su color y el gradiente de MapLibre no admite
   * colores por elemento. */
  drawPlan(duration = 2200) {
    const full = this.planFull;
    if (!full) return;
    cancelAnimationFrame(this.planAnim);
    const lines = full.features.filter((f) => f.geometry.type === 'LineString') as GeoJSON.Feature<GeoJSON.LineString>[];
    const others = full.features.filter((f) => f.geometry.type !== 'LineString');
    const len = (c: number[][]) => { let s = 0; for (let i = 1; i < c.length; i++) s += Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]); return s; };
    const lens = lines.map((f) => len(f.geometry.coordinates));
    const total = lens.reduce((a, b) => a + b, 0) || 1;
    const t0 = performance.now();
    const dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : duration;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / dur);
      let budget = (1 - Math.pow(1 - k, 2)) * total;
      const shown: GeoJSON.Feature[] = [];
      lines.forEach((f, i) => {
        if (budget <= 0) return;
        const c = f.geometry.coordinates;
        if (budget >= lens[i]) { shown.push(f); budget -= lens[i]; return; }
        const out = [c[0]];
        let acc = 0;
        for (let j = 1; j < c.length && acc < budget; j++) {
          const d = Math.hypot(c[j][0] - c[j - 1][0], c[j][1] - c[j - 1][1]);
          if (acc + d <= budget) out.push(c[j]);
          else { const r = (budget - acc) / d; out.push([c[j - 1][0] + (c[j][0] - c[j - 1][0]) * r, c[j - 1][1] + (c[j][1] - c[j - 1][1]) * r]); }
          acc += d;
        }
        shown.push({ ...f, geometry: { type: 'LineString', coordinates: out } });
        budget = 0;
      });
      (this.map.getSource('plan') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [...shown, ...others] });
      if (k < 1) this.planAnim = requestAnimationFrame(step);
    };
    step();
  }

  /** Sistemas ocultos por el filtro. */
  setHidden(hidden: Set<SystemKey>) {
    this.hidden = hidden;
    this.applyFilters();
  }

  private focusColor = '#ffffff';

  /** Resalta una ruta (o ninguna) y atenúa el resto. El trazo animado lo pide el controlador
   * (`drawFocus`) cuando la cámara llega a la ruta. */
  setFocus(routeId: string | null) {
    if (routeId === this.focusId) return;
    this.focusId = routeId;
    const src = this.map.getSource('route-focus') as GeoJSONSource;
    cancelAnimationFrame(this.drawAnim);
    const r = routeId ? this.net.routes.get(routeId) : undefined;
    const path = routeId ? this.net.paths.get(routeId) : undefined;
    if (!r || !path) {
      src.setData(empty());
      this.applyFilters();
      this.dimStations(null);
      return;
    }
    this.focusColor = r.color;
    src.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { color: r.color }, geometry: { type: 'LineString', coordinates: coords(path.lonlat) } }],
    });
    this.map.setPaintProperty('route-focus', 'line-gradient', gradient(r.color, 1));
    this.applyFilters();
    this.dimStations(r.id);
  }

  /** Trazo de la ruta en foco de origen a destino, con la punta blanca (R1.13). */
  drawFocus(duration = 1600) {
    if (!this.focusId) return;
    cancelAnimationFrame(this.drawAnim);
    const color = this.focusColor;
    const t0 = performance.now();
    const dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : duration;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.map.setPaintProperty('route-focus', 'line-gradient', gradient(color, e));
      if (k < 1) this.drawAnim = requestAnimationFrame(step);
    };
    step();
  }

  /** Con una ruta en foco, las estaciones donde no para se atenúan. */
  private dimStations(routeId: string | null) {
    for (const s of this.net.stations.values()) {
      const dim = !!routeId && !s.routes.includes(routeId);
      this.map.setFeatureState({ source: 'stations', id: s.id }, { dim });
      if (s.fp) this.map.setFeatureState({ source: 'station-fp', id: s.id }, { dim });
    }
  }

  private applyFilters() {
    const m = this.map;
    const hidden = [...this.hidden];
    const visible: ExpressionSpecification = ['!', ['in', ['get', 'sys'], ['literal', hidden]]];
    // La troncal se dibuja como corredores; aquí quedan el cable (siempre, es su propio corredor) y
    // los recorridos duales solo si la persona los pidió en Capas.
    const coreVisible: ExpressionSpecification = ['all', visible, this.dual ? ['!=', ['get', 'sys'], 'troncal'] : ['==', ['get', 'sys'], 'cable']];
    m.setFilter('routes-core', coreVisible);
    m.setFilter('routes-core-casing', coreVisible);
    for (const id of ['corridors', 'corridors-street']) m.setLayoutProperty(id, 'visibility', hidden.includes('troncal') ? 'none' : 'visible');
    m.setFilter('routes-zonal', visible);
    const f = this.focusId || this.planOn;
    const dim = THEMES[this.theme].dim;
    m.setPaintProperty('routes-core', 'line-color', f ? dim : CORE_COLOR);
    for (const id of ['corridors', 'corridors-street']) m.setPaintProperty(id, 'line-color', f ? dim : ['get', 'soft']);
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
        properties: { id: r.id, code: r.code, color: r.color, dcolor: mix(r.color, 0.5), sys: r.sys, z: (r.sys === 'troncal' ? 100 : r.sys === 'dual' ? 50 : 10) + zi },
        geometry: { type: 'LineString', coordinates: coords(path.lonlat) },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  private corridorsFC(): FC {
    const zones = palette.zones as Record<string, { color: string }>;
    return {
      type: 'FeatureCollection',
      features: this.net.corridors.map((s) => ({
        type: 'Feature',
        properties: { z: s.z, street: !!s.street, soft: mix(s.z && zones[s.z] ? zones[s.z].color : '#8b939e', this.theme === 'light' ? 0.5 : 0.55) },
        geometry: { type: 'LineString', coordinates: s.c },
      })),
    };
  }

  private stationsFC(): FC {
    return {
      type: 'FeatureCollection',
      features: [...this.net.stations.values()].map((s) => ({
        type: 'Feature',
        properties: { id: s.id, short: s.short, kind: s.kind, closed: !!s.closed, fp: !!s.fp },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })),
    };
  }

  private footprintsFC(): FC {
    return {
      type: 'FeatureCollection',
      features: [...this.net.stations.values()].filter((s) => s.fp?.length).map((s) => ({
        type: 'Feature',
        properties: { id: s.id, est: s.fpk === 'est', closed: !!s.closed },
        geometry: { type: 'MultiPolygon', coordinates: s.fp!.map((ring) => [ring]) },
      })),
    };
  }

  /** Huellas planas en 2D; con volumen y techo en 3D. */
  set3d(on: boolean) {
    const m = this.map;
    for (const id of ['station-fp', 'station-fp-line']) m.setLayoutProperty(id, 'visibility', on ? 'none' : 'visible');
    for (const id of ['station-fp-3d', 'station-fp-roof']) m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  /** Marcas de estación dibujadas en lienzo: cuadrado claro con borde oscuro; portal más grande;
   * estación sin servicio, hueca. A 2× para pantallas densas. */
  private addImages(replace = false) {
    const T = THEMES[this.theme];
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
    const put = (name: string, img: ImageData) => {
      if (replace && this.map.hasImage(name)) this.map.updateImage(name, img);
      else this.map.addImage(name, img, { pixelRatio: 2 });
    };
    // Estación: cuadro claro con borde del color del fondo (en claro, borde gris para que se vea).
    const edge = this.theme === 'light' ? '#59636e' : BG;
    put('st', make(9, T.station, edge));
    put('st-portal', make(13, T.station, edge));
    put('st-closed', make(9, T.closed, BG, true));
    // Escuadras de selección: cuatro ángulos, el mismo gesto que el bus seleccionado.
    const px = 64, c = new OffscreenCanvas(px, px), g = c.getContext('2d')!;
    g.fillStyle = T.light;
    const arm = 14, th = 3;
    for (const [x, y, sx, sy] of [[0, 0, 1, 1], [px, 0, -1, 1], [0, px, 1, -1], [px, px, -1, -1]]) {
      g.fillRect(sx > 0 ? x : x - arm, sy > 0 ? y : y - th, arm, th);
      g.fillRect(sx > 0 ? x : x - th, sy > 0 ? y : y - arm, th, arm);
    }
    put('sel', g.getImageData(0, 0, px, px));
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

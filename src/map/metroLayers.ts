import type { Map as MLMap, GeoJSONSource } from 'maplibre-gl';
import metroUrl from '../../data/curated/metro_l1.geojson?url';
import type { Theme } from '../app/theme';

/**
 * Metro de Bogotá, Línea 1, como vista previa (hito 7, F7.4). Proyecto en obra: en 2D, el símbolo de
 * ferrocarril (base gris continua con trazos claros) y estaciones huecas; en 3D, el viaducto, sus pilas y
 * las estaciones los dibuja la capa de estructuras (metro3d.ts) con estos mismos datos.
 * Datos: Empresa Metro de Bogotá vía Catastro (CC BY 4.0), curados en el simulador.
 *
 * Sin color propio (aún no tiene servicio: el color es de las rutas) y con los grises de cada tema: el
 * borde y el halo negros de antes se leían pesados en claro y se perdían en oscuro (revisión del 6 nov.).
 * El trazado va encima de los troncales (en la Caracas comparte el eje con la troncal) pero debajo del
 * recorrido en foco y del plan de viaje, que nunca tapa; estaciones y nombres, encima de los trazados.
 */
const IDS = ['metro-depot', 'metro-casing', 'metro-line', 'metro-stations', 'metro-label'];
const THEMES = {
  dark: { base: '#6a7480', dash: '#d3d9df', ring: '#c4cbd2', bg: '#101418', text: '#a7b0b9', depot: '#151a20', depotEdge: '#2a313a' },
  light: { base: '#737d88', dash: '#ffffff', ring: '#59636e', bg: '#e9ecef', text: '#4a5560', depot: '#dde1e5', depotEdge: '#b9c0c7' },
} as const;
let theme: Theme = 'dark';
let loaded = false;
let data: Promise<GeoJSON.FeatureCollection> | null = null;
/** Los datos del metro (una sola descarga para la capa 2D y la 3D). */
export function loadMetro(): Promise<GeoJSON.FeatureCollection> {
  data ??= fetch(metroUrl).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }).catch((e) => { data = null; throw e; });
  return data;
}
/** Último estado pedido: si llega otra orden mientras se descargan los datos, gana la más reciente. */
const want = { on: false, threeD: false };

export async function setMetro(map: MLMap, on: boolean, threeD: boolean) {
  want.on = on;
  want.threeD = threeD;
  if (on && !loaded) {
    loaded = true;
    let fc: GeoJSON.FeatureCollection;
    try { fc = await loadMetro(); } catch { loaded = false; return; }
    map.addSource('metro', { type: 'geojson', data: fc });
    // El patio, debajo de toda la red; el trazado, debajo del recorrido en foco y del plan; estaciones y
    // nombres, encima de los trazados.
    const bottom = 'routes-zonal', before = 'route-focus-glow', top = 'street-stops';
    const kind = (k: string) => ['==', ['get', 'kind'], k] as ['==', ['get', string], string];
    const zoom = (...stops: number[]) => ['interpolate', ['linear'], ['zoom'], ...stops] as unknown as number;
    map.addLayer({ id: 'metro-depot', type: 'fill', source: 'metro', filter: kind('depot') }, bottom);
    map.addLayer({ id: 'metro-casing', type: 'line', source: 'metro', filter: kind('alignment'), layout: { 'line-join': 'round' }, paint: { 'line-width': zoom(10, 2.6, 16, 6.5) } }, before);
    map.addLayer({ id: 'metro-line', type: 'line', source: 'metro', filter: kind('alignment'), layout: { 'line-join': 'round' }, paint: { 'line-width': zoom(10, 1, 16, 2.8), 'line-dasharray': [2, 1.4] } }, before);
    map.addLayer({ id: 'metro-stations', type: 'circle', source: 'metro', filter: kind('station'), paint: { 'circle-radius': zoom(10, 2.5, 16, 6), 'circle-stroke-width': 1.6 } }, top);
    map.addLayer({
      id: 'metro-label', type: 'symbol', source: 'metro', filter: kind('station'), minzoom: 12.5,
      layout: { 'text-field': ['concat', 'Metro · ', ['get', 'name']], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-anchor': 'right', 'text-offset': [-0.9, 0], 'text-optional': true },
      paint: { 'text-halo-width': 1.6 },
    }, top);
    paint(map);
  }
  if (!map.getSource('metro')) return;
  for (const id of IDS) {
    // En 3D el trazado punteado del suelo cede el lugar al viaducto.
    const flat = id === 'metro-line' || id === 'metro-casing';
    const visible = want.on && (flat ? !want.threeD : true);
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

/** Colores de la capa según el tema (al crearla y al cambiar de tema). */
export function setMetroTheme(map: MLMap, t: Theme) {
  theme = t;
  if (map.getSource('metro')) paint(map);
}

function paint(map: MLMap) {
  const T = THEMES[theme];
  map.setPaintProperty('metro-depot', 'fill-color', T.depot);
  map.setPaintProperty('metro-depot', 'fill-outline-color', T.depotEdge);
  map.setPaintProperty('metro-casing', 'line-color', T.base);
  map.setPaintProperty('metro-line', 'line-color', T.dash);
  map.setPaintProperty('metro-stations', 'circle-color', T.bg);
  map.setPaintProperty('metro-stations', 'circle-stroke-color', T.ring);
  map.setPaintProperty('metro-label', 'text-color', T.text);
  map.setPaintProperty('metro-label', 'text-halo-color', T.bg);
}

export function metroSource(map: MLMap) { return map.getSource('metro') as GeoJSONSource | undefined; }

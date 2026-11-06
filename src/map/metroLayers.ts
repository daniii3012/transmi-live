import type { Map as MLMap, GeoJSONSource } from 'maplibre-gl';
import metroUrl from '../../data/curated/metro_l1.geojson?url';

/**
 * Metro de Bogotá, Línea 1, como vista previa (hito 7, F7.4). Proyecto en obra: en 2D, trazado
 * punteado y estaciones huecas; en 3D, el viaducto, sus pilas y las estaciones los dibuja la capa de
 * estructuras (metro3d.ts) con estos mismos datos.
 * Datos: Empresa Metro de Bogotá vía Catastro (CC BY 4.0), curados en el simulador.
 */
const IDS = ['metro-depot', 'metro-casing', 'metro-line', 'metro-stations', 'metro-label'];
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
    const before = 'street-stops';
    const kind = (k: string) => ['==', ['get', 'kind'], k] as ['==', ['get', string], string];
    map.addLayer({ id: 'metro-depot', type: 'fill', source: 'metro', filter: kind('depot'), paint: { 'fill-color': '#151a20', 'fill-outline-color': '#2a313a' } }, before);
    map.addLayer({ id: 'metro-casing', type: 'line', source: 'metro', filter: kind('alignment'), layout: { 'line-join': 'round' }, paint: { 'line-color': '#07090b', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 9] } }, before);
    map.addLayer({ id: 'metro-line', type: 'line', source: 'metro', filter: kind('alignment'), layout: { 'line-join': 'round' }, paint: { 'line-color': '#d9dde3', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 16, 4], 'line-dasharray': [2, 1.4] } }, before);
    map.addLayer({ id: 'metro-stations', type: 'circle', source: 'metro', filter: kind('station'), paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 16, 6], 'circle-color': '#07090b', 'circle-stroke-color': '#d9dde3', 'circle-stroke-width': 2 } }, before);
    map.addLayer({
      id: 'metro-label', type: 'symbol', source: 'metro', filter: kind('station'), minzoom: 12.5,
      layout: { 'text-field': ['concat', 'Metro · ', ['get', 'name']], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-anchor': 'right', 'text-offset': [-0.9, 0], 'text-optional': true },
      paint: { 'text-color': '#c4c9d0', 'text-halo-color': '#07090b', 'text-halo-width': 1.6 },
    });
  }
  if (!map.getSource('metro')) return;
  for (const id of IDS) {
    // En 3D el trazado punteado del suelo cede el lugar al viaducto.
    const flat = id === 'metro-line' || id === 'metro-casing';
    const visible = want.on && (flat ? !want.threeD : true);
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

export function metroSource(map: MLMap) { return map.getSource('metro') as GeoJSONSource | undefined; }

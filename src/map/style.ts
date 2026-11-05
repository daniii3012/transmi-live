import type { StyleSpecification, ExpressionSpecification } from 'maplibre-gl';

/**
 * Estilo base «transmi-dark» sobre el esquema OpenMapTiles.
 *
 * La ciudad queda apagada —manzanas, vías y edificios en grises casi negros— para que el color sea
 * solo de la red. Sin íconos de puntos de interés. Las vías crecen por jerarquía y zoom; los nombres
 * aparecen desde z14 y nunca compiten con las etiquetas de estaciones.
 */

import type { Theme } from '../app/theme';

/** Paletas del mapa base: grafito (oscuro) y gris claro. La red pone el color encima. */
export const PALETTES = {
  dark: {
    bg: '#101418', water: '#0f1c27', waterLine: '#132433', park: '#121a16', wood: '#111915',
    building: '#171c21', buildingLine: '#1e242b', b3dLow: '#191f25', b3dHigh: '#26303a', aeroway: '#1a2026',
    road0: '#1a2026', road1: '#20272e', road2: '#272f37', road3: '#2f3842', road4: '#37414c', rail: '#262e36',
    label: '#68717b', labelMajor: '#7e8791', place: '#525b65', labelHalo: '#101418',
  },
  light: {
    bg: '#e9ecef', water: '#c7d4e0', waterLine: '#b9c9d8', park: '#dde5dc', wood: '#d8e0d6',
    building: '#dfe2e6', buildingLine: '#d3d8dd', b3dLow: '#e2e5e9', b3dHigh: '#d0d6dc', aeroway: '#e0e4e8',
    road0: '#f3f4f6', road1: '#f7f8f9', road2: '#fbfbfc', road3: '#ffffff', road4: '#ffffff', rail: '#c3c9cf',
    label: '#7d8690', labelMajor: '#5f6872', place: '#8a939c', labelHalo: '#e9ecef',
  },
} as const;
type Pal = (typeof PALETTES)['dark'] | (typeof PALETTES)['light'];
let C: Pal = PALETTES.dark;

const line = (stops: [number, number][]): ExpressionSpecification =>
  ['interpolate', ['exponential', 1.6], ['zoom'], ...stops.flat()] as ExpressionSpecification;

const isLine: ExpressionSpecification = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
const isPoly: ExpressionSpecification = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
const cls = (...c: string[]): ExpressionSpecification => ['match', ['get', 'class'], c, true, false];

export const SOURCE_URL = 'https://tiles.openfreemap.org/planet';
export const GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

export function darkStyle(theme: Theme = 'dark'): StyleSpecification {
  C = PALETTES[theme];
  return {
    version: 8,
    name: 'transmi-dark',
    glyphs: GLYPHS_URL,
    sources: {
      omt: {
        type: 'vector',
        url: SOURCE_URL,
        attribution:
          '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · ' +
          '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · ' +
          '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.bg } },
      {
        id: 'landcover-wood', type: 'fill', source: 'omt', 'source-layer': 'landcover',
        filter: cls('wood', 'forest'), paint: { 'fill-color': C.wood },
      },
      {
        id: 'landuse-park', type: 'fill', source: 'omt', 'source-layer': 'park',
        paint: { 'fill-color': C.park },
      },
      {
        id: 'landcover-grass', type: 'fill', source: 'omt', 'source-layer': 'landcover',
        filter: cls('grass'), paint: { 'fill-color': C.park, 'fill-opacity': 0.7 },
      },
      {
        id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'], paint: { 'fill-color': C.water },
      },
      {
        id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 12,
        filter: isLine,
        paint: { 'line-color': C.waterLine, 'line-width': line([[12, 0.5], [16, 2], [19, 5]]) },
      },
      {
        id: 'aeroway', type: 'fill', source: 'omt', 'source-layer': 'aeroway', minzoom: 11,
        filter: isPoly, paint: { 'fill-color': C.aeroway },
      },
      {
        id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 14,
        paint: {
          'fill-color': C.building,
          'fill-outline-color': C.buildingLine,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1],
        },
      },
      {
        // Edificios en 3D: solo con la vista inclinada (se encienden desde el controlador). Tono del
        // mapa base, apenas más claro arriba, para dar volumen sin competir con la red.
        id: 'building-3d', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 14.5,
        layout: { visibility: 'none' },
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, C.b3dLow, 60, C.b3dHigh],
          // Los edificios de OSM que son la estación misma no se levantan: la estación propia (huella,
          // cuerpo y techo) va en su lugar (F7.7; ver stationBuildings.ts).
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15.5, ['case', ['boolean', ['feature-state', 'station'], false], 0, ['coalesce', ['get', 'render_height'], 6]]],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.92,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      {
        id: 'road-path', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 15,
        filter: ['all', isLine, cls('path', 'track')],
        paint: { 'line-color': C.road0, 'line-width': line([[15, 0.5], [19, 2]]), 'line-dasharray': [2, 2] },
      },
      {
        id: 'road-service', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 14,
        filter: ['all', isLine, cls('service')],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.road0, 'line-width': line([[14, 0.5], [16, 2], [19, 8]]) },
      },
      {
        id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12,
        filter: ['all', isLine, cls('minor')],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.road1,
          'line-width': line([[12, 0.4], [14, 1.2], [16, 4], [19, 18]]),
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 14, 1],
        },
      },
      {
        id: 'road-tertiary', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 11,
        filter: ['all', isLine, cls('tertiary')],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.road2, 'line-width': line([[11, 0.5], [14, 2], [16, 6], [19, 24]]) },
      },
      {
        id: 'road-secondary', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 9,
        filter: ['all', isLine, cls('secondary', 'primary')],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.road3, 'line-width': line([[9, 0.4], [12, 1.4], [14, 3], [16, 8], [19, 30]]) },
      },
      {
        id: 'road-trunk', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 8,
        filter: ['all', isLine, cls('trunk', 'motorway', 'busway')],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.road4, 'line-width': line([[8, 0.6], [12, 2], [14, 4], [16, 10], [19, 36]]) },
      },
      {
        id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12,
        filter: ['all', isLine, cls('rail', 'transit')],
        paint: { 'line-color': C.rail, 'line-width': line([[12, 0.6], [16, 1.6]]), 'line-dasharray': [3, 3] },
      },
      {
        id: 'road-name', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 14,
        filter: ['all', isLine, ['!', cls('path', 'track', 'service')]],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['coalesce', ['get', 'name:es'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 18, 12],
          'text-letter-spacing': 0.04,
          'text-max-angle': 30,
          'symbol-spacing': 320,
        },
        paint: { 'text-color': C.label, 'text-halo-color': C.labelHalo, 'text-halo-width': 1.4 },
      },
      {
        id: 'place-neighbourhood', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 13, maxzoom: 17,
        filter: cls('neighbourhood', 'quarter', 'suburb'),
        layout: {
          'text-field': ['coalesce', ['get', 'name:es'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 12],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.12,
          'text-max-width': 8,
        },
        paint: { 'text-color': C.place, 'text-halo-color': C.labelHalo, 'text-halo-width': 1.2 },
      },
      {
        id: 'place-town', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 9, maxzoom: 14,
        filter: cls('town', 'village', 'city'),
        layout: {
          'text-field': ['coalesce', ['get', 'name:es'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 13, 13],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.16,
        },
        paint: { 'text-color': C.labelMajor, 'text-halo-color': C.labelHalo, 'text-halo-width': 1.2 },
      },
    ],
  };
}

/** Cambia los colores del mapa base en el lugar, sin recargar el estilo (las capas propias siguen). */
export function applyBaseTheme(map: import('maplibre-gl').Map, theme: Theme) {
  const P = PALETTES[theme];
  const set = (id: string, prop: string, v: unknown) => { if (map.getLayer(id)) map.setPaintProperty(id, prop as never, v as never); };
  set('bg', 'background-color', P.bg);
  set('landcover-wood', 'fill-color', P.wood);
  set('landuse-park', 'fill-color', P.park);
  set('landcover-grass', 'fill-color', P.park);
  set('water', 'fill-color', P.water);
  set('waterway', 'line-color', P.waterLine);
  set('aeroway', 'fill-color', P.aeroway);
  set('building', 'fill-color', P.building);
  set('building', 'fill-outline-color', P.buildingLine);
  set('building-3d', 'fill-extrusion-color', ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, P.b3dLow, 60, P.b3dHigh]);
  set('road-path', 'line-color', P.road0);
  set('road-service', 'line-color', P.road0);
  set('road-minor', 'line-color', P.road1);
  set('road-tertiary', 'line-color', P.road2);
  set('road-secondary', 'line-color', P.road3);
  set('road-trunk', 'line-color', P.road4);
  set('rail', 'line-color', P.rail);
  for (const id of ['road-name', 'place-neighbourhood', 'place-town']) set(id, 'text-halo-color', P.labelHalo);
  set('road-name', 'text-color', P.label);
  set('place-neighbourhood', 'text-color', P.place);
  set('place-town', 'text-color', P.labelMajor);
}

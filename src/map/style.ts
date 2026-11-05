import type { StyleSpecification, ExpressionSpecification } from 'maplibre-gl';

/**
 * Estilo base «transmi-dark» sobre el esquema OpenMapTiles.
 *
 * La ciudad queda apagada —manzanas, vías y edificios en grises casi negros— para que el color sea
 * solo de la red. Sin íconos de puntos de interés. Las vías crecen por jerarquía y zoom; los nombres
 * aparecen desde z14 y nunca compiten con las etiquetas de estaciones.
 */

const C = {
  bg: '#07090b',
  land: '#090c0f',
  water: '#0a141d',
  waterLine: '#0e1b27',
  park: '#0a110e',
  wood: '#0a100d',
  building: '#0f1317',
  buildingLine: '#151a20',
  aeroway: '#12171c',
  road0: '#13181d', // servicio, sendero
  road1: '#181e24', // local
  road2: '#1f262d', // terciaria
  road3: '#262e37', // secundaria, primaria
  road4: '#2d3640', // troncal urbana, autopista
  rail: '#1d242b',
  label: '#5a636d',
  labelMajor: '#6f7882',
  labelHalo: '#07090b',
} as const;

const line = (stops: [number, number][]): ExpressionSpecification =>
  ['interpolate', ['exponential', 1.6], ['zoom'], ...stops.flat()] as ExpressionSpecification;

const isLine: ExpressionSpecification = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
const isPoly: ExpressionSpecification = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
const cls = (...c: string[]): ExpressionSpecification => ['match', ['get', 'class'], c, true, false];

export const SOURCE_URL = 'https://tiles.openfreemap.org/planet';
export const GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

export function darkStyle(): StyleSpecification {
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
          'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#11161b', 60, '#1a2129'],
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15.5, ['coalesce', ['get', 'render_height'], 6]],
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
        paint: { 'text-color': '#454d56', 'text-halo-color': C.labelHalo, 'text-halo-width': 1.2 },
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

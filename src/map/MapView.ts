import { Map as MLMap, AttributionControl, setWorkerUrl, type LngLatBoundsLike } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { darkStyle } from './style';
import { loadPrefs } from '../app/store.svelte';

setWorkerUrl(workerUrl);

/** Bogotá y la sabana cercana: el mapa no se aleja de aquí. */
/** Límites amplios: con la hoja inferior a media altura, el borde de la ciudad tiene que poder subir
 * hasta la parte visible del mapa (revisión R1.4). */
export const BOUNDS: LngLatBoundsLike = [[-74.75, 4.1], [-73.55, 5.2]];
export const HOME = { center: [-74.098, 4.651] as [number, number], zoom: 11.1 };

export class MapView {
  readonly map: MLMap;
  /** ¿Se abrió con la cámara guardada? */
  readonly restored: boolean;

  constructor(container: HTMLElement, theme: import('../app/theme').Theme = 'dark') {
    const narrow = container.clientWidth < 720;
    // Cámara guardada: al volver a la aplicación (o si el navegador descartó la pestaña) se sigue
    // viendo lo mismo, sin volver a la vista general (R1.1).
    const cam = loadPrefs().camera;
    const fresh = cam && Date.now() - cam.at < 12 * 3600 * 1000;
    this.restored = !!fresh;
    this.map = new MLMap({
      container,
      style: darkStyle(theme),
      center: fresh ? cam!.center : HOME.center,
      zoom: fresh ? cam!.zoom : narrow ? HOME.zoom - 0.7 : HOME.zoom,
      bearing: fresh ? cam!.bearing : 0,
      pitch: fresh ? cam!.pitch : 0,
      // En móvil, densidad de píxeles hasta 2: el mapa se ve igual de nítido y el teléfono trabaja
      // la mitad (R1.17).
      pixelRatio: matchMedia('(pointer: coarse)').matches ? Math.min(2, devicePixelRatio || 1) : devicePixelRatio || 1,
      minZoom: 9.5,
      maxZoom: 19.5,
      maxBounds: BOUNDS,
      attributionControl: false,
      pitchWithRotate: true,
      maxPitch: 70,
      dragRotate: true,
      fadeDuration: 150,
      canvasContextAttributes: { antialias: true, powerPreference: 'high-performance' },
    });
    this.map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
    this.map.touchZoomRotate.enableRotation();
  }

  ready(): Promise<void> {
    return this.map.loaded() ? Promise.resolve() : new Promise((r) => this.map.once('load', () => r()));
  }
}

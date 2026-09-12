import { Map as MLMap, AttributionControl, setWorkerUrl, type LngLatBoundsLike } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { darkStyle } from './style';

setWorkerUrl(workerUrl);

/** Bogotá y la sabana cercana: el mapa no se aleja de aquí. */
export const BOUNDS: LngLatBoundsLike = [[-74.42, 4.36], [-73.86, 4.95]];
export const HOME = { center: [-74.098, 4.651] as [number, number], zoom: 11.1 };

export class MapView {
  readonly map: MLMap;

  constructor(container: HTMLElement) {
    const narrow = container.clientWidth < 720;
    this.map = new MLMap({
      container,
      style: darkStyle(),
      center: HOME.center,
      zoom: narrow ? HOME.zoom - 0.7 : HOME.zoom,
      minZoom: 9.5,
      maxZoom: 19.5,
      maxBounds: BOUNDS,
      attributionControl: false,
      pitchWithRotate: true,
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

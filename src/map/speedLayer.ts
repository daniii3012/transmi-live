import type { Map as MLMap, GeoJSONSource, ExpressionSpecification } from 'maplibre-gl';
import type { Network } from '../data/network';
import type { Fleet } from '../live/fleet';
import { KX, KY } from '../domain/geo';
import type { Theme } from '../app/theme';

/**
 * Capa «Velocidad en la troncal» (opcional, apagada por defecto): cada eje de corredor partido en
 * tramos de ~250 m, con la velocidad de los buses troncales y duales que pasan por él (sin contar los
 * que están en una estación: ahí paran siempre), suavizada en el tiempo. Solo el trancón resalta (rojo → naranja); lo fluido queda en gris neutro, para no competir
 * con el color de las rutas. Sin buses recientes en un tramo, no se dibuja.
 */
const BIN_M = 250;
/** Lecturas a menos de esto de una estación no cuentan: el bus está parado recogiendo pasajeros. */
const STATION_M = 70;
const NEAR_M = 35;
const FORGET_MS = 10 * 60_000;
const G = 60;

interface Bin { coords: [number, number][]; v: number | null; seen: number; n: number }

export class SpeedLayer {
  private bins: Bin[] = [];
  private grid = new Map<string, { bin: number; x: number; y: number }[]>();
  private on = false;
  private map: MLMap;
  private fleet: Fleet;
  private stations: [number, number][] = [];
  private portals: [number, number][] = [];

  constructor(map: MLMap, net: Network, fleet: Fleet) {
    this.map = map;
    this.fleet = fleet;
    for (const s of net.stations.values()) {
      this.stations.push([s.lon * KX, s.lat * KY]);
      if (s.kind === 'portal') this.portals.push([s.lon * KX, s.lat * KY]);
    }
    for (const seg of net.corridors) {
      if (seg.street) continue;
      const pts = seg.c.map(([lo, la]) => [lo * KX, la * KY] as [number, number]);
      let cur: [number, number][] = [seg.c[0]];
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
        const l = Math.hypot(bx - ax, by - ay);
        // Puntos de muestra cada ~10 m para ubicar los buses en el tramo.
        const n = Math.max(1, Math.round(l / 10));
        for (let k = 1; k <= n; k++) {
          const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
          const key = `${Math.floor(x / G)},${Math.floor(y / G)}`;
          let cell = this.grid.get(key);
          if (!cell) this.grid.set(key, (cell = []));
          cell.push({ bin: this.bins.length, x, y });
        }
        cur.push(seg.c[i]);
        acc += l;
        if (acc >= BIN_M || i === pts.length - 1) {
          this.bins.push({ coords: cur, v: null, seen: 0, n: 0 });
          cur = [seg.c[i]];
          acc = 0;
        }
      }
    }
  }

  mount(theme: Theme) {
    const m = this.map;
    m.addSource('speed', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    m.addLayer({
      id: 'speed', type: 'line', source: 'speed', layout: { visibility: 'none', 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': this.color(theme), 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 3, 14, 5, 18, 7] },
    }, m.getLayer('station-fp') ? 'station-fp' : undefined);
  }

  /** Rojo para lo lento, gris para lo fluido (km/h). */
  private color(theme: Theme): ExpressionSpecification {
    const fluid = theme === 'light' ? '#b9c0c7' : '#5b6570';
    return ['interpolate', ['linear'], ['get', 'v'], 5, '#ff3b2f', 10, '#ff8a3d', 15, '#e8b46a', 20, fluid];
  }

  setTheme(theme: Theme) { if (this.map.getLayer('speed')) this.map.setPaintProperty('speed', 'line-color', this.color(theme)); }

  /** Tramo más lento con dato reciente y al menos `minBuses` buses en la última lectura (para «Ahora» y
   * el recorrido): su punto medio (lon, lat) y la velocidad media (km/h). */
  slowest(now = Date.now(), minBuses = 3): { lon: number; lat: number; v: number; n: number } | null {
    let best: Bin | null = null;
    for (const bin of this.bins) {
      if (bin.v == null || bin.v < 1 || now - bin.seen > 5 * 60_000 || bin.n < minBuses) continue;
      // Junto a un portal los buses esperan o se estacionan: eso no es trancón.
      const [lo, la] = bin.coords[Math.floor(bin.coords.length / 2)];
      const x = lo * KX, y = la * KY;
      if (this.portals.some(([px, py]) => (px - x) ** 2 + (py - y) ** 2 < 300 * 300)) continue;
      if (!best || bin.v < best.v!) best = bin;
    }
    if (!best) return null;
    const [lon, lat] = best.coords[Math.floor(best.coords.length / 2)];
    return { lon, lat, v: best.v!, n: best.n };
  }

  /** Tramos con dato en la última actualización: sin ellos, la flota no se atenúa (sería un mapa vacío). */
  private shown = 0;
  setVisible(on: boolean) {
    this.on = on;
    this.fleet.allDim = on && this.shown > 0;
    this.map.triggerRepaint();
    if (this.map.getLayer('speed')) this.map.setLayoutProperty('speed', 'visibility', on ? 'visible' : 'none');
    if (on) this.update();
  }

  /** Con cada lectura nueva: ubica los buses en su tramo y actualiza el promedio suavizado. */
  update(now = Date.now()) {
    const sum = new Map<number, { s: number; n: number }>();
    for (const b of this.fleet.buses.values()) {
      if ((b.sys !== 'troncal' && b.sys !== 'dual') || b.speed == null || b.age > 90 || !b.onPath) continue;
      // La lectura misma (no la posición animada, que fuera de la vista no se calcula).
      const bx = b.fixX, by = b.fixY;
      if (this.stations.some(([sx, sy]) => (sx - bx) ** 2 + (sy - by) ** 2 < STATION_M * STATION_M)) continue;
      const gx = Math.floor(bx / G), gy = Math.floor(by / G);
      let best = -1, bd = NEAR_M * NEAR_M;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const p of this.grid.get(`${gx + i},${gy + j}`) ?? []) {
          const d = (p.x - bx) ** 2 + (p.y - by) ** 2;
          if (d < bd) { bd = d; best = p.bin; }
        }
      }
      if (best < 0) continue;
      const a = sum.get(best) ?? { s: 0, n: 0 };
      a.s += b.speed * 3.6;
      a.n++;
      sum.set(best, a);
    }
    for (const [i, a] of sum) {
      const bin = this.bins[i];
      const v = a.s / a.n;
      bin.v = bin.v == null ? v : bin.v * 0.6 + v * 0.4;
      bin.seen = now;
      bin.n = a.n;
    }
    if (!this.on) return;
    const features: GeoJSON.Feature[] = [];
    for (const bin of this.bins) {
      if (bin.v == null || now - bin.seen > FORGET_MS) continue;
      features.push({ type: 'Feature', properties: { v: Math.round(bin.v) }, geometry: { type: 'LineString', coordinates: bin.coords } });
    }
    (this.map.getSource('speed') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features });
    this.shown = features.length;
    const dim = features.length > 0;
    if (this.fleet.allDim !== dim) { this.fleet.allDim = dim; this.map.triggerRepaint(); }
  }
}

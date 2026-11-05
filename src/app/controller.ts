import type { Map as MLMap, MapMouseEvent, PaddingOptions } from 'maplibre-gl';
import type { Network } from '../data/network';
import type { Fleet, Bus } from '../live/fleet';
import { mercator } from '../live/fleet';
import type { NetworkLayers } from '../map/networkLayers';
import type { BusLayer } from '../map/busLayer';
import { Poller } from '../live/poller';
import { apiBase } from '../live/api';
import { fetchAlerts } from '../live/alerts';
import { KX, KY } from '../domain/geo';
import type { SystemKey } from '../domain/types';
import { app } from './store.svelte';
import { go, parse, type View } from './router';

export const PANEL_W = 380;

/**
 * Conecta el mapa, la flota y la interfaz: selección por toque, vistas por URL, cámara y
 * seguimiento. La interfaz solo lee `app`; el mapa solo recibe órdenes de aquí.
 */
export class Controller {
  private poller: Poller;
  private followRaf = 0;
  private clock = 0;
  private flying = false;
  private alertsTimer = 0;

  constructor(private map: MLMap, private net: Network, private fleet: Fleet, private layers: NetworkLayers, private buses: BusLayer) {
    this.poller = new Poller(apiBase(), (d) => this.onData(d), (s) => (app.poll = s));
  }

  start() {
    const m = this.map;
    m.on('click', (e) => this.onClick(e));
    m.on('mousemove', (e) => this.onHover(e));
    m.on('mouseout', () => { this.fleet.hoverId = null; m.getCanvas().style.cursor = ''; m.triggerRepaint(); });
    m.on('dragstart', () => this.stopFollow());
    m.on('rotatestart', (e) => { if ((e as { originalEvent?: Event }).originalEvent) this.stopFollow(); });
    addEventListener('hashchange', () => this.apply(parse()));
    addEventListener('resize', () => (app.narrow = innerWidth < 760));
    this.clock = window.setInterval(() => (app.now = Date.now()), 1000);
    this.poller.start();
    const alerts = async () => { if (!document.hidden) { const a = await fetchAlerts(apiBase()); if (a) app.alerts = a; } };
    void alerts();
    this.alertsTimer = window.setInterval(alerts, 60_000);
    this.apply(app.view, true);
  }

  stop() {
    this.poller.stop();
    clearInterval(this.clock);
    clearInterval(this.alertsTimer);
    cancelAnimationFrame(this.followRaf);
  }

  /** Filtro por sistema: buses y trazados. */
  setHidden(list: SystemKey[]) {
    this.fleet.hidden = new Set(list);
    this.layers.setHidden(this.fleet.hidden);
    this.map.triggerRepaint();
  }

  /** Refrescar ya (al volver a la pestaña o desde la interfaz). */
  refresh() { this.poller.now(); }

  private onData(d: Parameters<Fleet['ingest']>[0]) {
    this.fleet.ingest(d);
    app.counts = this.fleet.counts();
    app.version++;
    const n = Object.values(app.counts).reduce((a, b) => a + b, 0);
    if (!app.pulse.length || app.pulse[app.pulse.length - 1].t !== d.t) {
      app.pulse = [...app.pulse.filter((p) => d.t - p.t <= 7200), { t: d.t, n }];
    }
    this.map.triggerRepaint();
    // Un bus seleccionado que desaparece del alimentador: se informa en su ficha, no se cierra.
  }

  // ── Vistas ─────────────────────────────────────────────────────────────────────────────────
  apply(v: View, initial = false) {
    app.view = v;
    const f = this.fleet;
    f.selectedId = null;
    let focus: string | null = null;
    let station: string | null = null;
    if (v.kind === 'route') focus = v.id;
    if (v.kind === 'bus') {
      f.selectedId = v.id;
      focus = f.buses.get(v.id)?.routeId ?? null;
    }
    if (v.kind === 'station') station = v.id;
    if (v.kind === 'stop') station = v.id;
    f.focusRoute = focus;
    this.layers.setFocus(focus);
    // Ruta zonal sin su recorrido todavía (llega después del arranque): se espera y se repite.
    if (focus && !this.net.paths.has(focus)) {
      void this.net.loadZonalShapes().then(() => { if (this.fleet.focusRoute === focus) { this.layers.setFocus(null); this.layers.setFocus(focus); this.frame(v); } });
    }
    this.layers.setSelectedPlace(station);
    if (v.kind !== 'bus') this.stopFollow();
    if (v.kind !== 'plan') this.showJourney(null, null, null);
    if (v.kind === 'plan') void this.net.loadPatterns().then(() => (app.patternsReady = true));
    this.map.triggerRepaint();
    if (v.kind === 'route' || v.kind === 'bus' || v.kind === 'station') void this.net.loadPatterns().then(() => (app.patternsReady = true));
    if (v.kind === 'stop') void this.net.loadStreetStops().then(() => this.frame(v, initial));
    // En móvil la hoja cambia de altura con la vista: se encuadra cuando ya tiene la nueva.
    if (app.narrow) setTimeout(() => this.frame(v, initial), initial ? 120 : 40);
    else this.frame(v, initial);
    if (v.kind === 'bus') this.startFollow();
  }

  /** Lleva la cámara a lo seleccionado, dejando libre el espacio del panel. */
  frame(v: View, initial = false) {
    const m = this.map;
    const padding = this.padding(48);
    const opts = { padding, duration: initial ? 0 : 900, essential: true };
    if (v.kind === 'route') {
      const p = this.net.paths.get(v.id);
      if (!p) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < p.lonlat.length; i += 2) {
        x0 = Math.min(x0, p.lonlat[i]); x1 = Math.max(x1, p.lonlat[i]);
        y0 = Math.min(y0, p.lonlat[i + 1]); y1 = Math.max(y1, p.lonlat[i + 1]);
      }
      m.fitBounds([[x0, y0], [x1, y1]], { ...opts, maxZoom: 15.5 });
    } else if (v.kind === 'station') {
      const s = this.net.stations.get(v.id);
      if (s) this.flyTo([s.lon, s.lat], Math.max(m.getZoom(), 16), opts);
    } else if (v.kind === 'stop') {
      const s = this.net.streetStops.get(v.id);
      if (s) this.flyTo([s.lon, s.lat], Math.max(m.getZoom(), 16.5), opts);
    } else if (v.kind === 'bus') {
      const b = this.fleet.buses.get(v.id);
      if (b) this.flyTo([b.x / KX, b.y / KY], Math.max(m.getZoom(), 15.5), opts);
    }
  }

  private flyTo(center: [number, number], zoom: number, opts: { padding: PaddingOptions; duration: number }) {
    this.flying = true;
    this.map.flyTo({ center, zoom, padding: opts.padding, duration: opts.duration, essential: true, curve: 1.3 });
    this.map.once('moveend', () => (this.flying = false));
  }

  padding(extra = 0): PaddingOptions {
    if (app.narrow) return { top: 56 + extra, bottom: Math.max(120, app.sheetHeight) + extra, left: extra / 2, right: extra / 2 };
    return { top: extra, bottom: extra, left: PANEL_W + extra, right: 56 + extra };
  }

  // ── Viaje planeado ─────────────────────────────────────────────────────────────────────────
  private planKey = '';
  showJourney(j: import('../planner/planner.worker').Answer['journeys'][number] | null, from: import('../planner/places').End | null, to: import('../planner/places').End | null) {
    if (!j || app.view.kind !== 'plan') {
      if (this.planKey) { this.layers.setPlan(null); this.planKey = ''; this.fleet.focusRoutes = null; this.map.triggerRepaint(); }
      return;
    }
    const key = JSON.stringify([j.depart, j.arrive, j.legs.map((l) => (l.kind === 'ride' ? j.routeIds[l.route] : 'w'))]);
    if (key === this.planKey) return;
    this.planKey = key;
    const net = this.net;
    const where = (s: number | null, end: typeof from): [number, number] | null => {
      if (s !== null) {
        const id = j.stopIds[s];
        const st = net.stationOf.get(id);
        const p = st?.platforms.find((x) => x.id === id) ?? st ?? net.streetStops.get(id);
        return p ? [p.lon, p.lat] : null;
      }
      if (!end) return null;
      if (end.kind === 'here') return app.userPos;
      if (end.kind === 'point') return [end.lon, end.lat];
      const p = end.kind === 'station' ? net.stations.get(end.id) : net.streetStops.get(end.id);
      return p ? [p.lon, p.lat] : null;
    };
    const features: GeoJSON.Feature[] = [];
    const all: [number, number][] = [];
    for (const l of j.legs) {
      if (l.kind === 'ride') {
        const rid = j.routeIds[l.route];
        const path = net.paths.get(rid), pat = net.pattern(rid), r = net.routes.get(rid);
        if (!path || !pat) continue;
        const coords = path.slice(pat.s[l.fromPos], pat.s[l.toPos]);
        all.push(...coords);
        features.push({ type: 'Feature', properties: { kind: 'ride', color: r?.color ?? '#eceff2' }, geometry: { type: 'LineString', coordinates: coords } });
      } else {
        const a = where(l.from, from), b = where(l.to, to);
        if (!a || !b) continue;
        all.push(a, b);
        features.push({ type: 'Feature', properties: { kind: 'walk' }, geometry: { type: 'LineString', coordinates: [a, b] } });
      }
    }
    const o = where(null, from), d = where(null, to);
    if (o) features.push({ type: 'Feature', properties: { kind: 'end', dest: false }, geometry: { type: 'Point', coordinates: o } });
    if (d) features.push({ type: 'Feature', properties: { kind: 'end', dest: true }, geometry: { type: 'Point', coordinates: d } });
    this.layers.setPlan({ type: 'FeatureCollection', features });
    // Los buses de las rutas del viaje quedan encima y claros; el resto, atenuado bajo el trazo.
    this.fleet.focusRoutes = new Set(Object.values(j.routeIds));
    this.map.triggerRepaint();
    if (all.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of all) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      this.map.fitBounds([[x0, y0], [x1, y1]], { padding: this.padding(48), duration: 900, maxZoom: 16 });
    }
  }

  // ── Seguimiento ────────────────────────────────────────────────────────────────────────────
  startFollow() {
    app.following = true;
    cancelAnimationFrame(this.followRaf);
    const tick = () => {
      if (!app.following) return;
      const b = this.selectedBus();
      if (b && !this.flying) {
        this.fleet.update(Date.now());
        this.map.jumpTo({ center: [b.x / KX, b.y / KY], padding: this.padding() });
      }
      this.followRaf = requestAnimationFrame(tick);
    };
    this.followRaf = requestAnimationFrame(tick);
  }

  stopFollow() {
    app.following = false;
    cancelAnimationFrame(this.followRaf);
  }

  toggleFollow() {
    if (app.following) this.stopFollow();
    else {
      const b = this.selectedBus();
      if (b) this.flyTo([b.x / KX, b.y / KY], Math.max(this.map.getZoom(), 15.5), { padding: this.padding(), duration: 600 });
      this.startFollow();
    }
  }

  selectedBus(): Bus | undefined {
    return app.view.kind === 'bus' ? this.fleet.buses.get(app.view.id) : undefined;
  }

  // ── Toques ─────────────────────────────────────────────────────────────────────────────────
  private onClick(e: MapMouseEvent) {
    const touch = (e.originalEvent as PointerEvent).pointerType === 'touch' || matchMedia('(pointer: coarse)').matches;
    const r = touch ? 24 : 14;
    const project = (lon: number, lat: number) => this.map.project([lon, lat]);
    const b = this.fleet.pick(project, e.point.x, e.point.y, r);
    if (b) return go({ kind: 'bus', id: b.id });
    const box: [[number, number], [number, number]] = [[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]];
    const st = this.map.queryRenderedFeatures(box, { layers: ['stations'] })[0];
    if (st) return go({ kind: 'station', id: String(st.properties.id) });
    const sp = this.map.getLayer('street-stops') && this.map.queryRenderedFeatures(box, { layers: ['street-stops'] })[0];
    if (sp) return go({ kind: 'stop', id: String(sp.properties.id) });
    const lineBox: [[number, number], [number, number]] = [[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]];
    const line = this.map.queryRenderedFeatures(lineBox, { layers: ['routes-core', 'routes-zonal'] })[0];
    if (line && app.view.kind === 'home') return go({ kind: 'route', id: String(line.properties.id) });
    if (app.view.kind !== 'home') go({ kind: 'home' });
  }

  private onHover(e: MapMouseEvent) {
    const b = this.fleet.pick((lon, lat) => this.map.project([lon, lat]), e.point.x, e.point.y, 14);
    const id = b?.id ?? null;
    let pointer = !!b;
    if (!b) {
      const box: [[number, number], [number, number]] = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
      pointer = this.map.queryRenderedFeatures(box, { layers: ['stations', 'street-stops'] }).length > 0;
    }
    this.map.getCanvas().style.cursor = pointer ? 'pointer' : '';
    if (id !== this.fleet.hoverId) {
      this.fleet.hoverId = id;
      this.map.triggerRepaint();
    }
  }

  // ── Cámara general ─────────────────────────────────────────────────────────────────────────
  zoom(d: number) { this.map.easeTo({ zoom: this.map.getZoom() + d, duration: 220 }); }
  north() { this.map.easeTo({ bearing: 0, pitch: 0, duration: 400 }); }
  overview() {
    this.map.fitBounds([[-74.23, 4.47], [-74.02, 4.83]], { padding: this.padding(24), duration: 900 });
  }

  locate() {
    if (!navigator.geolocation) return;
    app.locating = true;
    navigator.geolocation.getCurrentPosition(
      (p) => {
        app.locating = false;
        const c: [number, number] = [p.coords.longitude, p.coords.latitude];
        app.userPos = c;
        void this.net.loadStreetStops();
        void this.net.loadPatterns().then(() => (app.patternsReady = true));
        this.layers.setUserLocation(c, p.coords.accuracy);
        this.flyTo(c, 16, { padding: this.padding(), duration: 900 });
      },
      () => (app.locating = false),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  }
}

/** Posición mercator de un bus (para pruebas). */
export const busMercator = (b: Bus) => mercator(b.x, b.y, [0, 0]);

import { Point, type Map as MLMap, type MapMouseEvent, type PaddingOptions } from 'maplibre-gl';
import type { Network } from '../data/network';
import type { Fleet, Bus } from '../live/fleet';
import { mercator } from '../live/fleet';
import type { NetworkLayers } from '../map/networkLayers';
import type { BusLayer } from '../map/busLayer';
import { Poller } from '../live/poller';
import { apiBase } from '../live/api';
import { fetchAlerts } from '../live/alerts';
import { KX, KY } from '../domain/geo';
import { watch } from './watch.svelte';
import type { SystemKey } from '../domain/types';
import { app, saveLayers, savePrefs, loadPrefs } from './store.svelte';
import { setMetro } from '../map/metroLayers';
import { Elevation } from '../map/structures';
import { applyBaseTheme } from '../map/style';
import { applyTheme, effective, saveThemePref, themePref, onSystemChange, type ThemePref } from './theme';
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
  /** Pila de vistas de la sesión, para que «Volver» regrese a la anterior (R1.3). */
  private stack: string[] = [location.hash || '#/'];
  /** Desfase en píxeles del bus seguido respecto al centro (al arrastrar el mapa mientras se sigue). */
  private followOffset: [number, number] = [0, 0];
  /** Punteros sobre el mapa y gesto en curso: mientras tanto, seguir no mueve la cámara. */
  private pointers = new Set<number>();
  private gesture = false;
  private framedBus: string | null = null;
  restored = false;
  private alertsTimer = 0;

  constructor(private map: MLMap, private net: Network, private fleet: Fleet, private layers: NetworkLayers, private buses: BusLayer) {
    this.poller = new Poller(apiBase(), (d) => this.onData(d), (s) => (app.poll = s));
  }

  start() {
    const m = this.map;
    m.on('click', (e) => this.onClick(e));
    m.on('mousemove', (e) => this.onHover(e));
    // Mantener presionado (táctil) o clic derecho: «Ir desde aquí / hasta aquí».
    m.on('contextmenu', (e) => { e.preventDefault(); app.ctxMenu = { x: e.point.x, y: e.point.y, lon: e.lngLat.lng, lat: e.lngLat.lat }; });
    let press = 0;
    m.on('touchstart', (e) => {
      if ((e.originalEvent as TouchEvent).touches.length !== 1) return;
      clearTimeout(press);
      press = window.setTimeout(() => { app.ctxMenu = { x: e.point.x, y: e.point.y, lon: e.lngLat.lng, lat: e.lngLat.lat }; navigator.vibrate?.(10); }, 550);
    });
    for (const ev of ['touchend', 'touchcancel', 'dragstart', 'zoomstart', 'rotatestart'] as const) m.on(ev, () => clearTimeout(press));
    m.on('movestart', () => (app.ctxMenu = null));
    m.on('mouseout', () => { this.fleet.hoverId = null; m.getCanvas().style.cursor = ''; m.triggerRepaint(); });
    // Seguir no se corta al mover el mapa (R1.5). Mientras haya un dedo o el ratón sobre el mapa, o
    // el mapa siga moviéndose por un gesto (inercia, rueda, pellizco), la cámara no se toca: un
    // `jumpTo` en medio de un gesto lo cancela. Al terminar, el bus queda donde lo dejó la persona.
    const el = m.getCanvasContainer();
    el.addEventListener('pointerdown', (e) => this.pointers.add(e.pointerId), { passive: true });
    const up = (e: PointerEvent) => { this.pointers.delete(e.pointerId); };
    addEventListener('pointerup', up, { passive: true });
    addEventListener('pointercancel', up, { passive: true });
    m.on('movestart', (e) => { if ((e as { originalEvent?: Event }).originalEvent) this.gesture = true; });
    m.on('moveend', () => {
      if (!this.gesture) return;
      this.gesture = false;
      if (app.following) this.keepOffset();
    });
    // Puentes en 3D: se cargan al acercarse por primera vez.
    m.on('zoomend', () => { if (app.threeD && !this.elevation) this.structures(); });
    // Cámara guardada para volver al mismo lugar.
    let saveTimer = 0;
    m.on('moveend', () => {
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        const c = m.getCenter();
        savePrefs({ camera: { center: [c.lng, c.lat], zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch(), hash: location.hash, at: Date.now() } });
      }, 500);
    });
    addEventListener('hashchange', () => {
      const h = location.hash || '#/';
      if (this.stack.length > 1 && this.stack[this.stack.length - 2] === h) this.stack.pop();
      else if (this.stack[this.stack.length - 1] !== h) this.stack.push(h);
      this.apply(parse());
    });
    addEventListener('resize', () => (app.narrow = innerWidth < 760));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.wake = null;
      else { if (app.following) void this.keepAwake(true); void this.checkData(); }
    });
    this.clock = window.setInterval(() => { app.now = Date.now(); watch.check(this.net, this.fleet, app.now); }, 1000);
    this.poller.start();
    this.setTheme(themePref());
    onSystemChange(() => { if (app.themePref === 'system') this.setTheme('system'); });
    this.applyLayers();
    this.setHidden(app.hidden);
    if (loadPrefs().threeD) this.set3d(true, true);
    const alerts = async () => { if (!document.hidden) { const a = await fetchAlerts(apiBase()); if (a) { app.alerts = a; this.layers.setAlerts(a); } } };
    void alerts();
    this.alertsTimer = window.setInterval(alerts, 60_000);
    // Acceso directo «Cercanos» del ícono instalado (?cerca=1): se ubica y se quita el parámetro.
    const q = new URLSearchParams(location.search);
    if (q.has('cerca')) {
      q.delete('cerca');
      history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}${location.hash}`);
      void this.locate();
    }
    // Con la cámara guardada para esta misma vista, no se reencuadra al abrir.
    const cam = loadPrefs().camera;
    this.apply(app.view, true, this.restored && cam?.hash === (location.hash || ''));
  }

  /**
   * Datos de la red nuevos con la app abierta (se publican a diario): al volver a la app, si pasaron
   * 3 h desde la última revisión, se compara la huella de meta.json; si cambió, aviso con «Recargar»
   * (cámara, filtros y vista se conservan al recargar).
   */
  private dataCheckedAt = Date.now();
  private async checkData() {
    if (Date.now() - this.dataCheckedAt < 3 * 3600_000) return;
    this.dataCheckedAt = Date.now();
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}data/meta.json?v=${Date.now()}`, { cache: 'no-store' });
      const m = (await r.json()) as { hash?: string; built?: string };
      if (m.hash && m.hash !== this.net.hash) {
        const when = m.built ? new Date(m.built).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }) : '';
        watch.show(`Datos de la red actualizados${when ? ` · ${when}` : ''}`, null, { label: 'Recargar', run: () => location.reload() }, 0);
      }
    } catch { /* sin red: se reintenta en la próxima vuelta */ }
  }

  /** Cerrar: fuera toda la selección y al inicio de una vez (sin recorrer lo navegado). */
  close() {
    this.stack = ['#/'];
    go({ kind: 'home' });
  }

  /** Volver: a la vista anterior de la sesión; si no hay, al inicio. */
  back() {
    if (this.stack.length > 1) history.back();
    else go({ kind: 'home' });
  }

  stop() {
    this.poller.stop();
    clearInterval(this.clock);
    clearInterval(this.alertsTimer);
    cancelAnimationFrame(this.followRaf);
  }

  /**
   * «Resaltar llegadas» (modo de la ficha de estación o paradero, apagado por defecto): solo los buses
   * que llegan quedan en foco, el resto se atenúa debajo, y cada uno lleva el tramo que le falta hasta
   * la parada. `frame`: encuadrar la estación y esos buses (al encender el modo).
   */
  private spotOn = false;
  spotlight(items: { busId: string; routeId: string; s1: number; color: string }[] | null, place?: [number, number], frame = false) {
    if (!items) {
      if (!this.spotOn) return;
      this.spotOn = false;
      this.fleet.focusBuses = null;
      this.layers.setApproach(null);
      this.map.triggerRepaint();
      return;
    }
    this.spotOn = true;
    this.fleet.focusBuses = new Set(items.map((i) => i.busId));
    const features: GeoJSON.Feature[] = [];
    const pts: [number, number][] = place ? [place] : [];
    for (const it of items) {
      const b = this.fleet.buses.get(it.busId);
      const path = this.net.paths.get(it.routeId);
      if (!b) continue;
      pts.push([b.x / KX, b.y / KY]);
      if (!path || !b.onPath) continue;
      const s0 = b.s || b.sFix;
      if (it.s1 - s0 < 5) continue;
      features.push({ type: 'Feature', properties: { color: it.color }, geometry: { type: 'LineString', coordinates: path.slice(s0, it.s1) } });
    }
    this.layers.setApproach({ type: 'FeatureCollection', features });
    if (frame && pts.length > 1) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      this.map.fitBounds([[x0, y0], [x1, y1]], { padding: this.padding(48), duration: 800, maxZoom: 16.4, absolutePadding: true });
    }
    this.map.triggerRepaint();
  }

  /** Buses que llegan pronto a la estación abierta (onda suave en el mapa). */
  setArriving(ids: string[]) {
    const s = new Set(ids);
    if (s.size === this.fleet.arriving.size && ids.every((i) => this.fleet.arriving.has(i))) return;
    this.fleet.arriving = s;
    this.map.triggerRepaint();
  }

  /** Filtro por sistema: buses y trazados. */
  setHidden(list: SystemKey[]) {
    savePrefs({ hidden: list });
    this.fleet.hidden = new Set(list);
    this.layers.setHidden(this.fleet.hidden);
    this.map.triggerRepaint();
  }

  /** Refrescar ya (al volver a la pestaña o desde la interfaz). */
  refresh() { this.poller.now(); }

  private onData(d: Parameters<Fleet['ingest']>[0]) {
    this.fleet.ingest(d);
    this.speed?.update();
    // Una vista de bus abierta antes de tener datos (recarga, enlace): se encuadra en cuanto aparece.
    const v = app.view;
    if (v.kind === 'bus' && this.framedBus !== v.id && this.fleet.buses.has(v.id)) {
      this.framedBus = v.id;
      if (!this.restored) this.frame(v);
      if (app.following) this.startFollow();
    }
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
  apply(v: View, initial = false, keepCamera = false) {
    // Enlace a una ruta con un id que TRANSMILENIO re-emitió: se lleva al vigente (alias).
    if (v.kind === 'route' && !this.net.routes.has(v.id)) {
      void this.net.loadChanges().then(() => { const r = this.net.resolveRoute(v.id); if (r && r !== v.id) go({ kind: 'route', id: r }, true); });
    }
    app.view = v;
    if (!keepCamera) this.restored = false;
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
    if (!keepCamera) {
      if (app.narrow) setTimeout(() => this.frame(v, initial), initial ? 120 : 40);
      else this.frame(v, initial);
    }
    if (v.kind === 'bus' && this.fleet.buses.has(v.id)) this.framedBus = v.id;
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
      // El trazo se dibuja cuando la cámara llega (R1.13).
      this.afterMove(() => this.layers.drawFocus(1600), opts.duration);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < p.lonlat.length; i += 2) {
        x0 = Math.min(x0, p.lonlat[i]); x1 = Math.max(x1, p.lonlat[i]);
        y0 = Math.min(y0, p.lonlat[i + 1]); y1 = Math.max(y1, p.lonlat[i + 1]);
      }
      m.fitBounds([[x0, y0], [x1, y1]], { ...opts, maxZoom: 15.5, absolutePadding: true });
    } else if (v.kind === 'station') {
      const s = this.net.stations.get(v.id);
      if (s) this.flyTo([s.lon, s.lat], Math.max(m.getZoom(), 16), opts);
    } else if (v.kind === 'stop') {
      const s = this.net.streetStops.get(v.id);
      if (s) this.flyTo([s.lon, s.lat], Math.max(m.getZoom(), 16.5), opts);
    } else if (v.kind === 'plan' && this.planBounds) {
      this.map.fitBounds(this.planBounds, { padding: this.padding(48), duration: 900, maxZoom: 16, absolutePadding: true });
    } else if (v.kind === 'bus') {
      const b = this.fleet.buses.get(v.id);
      // 16,4: la huella del bus ya está formada (entre 15,2 y 16 el punto se transforma).
      if (b) this.flyTo([b.x / KX, b.y / KY], Math.max(m.getZoom(), 16.4), opts);
    }
  }

  private flyTo(center: [number, number], zoom: number, opts: { padding: PaddingOptions; duration: number }) {
    this.flying = true;
    this.map.flyTo({ center, zoom, padding: opts.padding, duration: opts.duration, essential: true, curve: 1.3 });
    this.map.once('moveend', () => (this.flying = false));
  }

  /** El centro del mapa queda en la parte visible (sobre la hoja inferior), y el paneo llega hasta ahí (R1.4). */
  /** Relleno del mapa igual a la hoja. `setPadding` es un salto de cámara y cancela cualquier
   * animación en curso (el encuadre del viaje, un vuelo a una estación): si la cámara se está moviendo,
   * se aplica al terminar. */
  private padWait = false;
  syncPadding() {
    const m = this.map;
    if (m.isMoving() || this.flying) {
      if (this.padWait) return;
      this.padWait = true;
      m.once('moveend', () => { this.padWait = false; this.syncPadding(); });
      return;
    }
    m.setPadding(this.padding());
  }

  padding(extra = 0): PaddingOptions {
    if (app.narrow) {
      // Con la hoja alta, el relleno no puede comerse la pantalla: si arriba + abajo pasan del alto,
      // `fitBounds` no encuadra nada (le pasaba al viaje planeado). Siempre quedan ≥ 140 px de mapa.
      const top = 56 + extra;
      const bottom = Math.min(Math.max(120, app.sheetHeight) + extra, innerHeight - top - 140);
      return { top, bottom: Math.max(0, bottom), left: extra / 2, right: extra / 2 };
    }
    return { top: extra, bottom: extra, left: PANEL_W + 12 + extra, right: 56 + extra };
  }

  // ── Viaje planeado ─────────────────────────────────────────────────────────────────────────
  private planKey = '';
  private planBounds: [[number, number], [number, number]] | null = null;
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
      this.planBounds = [[x0, y0], [x1, y1]];
      // `absolutePadding`: el relleno dado reemplaza al del mapa (si no, MapLibre los suma y con la hoja
      // alta no cabe nada).
      this.map.fitBounds([[x0, y0], [x1, y1]], { padding: this.padding(48), duration: 900, maxZoom: 16, absolutePadding: true });
      this.afterMove(() => this.layers.drawPlan(), 900);
    }
  }

  // ── Seguimiento ────────────────────────────────────────────────────────────────────────────
  /** Pantalla encendida mientras se sigue un bus (Screen Wake Lock; donde no exista, nada). */
  private wake: { release(): Promise<void> } | null = null;
  private async keepAwake(on: boolean) {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!on) { await this.wake?.release().catch(() => {}); this.wake = null; return; }
    if (!wl || this.wake || document.hidden) return;
    try { this.wake = await wl.request('screen'); } catch { this.wake = null; }
  }

  startFollow() {
    app.following = true;
    void this.keepAwake(true);
    this.followOffset = [0, 0];
    cancelAnimationFrame(this.followRaf);
    let last = 0, lx = 0, ly = 0;
    const tick = (t: number) => {
      if (!app.following) return;
      const b = this.selectedBus();
      // Solo si el bus se movió: la cámara no fuerza cuadros de más (R1.17).
      const busy = this.flying || this.gesture || this.pointers.size > 0 || this.map.isMoving();
      // 20 cuadros por segundo bastan bajo z17,5 (el mapa avanza < 0,5 px por paso); 30 más cerca.
      if (b && !busy && t - last > (this.map.getZoom() >= 17.5 ? 30 : 48)) {
        this.fleet.update(Date.now());
        if (Math.abs(b.x - lx) + Math.abs(b.y - ly) > 0.05) {
          lx = b.x; ly = b.y; last = t;
          const m = this.map;
          const c = m.unproject(m.project([b.x / KX, b.y / KY]).sub(new Point(this.followOffset[0], this.followOffset[1])));
          m.jumpTo({ center: c });
        }
      }
      this.followRaf = requestAnimationFrame(tick);
    };
    this.followRaf = requestAnimationFrame(tick);
  }

  /** Tras un gesto, el desfase es donde quedó el bus en pantalla; si quedó fuera, vuelve al borde. */
  private keepOffset() {
    const b = this.selectedBus();
    if (!b) return;
    const m = this.map;
    const p = m.project([b.x / KX, b.y / KY]);
    const c = m.project(m.getCenter());
    const { top = 0, bottom = 0, left = 0, right = 0 } = this.padding(), cv = m.getContainer();
    const M = 40;
    const x = Math.min(Math.max(p.x, left + M), cv.clientWidth - right - M);
    const y = Math.min(Math.max(p.y, top + M), cv.clientHeight - bottom - M);
    this.followOffset = [x - c.x, y - c.y];
    if (x !== p.x || y !== p.y) {
      const to = m.unproject(p.sub(new Point(this.followOffset[0], this.followOffset[1])));
      this.flying = true;
      m.easeTo({ center: to, duration: 350 });
      m.once('moveend', () => (this.flying = false));
    }
  }

  stopFollow() {
    app.following = false;
    void this.keepAwake(false);
    cancelAnimationFrame(this.followRaf);
  }

  toggleFollow() {
    if (app.following) this.stopFollow();
    else {
      const b = this.selectedBus();
      if (b) this.flyTo([b.x / KX, b.y / KY], Math.max(this.map.getZoom(), 16.4), { padding: this.padding(), duration: 600 });
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
    const st = this.map.queryRenderedFeatures(box, { layers: ['stations', 'station-fp', 'station-fp-3d', 'station-fp-roof'].filter((l) => this.map.getLayoutProperty(l, 'visibility') !== 'none') })[0];
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
      pointer = this.map.queryRenderedFeatures(box, { layers: ['stations', 'street-stops', 'station-fp'] }).length > 0;
    }
    this.map.getCanvas().style.cursor = pointer ? 'pointer' : '';
    if (id !== this.fleet.hoverId) {
      this.fleet.hoverId = id;
      this.map.triggerRepaint();
    }
  }

  // ── Cámara general ─────────────────────────────────────────────────────────────────────────
  /** Tema: según el sistema, oscuro o claro. Mapa base, red, buses e interfaz cambian juntos. */
  setTheme(pref: ThemePref) {
    saveThemePref(pref);
    app.themePref = pref;
    const t = effective(pref);
    applyTheme(t);
    applyBaseTheme(this.map, t);
    this.layers.setTheme(t);
    this.speed?.setTheme(t);
    const rim: [number, number, number] = t === 'light' ? [0.97, 0.975, 0.98] : [0.063, 0.078, 0.094];
    const ring: [number, number, number] = t === 'light' ? [0.2, 0.24, 0.28] : [0.94, 0.95, 0.96];
    const mute: [number, number, number] = t === 'light' ? [0.78, 0.81, 0.84] : [0.16, 0.18, 0.21];
    const shadow = t === 'light' ? 0.22 : 0.55;
    this.buses.setColors(rim, ring, mute, shadow);
    this.dimBuses?.setColors(rim, ring, mute, shadow);
    this.map.triggerRepaint();
  }

  dimBuses?: BusLayer;
  speed?: import('../map/speedLayer').SpeedLayer;

  /** Capas opcionales: rutas zonales, paraderos, metro L1, estelas de toda la flota. */
  setLayer(key: keyof typeof app.layersOn, on: boolean) {
    app.layersOn = { ...app.layersOn, [key]: on };
    saveLayers(app.layersOn);
    this.applyLayers();
  }

  applyLayers() {
    const l = app.layersOn, m = this.map;
    m.setLayoutProperty('routes-zonal', 'visibility', l.zonal ? 'visible' : 'none');
    this.layers.setDual(l.dual);
    this.speed?.setVisible(l.speed);
    m.setLayoutProperty('street-stops', 'visibility', l.stops ? 'visible' : 'none');
    this.fleet.trails = l.trails;
    void setMetro(m, l.metro, app.threeD);
    m.triggerRepaint();
  }

  /** Ejecuta `fn` cuando termine el movimiento de cámara en curso (o enseguida si no hay). */
  private afterMove(fn: () => void, duration: number) {
    if (duration <= 0) { setTimeout(fn, 60); return; }
    let done = false;
    const go = () => { if (!done) { done = true; fn(); } };
    this.map.once('moveend', go);
    setTimeout(go, duration + 400);
  }

  /** Vista 3D: solo inclina la cámara (sin acercar), reencuadra lo que esté en foco y repite su trazo (R1.6). */
  set3d(on: boolean, instant = false) {
    app.threeD = on;
    savePrefs({ threeD: on });
    void setMetro(this.map, app.layersOn.metro, on);
    // Los edificios van debajo de la red: la tapan donde corresponde, pero nunca a los buses.
    this.map.setLayoutProperty('building-3d', 'visibility', on ? 'visible' : 'none');
    this.map.setLayoutProperty('building', 'visibility', on ? 'none' : 'visible');
    this.layers.set3d(on);
    this.structures();
    if (instant) { this.map.jumpTo({ pitch: on ? 55 : 0 }); return; }
    const v = app.view;
    this.map.easeTo({ pitch: on ? 55 : 0, bearing: on ? (this.map.getBearing() || -18) : this.map.getBearing(), duration: 700 });
    this.afterMove(() => {
      if (v.kind === 'route' || v.kind === 'plan' || v.kind === 'station' || v.kind === 'stop') this.frame(v);
      if (v.kind === 'route') this.afterMove(() => this.layers.drawFocus(1600), 900);
      if (v.kind === 'plan') this.afterMove(() => this.layers.drawPlan(), 900);
    }, 700);
  }

  /** Puentes de la troncal en 3D (F7.5): tableros y buses encima. Se cargan la primera vez que hacen
   * falta (vista 3D y z ≥ 14,5); fuera de 3D, todos los buses van al suelo. */
  private elevation: Elevation | null = null;
  private structures = () => {
    if (!app.threeD) { this.fleet.elevation = null; return; }
    if (this.elevation) { this.fleet.elevation = (x, y, hx, hy) => this.elevation!.at(x, y, hx, hy); return; }
    if (this.map.getZoom() < 14.5) return;
    void this.net.loadStructures().then(() => {
      if (!this.net.bridges?.length) return;
      this.elevation ??= new Elevation(this.net.bridges);
      this.layers.setDecks();
      this.structures();
      this.map.triggerRepaint();
    });
  };

  zoom(d: number) { this.map.easeTo({ zoom: this.map.getZoom() + d, duration: 220 }); }
  north() { this.map.easeTo({ bearing: 0, pitch: app.threeD ? this.map.getPitch() : 0, duration: 400 }); }
  overview() {
    this.map.fitBounds([[-74.23, 4.47], [-74.02, 4.83]], { padding: this.padding(24), duration: 900, absolutePadding: true });
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

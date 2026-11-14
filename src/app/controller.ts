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
import type { Route } from '../domain/types';
import type { FilterKey } from '../domain/filter';
import { busCodes, legAtS } from '../domain/legs';
import { app, saveLayers, savePrefs, loadPrefs } from './store.svelte';
import { loadMetro, setMetro, setMetroTheme } from '../map/metroLayers';
import { buildObras, loadObras, setObras, setObrasTheme } from '../map/obras';
import { Elevation } from '../map/structures';
import { buildBridges, buildFootbridges, buildStations, buildTrenches, type Structures } from '../map/structuresLayer';
import { buildMetro, type MetroStats } from '../map/metro3d';
import { buildCable, loadCable } from '../map/cable3d';
import { applyBaseTheme } from '../map/style';
import { applyTheme, effective, saveThemePref, themePref, onSystemChange, type ThemePref } from './theme';
import { go, parse, type View } from './router';
import { backup } from '../live/backup.svelte';
import { Tour } from './tour';
import palette from '../../data/curated/palette.json';

export const PANEL_W = 380;
/** Ancho de la columna de controles del mapa en el teléfono (botón de 44 px + margen de 12). */
const CONTROLS_W = 56;
/** Cada cuánto se repite el pulso sobre la ruta abierta (ms). */
const PULSE_EVERY = 14_000;
/** Lo último que se supo de un bus (ver `Controller.lastSeen`). */
export interface LastSeen { label: string; plate: string; routeId: string; fixAt: number; lon: number; lat: number }

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

  constructor(private map: MLMap, private net: Network, private fleet: Fleet, private layers: NetworkLayers, private buses: BusLayer, structs?: Structures) {
    this.structs = structs;
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
    // Inactividad (R10.7): cualquier toque, movimiento del ratón, rueda o tecla en la página.
    const touched = () => { this.lastInput = Date.now(); if (this.orbiting) this.stopOrbit(true); };
    for (const ev of ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const) addEventListener(ev, touched, { passive: true, capture: true });
    addEventListener('pointermove', (e) => { if ((e as PointerEvent).pointerType === 'mouse') touched(); }, { passive: true, capture: true });
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
      // La inactividad cuenta solo con la página a la vista: al ocultarla y al volver, empieza de cero.
      this.lastInput = Date.now();
      if (document.hidden) this.wake = null;
      else { if (app.following || this.tour) void this.keepAwake(true); void this.checkData(); }
    });
    addEventListener('pageshow', () => (this.lastInput = Date.now()));
    // El respaldo por ruta también cambia la flota: conteos y listas al día (como en onData).
    backup.onChange = () => { this.remember(); app.counts = this.fleet.counts(); app.version++; this.map.triggerRepaint(); };
    // El bus del respaldo que el alimentador empieza a traer cambia de id: la ficha abierta y el aviso
    // de llegada pasan al id del alimentador.
    this.fleet.onReplace = (from, to) => {
      const k = this.known.get(from);
      if (k) this.known.set(to, k);
      if (watch.item?.busId === from) watch.item = { ...watch.item, busId: to };
      if (app.view.kind === 'bus' && app.view.id === from) go({ kind: 'bus', id: to }, true);
    };
    let ticks = 0, lastClock = Date.now();
    this.clock = window.setInterval(() => {
      app.now = Date.now();
      // Oculta, o un salto del reloj de este temporizador (un iPhone congela la app en segundo plano y
      // al volver puede no avisar): ese tiempo no cuenta como inactividad.
      if (document.hidden || app.now - lastClock > 5000) this.lastInput = app.now;
      lastClock = app.now;
      this.pulse();
      watch.check(this.net, this.fleet, app.now);
      this.traveled();
      this.idleCheck();
      backup.tick(this.net, this.fleet, app.poll.feedTime, this.backupCodes(), app.now);
      // Buses del respaldo que ya no se actualizan (cada 5 s basta).
      if (++ticks % 5 === 0 && this.fleet.prune(app.now)) { app.counts = this.fleet.counts(); app.version++; this.map.triggerRepaint(); }
    }, 1000);
    this.poller.start();
    this.setTheme(themePref());
    onSystemChange(() => { if (app.themePref === 'system') this.setTheme('system'); });
    this.applyLayers();
    this.setHidden(app.hidden);
    // Movimiento entre lecturas (Configuración). Con «reducir movimiento» del sistema, el modo directo
    // va de una vez, sin deslizamiento.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) this.fleet.glide = 0;
    this.fleet.setMotion(app.motion);
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
      this.map.fitBounds([[x0, y0], [x1, y1]], { padding: this.padding(48, true), duration: 800, maxZoom: 16.4, absolutePadding: true });
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
  setHidden(list: FilterKey[]) {
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
    this.remember();
    app.counts = this.fleet.counts();
    app.version++;
    const n = Object.values(app.counts).reduce((a, b) => a + b, 0);
    if (!app.pulse.length || app.pulse[app.pulse.length - 1].t !== d.t) {
      app.pulse = [...app.pulse.filter((p) => d.t - p.t <= 7200), { t: d.t, n }];
    }
    this.map.triggerRepaint();
  }

  /**
   * Lo último que se supo de los buses abiertos en la sesión (etiqueta, ruta, hora). Si el bus sale de
   * la flota (terminó el viaje o dejó de reportar), su ficha no se queda en blanco ni se pierde la
   * ruta de la que venía: sigue en foco y la ficha dice qué bus era y ofrece su ruta.
   */
  private known = new Map<string, LastSeen>();
  lastSeen(id: string): LastSeen | undefined { return this.known.get(id); }
  private remember() {
    const v = app.view;
    if (v.kind !== 'bus') return;
    const b = this.fleet.buses.get(v.id);
    if (b) {
      this.known.set(b.id, { label: b.label, plate: b.plate, routeId: b.routeId, fixAt: b.fixAt, lon: b.fixX / KX, lat: b.fixY / KY });
      if (this.known.size > 40) this.known.delete(this.known.keys().next().value!);
      // Volvió (o se supo su ruta): la ruta queda en foco otra vez.
      if (this.fleet.focusRoute !== b.routeId) { this.fleet.focusRoute = b.routeId; this.layers.setFocus(b.routeId); }
    } else if (app.following && this.fleet.feedTime && this.known.has(v.id)) {
      // Estaba y ya no está: seguirlo no tiene a dónde ir. (Sin datos todavía, o un enlace a un bus
      // que aún no aparece, se sigue esperando: al llegar se encuadra y se sigue.)
      this.stopFollow();
    }
  }

  // ── Vistas ─────────────────────────────────────────────────────────────────────────────────
  apply(v: View, initial = false, keepCamera = false) {
    // Enlace a una ruta con un id que TRANSMILENIO re-emitió: se lleva al vigente (alias).
    if (v.kind === 'route' && !this.net.routes.has(v.id)) {
      void this.net.loadChanges().then(() => { const r = this.net.resolveRoute(v.id); if (r && r !== v.id) go({ kind: 'route', id: r }, true); });
    }
    if (this.keepNext) { keepCamera = true; this.keepNext = false; }
    app.view = v;
    if (!keepCamera) this.restored = false;
    this.stopOrbit(false);
    // Recorrido automático: toma la cámara; cualquier otra vista lo termina.
    if (v.kind === 'tour') { this.startTour(); return; }
    this.endTour();
    const f = this.fleet;
    f.selectedId = null;
    let focus: string | null = null;
    let station: string | null = null;
    if (v.kind === 'route') focus = v.id;
    if (v.kind === 'bus') {
      f.selectedId = v.id;
      focus = f.buses.get(v.id)?.routeId ?? this.known.get(v.id)?.routeId ?? null;
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
    if (v.kind !== 'bus') { this.stopFollow(); this.layers.setTraveled(null); }
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
    if (v.kind === 'bus') { this.startFollow(); this.remember(); }
  }

  /** Lleva la cámara a lo seleccionado, dejando libre el espacio del panel. */
  frame(v: View, initial = false) {
    const m = this.map;
    const padding = this.padding(48);
    const opts = { padding, duration: initial ? 0 : 900, essential: true };
    if (v.kind === 'route') {
      const p = this.net.paths.get(v.id);
      if (!p) return;
      // El trazo se dibuja cuando la cámara llega (R1.13) y después un pulso lo recorre cada tanto.
      this.afterMove(() => { this.layers.drawFocus(1600); this.pulseAt = performance.now() + 1600; }, opts.duration);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < p.lonlat.length; i += 2) {
        x0 = Math.min(x0, p.lonlat[i]); x1 = Math.max(x1, p.lonlat[i]);
        y0 = Math.min(y0, p.lonlat[i + 1]); y1 = Math.max(y1, p.lonlat[i + 1]);
      }
      m.fitBounds([[x0, y0], [x1, y1]], { ...opts, padding: this.padding(48, true), maxZoom: 15.5, absolutePadding: true });
    } else if (v.kind === 'station') {
      const s = this.net.stations.get(v.id);
      if (s) this.flyTo([s.lon, s.lat], Math.max(m.getZoom(), 16), opts);
    } else if (v.kind === 'stop') {
      const s = this.net.streetStops.get(v.id);
      if (s) this.flyTo([s.lon, s.lat], Math.max(m.getZoom(), 16.5), opts);
    } else if (v.kind === 'plan' && this.planBounds) {
      this.map.fitBounds(this.planBounds, { padding: this.padding(48, true), duration: 900, maxZoom: 16, absolutePadding: true });
    } else if (v.kind === 'bus') {
      const b = this.fleet.buses.get(v.id);
      // 16,4: la huella del bus ya está formada (entre 15,2 y 16 el punto se transforma). En 3D, el
      // vuelo llega directo detrás del bus (R10.3).
      if (b && app.threeD) {
        this.flying = true;
        m.flyTo({ center: [b.x / KX, b.y / KY], zoom: Math.max(m.getZoom(), 16.9), bearing: this.bearingOf(b), pitch: 62, offset: this.headingOffset(), padding, duration: opts.duration, essential: true, curve: 1.3 });
        m.once('moveend', () => (this.flying = false));
      } else if (b) this.flyTo([b.x / KX, b.y / KY], Math.max(m.getZoom(), 16.4), opts);
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

  /**
   * `fit`: para encuadrar un recorrido (ruta, viaje, llegadas). En el teléfono, el mapa visible no
   * incluye la columna de controles de la derecha: sin descontarla, la punta de una ruta ancha quedaba
   * debajo de los botones. Para centrar un punto (estación, bus) no se descuenta: quedaría corrido.
   */
  padding(extra = 0, fit = false): PaddingOptions {
    if (app.narrow) {
      // Con la hoja alta, el relleno no puede comerse la pantalla: si arriba + abajo pasan del alto,
      // `fitBounds` no encuadra nada (le pasaba al viaje planeado). Siempre quedan ≥ 140 px de mapa.
      const top = (app.topbarH || 56) + extra;
      const bottom = Math.min(Math.max(120, app.sheetHeight) + extra, innerHeight - top - 140);
      return { top, bottom: Math.max(0, bottom), left: extra / 2, right: extra / 2 + (fit ? CONTROLS_W : 0) };
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
      this.map.fitBounds([[x0, y0], [x1, y1]], { padding: this.padding(48, true), duration: 900, maxZoom: 16, absolutePadding: true });
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

  /**
   * Cámaras del seguimiento (R10.3), sin botones nuevos: la brújula alterna norte arriba y rumbo
   * arriba (el mapa gira y el bus va siempre hacia arriba, algo por debajo del centro); con la vista
   * 3D, rumbo arriba es la cámara detrás del bus (inclinada, el bus en el tercio inferior). El rumbo se
   * suaviza (las curvas giran la cámara despacio) y los gestos no cortan el seguimiento (R2.1).
   */
  private heading2d = false;
  private heading3dPrev: boolean | null = null;
  /** Rumbo de brújula de un bus (grados). */
  private bearingOf(b: Bus) { return (Math.atan2(b.hx, b.hy) * 180) / Math.PI; }
  /** Desfase del bus respecto al centro con rumbo arriba: más abajo en 3D (se ve el camino por delante). */
  private headingOffset(): [number, number] {
    const pad = this.padding();
    const h = this.map.getContainer().clientHeight - (pad.top ?? 0) - (pad.bottom ?? 0);
    return [0, Math.round(h * (app.threeD ? 0.24 : 0.14))];
  }
  setFollowHeading(on: boolean, animate = true) {
    app.followHeading = on;
    if (!app.threeD) this.heading2d = on;
    const m = this.map;
    const b = this.selectedBus();
    this.followOffset = on ? this.headingOffset() : [0, 0];
    if (!animate || !b) return;
    // `offset`: el bus queda desplazado del centro lo que pide el modo; el tick siguiente corrige lo
    // que se haya movido durante el giro.
    this.flying = true;
    m.easeTo({
      center: [b.x / KX, b.y / KY],
      bearing: on ? this.bearingOf(b) : 0,
      pitch: app.threeD ? (on ? 62 : 55) : 0,
      zoom: on && app.threeD ? Math.max(m.getZoom(), 16.9) : m.getZoom(),
      offset: [this.followOffset[0], this.followOffset[1]],
      duration: 700,
      essential: true,
    });
    m.once('moveend', () => (this.flying = false));
  }
  /** Brújula: siguiendo un bus, alterna norte arriba y rumbo arriba; si no, norte arriba. */
  compass() {
    if (app.following && this.selectedBus()) this.setFollowHeading(!app.followHeading);
    else this.north();
  }

  startFollow() {
    app.following = true;
    void this.keepAwake(true);
    // En 3D, seguir es ir detrás del bus; en 2D, lo último que eligió la persona en la sesión.
    app.followHeading = app.threeD || this.heading2d;
    this.followOffset = app.followHeading ? this.headingOffset() : [0, 0];
    cancelAnimationFrame(this.followRaf);
    let last = 0, lx = 0, ly = 0;
    const tick = (t: number) => {
      if (!app.following) return;
      const b = this.selectedBus();
      // Solo si el bus se movió (o falta girar): la cámara no fuerza cuadros de más (R1.17).
      const busy = this.flying || this.gesture || this.pointers.size > 0 || this.map.isMoving();
      // 20 cuadros por segundo bastan bajo z17,5 (el mapa avanza < 0,5 px por paso); 30 más cerca y
      // con rumbo arriba (un giro a 20 cuadros se ve a saltos).
      const heading = app.followHeading;
      if (b && !busy && t - last > (heading || this.map.getZoom() >= 17.5 ? 30 : 48)) {
        this.fleet.update(Date.now());
        const m = this.map;
        let bearing = m.getBearing();
        let turn = 0;
        if (heading) {
          const d = ((this.bearingOf(b) - bearing + 540) % 360) - 180;
          // Constante de tiempo ~1 s: las curvas giran la cámara despacio; el zigzag del GPS no se nota.
          turn = d * Math.min(1, (t - (last || t - 33)) / 1000);
          if (Math.abs(turn) < 0.02) turn = 0;
        }
        if (Math.abs(b.x - lx) + Math.abs(b.y - ly) > 0.05 || turn) {
          lx = b.x; ly = b.y; last = t;
          bearing += turn;
          // El centro se calcula con el rumbo nuevo: el desfase en pantalla gira con la cámara.
          if (turn) m.setBearing(bearing);
          const c = m.unproject(m.project([b.x / KX, b.y / KY]).sub(new Point(this.followOffset[0], this.followOffset[1])));
          m.jumpTo({ center: c, bearing });
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
    app.followHeading = false;
    void this.keepAwake(false);
    cancelAnimationFrame(this.followRaf);
  }

  toggleFollow() {
    if (app.following) this.stopFollow();
    else {
      const b = this.selectedBus();
      this.startFollow();
      if (b && app.followHeading) this.setFollowHeading(true);
      else if (b) this.flyTo([b.x / KX, b.y / KY], Math.max(this.map.getZoom(), 16.4), { padding: this.padding(), duration: 600 });
    }
  }

  selectedBus(): Bus | undefined {
    return app.view.kind === 'bus' ? this.fleet.buses.get(app.view.id) : undefined;
  }

  // ── Recorrido automático ───────────────────────────────────────────────────────────────────
  private tour: Tour | null = null;
  private tourExit: (() => void) | null = null;
  /** Recorrido arrancado por inactividad: a dónde volver (vista y cámara) al primer toque. */
  private idleReturn: { view: View; camera: { center: [number, number]; zoom: number; bearing: number; pitch: number } } | null = null;
  private lastInput = Date.now();
  /** La próxima vista se aplica sin mover la cámara (vuelta del recorrido por inactividad). */
  private keepNext = false;
  private orbiting = false;
  private orbitFrom: { center: [number, number]; zoom: number; bearing: number; pitch: number } | null = null;

  private camera() {
    const m = this.map, c = m.getCenter();
    return { center: [c.lng, c.lat] as [number, number], zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() };
  }

  /**
   * Al dejar la página quieta (R10.7, Configuración; 30 s por defecto, también en el teléfono): con
   * una estación o un paradero abiertos, la cámara gira despacio a su alrededor (la ficha sigue a la
   * vista); en el inicio y las demás vistas pasivas, arranca el recorrido. Nunca mientras se sigue un
   * bus, se planea un viaje, se busca o se escribe. Al primer toque, todo vuelve a como estaba.
   */
  private idleCheck() {
    const ms = app.idleMs;
    if (!ms || document.hidden || this.tour || this.orbiting) return;
    if (Date.now() - this.lastInput < ms) return;
    const v = app.view.kind;
    if (app.following || app.searchOpen || app.layersOpen || app.ctxMenu || v === 'plan' || v === 'settings' || v === 'bus' || v === 'tour') return;
    const a = document.activeElement;
    if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement) return;
    if (!this.fleet.buses.size || this.map.isMoving() || this.flying || this.pointers.size) return;
    if (v === 'station' || v === 'stop') { this.startOrbit(); return; }
    this.idleReturn = { view: app.view, camera: this.camera() };
    go({ kind: 'tour', id: '' }, true);
  }

  private startOrbit() {
    const v = app.view;
    const p = v.kind === 'station' ? this.net.stations.get(v.id) : v.kind === 'stop' ? this.net.streetStops.get(v.id) : undefined;
    if (!p || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    this.orbiting = true;
    this.orbitFrom = this.camera();
    const m = this.map;
    const lap = () => {
      if (!this.orbiting) return;
      // Una vuelta cada 2 min, sin aceleración; al terminar, otra.
      m.easeTo({ center: [p.lon, p.lat], bearing: m.getBearing() + 90, pitch: app.threeD ? 60 : m.getPitch(), duration: 30_000, easing: (t) => t, essential: true });
      m.once('moveend', () => { if (this.orbiting) lap(); });
    };
    lap();
  }

  private stopOrbit(restore: boolean) {
    if (!this.orbiting) return;
    this.orbiting = false;
    this.map.stop();
    if (restore && this.orbitFrom) this.map.easeTo({ ...this.orbitFrom, duration: 500 });
    this.orbitFrom = null;
  }

  private startTour() {
    if (this.tour) return;
    this.stopFollow();
    this.showJourney(null, null, null);
    this.layers.setSelectedPlace(null);
    // Sin panel ni hoja: el mapa entero. En el teléfono el rótulo ocupa el pie: el bus seguido va
    // en el centro de lo que queda.
    app.sheetHeight = 0;
    this.map.setPadding({ top: 0, bottom: app.narrow ? 200 : 0, left: 0, right: 0 });
    const cable = () => loadCable().then((d) => d.lines.flatMap((l) => l.points)).catch(() => null);
    this.tour = new Tour(this.map, this.net, this.fleet, this.layers, palette.zones as Record<string, { name: string; color: string }>, this.speed, cable);
    // Pantalla encendida solo si la persona lo abrió; arrancado por inactividad, el sistema decide.
    if (!this.idleReturn) void this.keepAwake(true);
    // Cualquier toque, rueda o tecla termina el recorrido: al inicio o, si arrancó por inactividad, a
    // la vista y la cámara de antes. Se arma un instante después para que el toque que lo abrió no lo
    // cierre.
    const el = this.map.getCanvasContainer();
    const exit = () => {
      if (app.view.kind !== 'tour') return;
      const back = this.idleReturn;
      // La vista de antes vuelve sin reencuadrar: la cámara la pone `endTour`.
      if (back) { this.keepNext = true; go(back.view, true); } else go({ kind: 'home' });
    };
    const key = (e: KeyboardEvent) => { if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) exit(); };
    const arm = window.setTimeout(() => {
      el.addEventListener('pointerdown', exit, { passive: true });
      el.addEventListener('wheel', exit, { passive: true });
      addEventListener('keydown', key);
    }, 600);
    this.tourExit = () => { clearTimeout(arm); el.removeEventListener('pointerdown', exit); el.removeEventListener('wheel', exit); removeEventListener('keydown', key); };
    this.tour.start();
  }

  private endTour() {
    if (!this.tour) return;
    this.tour.stop();
    this.tour = null;
    this.tourExit?.();
    this.tourExit = null;
    this.lastInput = Date.now();
    if (app.view.kind !== 'bus') void this.keepAwake(false);
    const back = this.idleReturn;
    this.idleReturn = null;
    if (back) this.map.jumpTo(back.camera);
    else this.map.easeTo({ pitch: app.threeD ? 55 : 0, duration: 500 });
    setTimeout(() => this.syncPadding(), 300);
  }

  // ── Toques ─────────────────────────────────────────────────────────────────────────────────
  private onClick(e: MapMouseEvent) {
    if (app.view.kind === 'tour') return;
    const touch = (e.originalEvent as PointerEvent).pointerType === 'touch' || matchMedia('(pointer: coarse)').matches;
    const r = touch ? 24 : 14;
    const project = (lon: number, lat: number) => this.map.project([lon, lat]);
    const b = this.fleet.pick(project, e.point.x, e.point.y, r);
    if (b) return go({ kind: 'bus', id: b.id });
    const box: [[number, number], [number, number]] = [[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]];
    const st = this.map.queryRenderedFeatures(box, { layers: ['stations', 'station-fp', 'station-fp-3d', 'station-fp-roof'].filter((l) => this.map.getLayer(l) && this.map.getLayoutProperty(l, 'visibility') !== 'none') })[0];
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
    setMetroTheme(this.map, t);
    setObrasTheme(this.map, t);
    this.structs?.setTheme(t);
    this.speed?.setTheme(t);
    const rim: [number, number, number] = t === 'light' ? [0.97, 0.975, 0.98] : [0.063, 0.078, 0.094];
    const ring: [number, number, number] = t === 'light' ? [0.2, 0.24, 0.28] : [0.94, 0.95, 0.96];
    const mute: [number, number, number] = t === 'light' ? [0.78, 0.81, 0.84] : [0.16, 0.18, 0.21];
    const shadow = t === 'light' ? 0.22 : 0.55;
    this.buses.setColors(rim, ring, mute, shadow);
    this.dimBuses?.setColors(rim, ring, mute, shadow);
    this.map.triggerRepaint();
  }

  setIdle(ms: number) {
    app.idleMs = ms;
    savePrefs({ idleMs: ms });
    this.lastInput = Date.now();
  }

  dimBuses?: BusLayer;
  speed?: import('../map/speedLayer').SpeedLayer;

  /** Movimiento de los buses entre lecturas: continuo (por defecto) o directo a la última lectura. */
  setMotion(m: 'continuo' | 'directo') {
    app.motion = m;
    savePrefs({ motion: m });
    this.fleet.setMotion(m);
    this.map.triggerRepaint();
  }

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
    void setObras(m, l.obras);
    this.metro3d();
    this.obras3d();
    m.triggerRepaint();
  }

  /** Bus abierto: lo recorrido de su ruta, más apagado (R10.5). Una vez por segundo basta. */
  private traveled() {
    const b = this.selectedBus();
    if (!b || !b.onPath || !b.path || b.routeId !== this.fleet.focusRoute) { this.layers.setTraveled(null); return; }
    const len = b.path.cum[b.path.cum.length - 1];
    this.layers.setTraveled(len > 0 ? Math.min(1, Math.max(0, b.s / len)) : null);
  }

  /** Pulso sobre la ruta abierta cada `PULSE_EVERY`: con la pestaña visible y el mapa quieto. */
  private pulseAt = 0;
  private pulse() {
    if (app.view.kind !== 'route') return;
    const now = performance.now();
    if (now - this.pulseAt < PULSE_EVERY || document.hidden) return;
    if (this.map.isMoving() || this.pointers.size > 0 || this.flying) return; // en el próximo segundo
    this.pulseAt = now;
    this.layers.pulseFocus();
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
    this.metro3d();
    this.obras3d();
    // Los edificios van debajo de la red: la tapan donde corresponde, pero nunca a los buses.
    this.map.setLayoutProperty('building-3d', 'visibility', on ? 'visible' : 'none');
    this.map.setLayoutProperty('building', 'visibility', on ? 'none' : 'visible');
    this.layers.set3d(on);
    this.structures();
    if (instant) { this.map.jumpTo({ pitch: on ? 55 : 0 }); return; }
    const v = app.view;
    if (app.following && this.selectedBus()) {
      if (on) { this.heading3dPrev = app.followHeading; this.setFollowHeading(true); }
      else { const prev = this.heading3dPrev ?? this.heading2d; this.heading3dPrev = null; this.setFollowHeading(prev); }
      return;
    }
    this.map.easeTo({ pitch: on ? 55 : 0, bearing: on ? (this.map.getBearing() || -18) : this.map.getBearing(), duration: 700 });
    this.afterMove(() => {
      if (v.kind === 'route' || v.kind === 'plan' || v.kind === 'station' || v.kind === 'stop') this.frame(v);
      if (v.kind === 'route') this.afterMove(() => { this.layers.drawFocus(1600); this.pulseAt = performance.now() + 1600; }, 900);
      if (v.kind === 'plan') this.afterMove(() => this.layers.drawPlan(), 900);
    }, 700);
  }

  /** Puentes de la troncal en 3D (F7.5): tableros y buses encima. Se cargan la primera vez que hacen
   * falta (vista 3D y z ≥ 14,5); fuera de 3D, todos los buses van al suelo. */
  private elevation: Elevation | null = null;
  /** Estructuras en WebGL (troncal, metro, obras), en dos pasadas: opaca y translúcida. */
  structs?: Structures;
  private structures = () => {
    if (this.structs) { this.structs.show('tm', app.threeD); this.cable3d(); this.map.triggerRepaint(); }
    if (!app.threeD) { this.fleet.elevation = null; return; }
    if (this.elevation) { this.fleet.elevation = (x, y, hx, hy) => this.elevation!.at(x, y, hx, hy); return; }
    if (this.map.getZoom() < 14.5) return;
    void this.net.loadStructures().then(() => {
      const pieces = this.net.pieces;
      if (!pieces?.length) return;
      this.elevation ??= new Elevation(pieces);
      this.structs?.set('tm', (solid, glass) => { const deep: [number, number][][] = []; buildStations(this.net, solid, glass, pieces, deep); buildBridges(pieces, solid, glass); buildTrenches(pieces, deep, solid, glass); buildFootbridges(this.net.foot, solid, glass); });
      this.structures();
      this.map.triggerRepaint();
    });
  };

  /** Metro L1 en 3D (viaducto, pilas, estaciones): con la capa del metro y la vista 3D. Se arma la
   * primera vez que hace falta, con los mismos datos de la capa 2D. */
  private metroBuilt: Promise<void> | null = null;
  /** Pilas, pórticos y estaciones armados (para revisar). */
  metroStats: MetroStats | null = null;
  private metro3d() {
    const on = app.layersOn.metro && app.threeD;
    if (!this.structs) return;
    if (on && !this.metroBuilt) {
      // Con los carriles y andenes de la troncal: donde una pila caería sobre ella va un pórtico.
      this.metroBuilt = Promise.all([loadMetro(), this.net.loadLanes()]).then(([data]) => {
        const platforms: [number, number][][] = [];
        for (const st of this.net.stations.values()) {
          if (st.prov || st.closed) continue;
          for (const r of st.fp ?? []) platforms.push(r.map(([lo, la]) => [lo * KX, la * KY] as [number, number]));
        }
        const below = { lanes: (this.net.lanes ?? []).map((l) => l.c), corridors: (this.net.lanes ?? []).map((l) => l.z), platforms };
        this.structs!.set('metro', (solid, glass) => { this.metroStats = buildMetro(data, solid, glass, below); }, 13);
      }).catch(() => { this.metroBuilt = null; });
    }
    if (!this.metroBuilt) return;
    void this.metroBuilt.then(() => { this.structs?.show('metro', app.layersOn.metro && app.threeD); this.map.triggerRepaint(); });
  }

  /** TransMiCable en 3D (torres, cables y estaciones): con la vista 3D, siempre. */
  private cableBuilt: Promise<void> | null = null;
  private cable3d() {
    if (!this.structs) return;
    if (app.threeD && !this.cableBuilt) {
      this.cableBuilt = loadCable().then((d) => { this.structs!.set('cable', (solid, glass) => buildCable(d, solid, glass), 0); }).catch(() => { this.cableBuilt = null; });
    }
    if (!this.cableBuilt) return;
    void this.cableBuilt.then(() => { this.structs?.show('cable', app.threeD); this.map.triggerRepaint(); });
  }

  /** Troncales en obra en 3D (puentes y deprimidos con el diseño terminado): con el modo de obras y la
   * vista 3D. */
  private obrasBuilt: Promise<void> | null = null;
  private obras3d() {
    if (!this.structs) return;
    if (app.layersOn.obras && app.threeD && !this.obrasBuilt) {
      this.obrasBuilt = loadObras().then((d) => { this.structs!.set('obras', (solid, glass) => buildObras(d, solid, glass), 13); }).catch(() => { this.obrasBuilt = null; });
    }
    if (!this.obrasBuilt) return;
    void this.obrasBuilt.then(() => { this.structs?.show('obras', app.layersOn.obras && app.threeD); this.map.triggerRepaint(); });
  }

  /** Rutas para el respaldo por ruta: la abierta, la del bus abierto o las de los tramos del viaje. */
  private backupCodes(): string[] {
    const v = app.view;
    // Por los códigos que lleva el bus (A153, C153), no por el del catálogo (CA153), que el servicio
    // por ruta puede no conocer.
    const of = (r: Route | undefined) => (r ? busCodes(r) : []);
    if (v.kind === 'route') return of(this.net.routes.get(v.id));
    if (v.kind === 'bus') { const b = this.fleet.buses.get(v.id); const leg = b?.route && b.onPath ? legAtS(b.route, b.sFix) : null; return leg ? [leg.c] : of(b?.route); }
    if (v.kind === 'plan' && this.fleet.focusRoutes) return [...this.fleet.focusRoutes].flatMap((id) => of(this.net.routes.get(id)));
    return [];
  }

  /** Encuadra una troncal entera (desde «Ahora»). */
  showCorridor(z: string) {
    const segs = this.net.corridors.filter((c) => c.z === z);
    if (!segs.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of segs) for (const [x, y] of c.c) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    this.map.fitBounds([[x0, y0], [x1, y1]], { padding: this.padding(48, true), duration: 900, absolutePadding: true });
  }

  zoom(d: number) { this.map.easeTo({ zoom: this.map.getZoom() + d, duration: 220 }); }
  north() { this.map.easeTo({ bearing: 0, pitch: app.threeD ? this.map.getPitch() : 0, duration: 400 }); }
  overview() {
    this.map.fitBounds([[-74.23, 4.47], [-74.02, 4.83]], { padding: this.padding(24, true), duration: 900, absolutePadding: true });
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

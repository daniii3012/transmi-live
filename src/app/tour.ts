import type { LngLatLike, Map as MLMap } from 'maplibre-gl';
import type { Network } from '../data/network';
import type { Fleet, Bus } from '../live/fleet';
import type { NetworkLayers } from '../map/networkLayers';
import type { SpeedLayer } from '../map/speedLayer';
import { KX, KY } from '../domain/geo';
import { busCode, legAtS } from '../domain/legs';
import { stationLoads } from './now';
import { app } from './store.svelte';

/**
 * Recorrido automático (R9, R10.8): la página como pieza de visualización. Pasos en orden aleatorio,
 * de 30 a 45 s cada uno, sin repetir el anterior: la ciudad entera girando despacio, cada troncal
 * siguiendo a uno de sus buses en movimiento con la cámara hacia donde va, y paradas temáticas con
 * datos de ahora: la estación con más buses llegando, el tramo más lento, un portal y, en 3D,
 * TransMiCable. Una parada sin datos se salta. Cualquier toque, rueda o tecla lo termina (lo hace el
 * controlador).
 *
 * Sin buses en vivo (alimentador detenido, madrugada), cada troncal se muestra entera sin seguir a
 * nadie. Con «reducir movimiento», cortes en lugar de vuelos y sin giros de cámara.
 */

const FLY_MS = 2800;
const stepMs = () => 30_000 + Math.random() * 15_000;

export type StepKind = 'overview' | 'corridor' | 'station' | 'slow' | 'portal' | 'cable';
interface Step { kind: StepKind; key: string }

export interface TourState {
  /** Paso actual y total de la vuelta. */
  step: number;
  total: number;
  kind: StepKind;
  /** Título y una línea de detalle (con cifras de ahora; lo estimado lo dice). */
  title: string;
  detail: string;
  color: string | null;
  zone: { letter: string; name: string; color: string } | null;
  /** Buses troncales de la troncal en vía (paso de troncal). */
  buses: number;
  /** Bus seguido (si hay). */
  bus: { id: string; label: string; code: string; dest: string; color: string } | null;
  startedAt: number;
  duration: number;
}

export class Tour {
  private timer = 0;
  private raf = 0;
  private step = -1;
  private steps: Step[] = [];
  private following: string | null = null;
  private flying = false;
  private stopped = false;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private lastFrame = 0;
  private last: string | null = null;
  /** Ejes de cada troncal (metros) con su rectángulo, para saber qué buses van por ella. */
  private axes = new Map<string, { pts: Float64Array; box: [number, number, number, number] }[]>();

  constructor(
    private map: MLMap,
    private net: Network,
    private fleet: Fleet,
    private layers: NetworkLayers,
    private zones: Record<string, { name: string; color: string }>,
    private speed: SpeedLayer | undefined,
    private cable: () => Promise<[number, number][] | null>,
  ) {}

  start() {
    this.stopped = false;
    if (!this.axes.size) {
      for (const seg of this.net.corridors) {
        if (!seg.z || seg.c.length < 2) continue;
        const pts = new Float64Array(seg.c.length * 2);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        seg.c.forEach(([lo, la], i) => { const x = lo * KX, y = la * KY; pts[2 * i] = x; pts[2 * i + 1] = y; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
        let l = this.axes.get(seg.z);
        if (!l) this.axes.set(seg.z, (l = []));
        l.push({ pts, box: [x0 - 60, y0 - 60, x1 + 60, y1 + 60] });
      }
    }
    this.next();
  }

  /** Buses troncales y duales que van ahora por la troncal `z` (a menos de 60 m de su eje), sea cual sea
   * la zona de su ruta: una ruta de la Calle 26 puede ir por la Autonorte. */
  private busesOn(z: string): Bus[] {
    const axes = this.axes.get(z);
    if (!axes) return [];
    const out: Bus[] = [];
    for (const b of this.fleet.buses.values()) {
      if ((b.sys !== 'troncal' && b.sys !== 'dual') || b.missing || b.age > 300 || this.fleet.isHidden(b)) continue;
      const x = b.fixX, y = b.fixY;
      let on = false;
      for (const a of axes) {
        if (x < a.box[0] || x > a.box[2] || y < a.box[1] || y > a.box[3]) continue;
        const p = a.pts;
        for (let i = 2; i < p.length && !on; i += 2) {
          const ax = p[i - 2], ay = p[i - 1], dx = p[i] - ax, dy = p[i + 1] - ay, l2 = dx * dx + dy * dy;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
          on = (ax + dx * t - x) ** 2 + (ay + dy * t - y) ** 2 < 3600;
        }
        if (on) break;
      }
      if (on) out.push(b);
    }
    return out;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);
    this.map.stop();
    this.following = null;
    this.fleet.selectedId = null;
    this.fleet.focusRoute = null;
    this.layers.setFocus(null);
    this.layers.setSelectedPlace(null);
    app.tour = null;
  }

  /** Pasos posibles ahora, barajados; el primero no repite el último de la vuelta anterior. */
  private plan(): Step[] {
    // Troncales con eje en el mapa y, si hay buses en vivo, con alguno sobre ella ahora.
    const live = [...this.fleet.buses.values()].some((b) => b.sys === 'troncal' && !b.missing && b.age < 300);
    const letters = Object.keys(this.zones).filter((z) => this.axes.has(z) && (!live || this.busesOn(z).length > 0));
    const with_ = live ? new Set(letters) : new Set<string>();
    const out: Step[] = [{ kind: 'overview', key: '' }, ...letters.map((z) => ({ kind: 'corridor' as const, key: z }))];
    if (with_.size) out.push({ kind: 'station', key: '' }, { kind: 'slow', key: '' });
    const portals = [...this.net.stations.values()].filter((s) => s.kind === 'portal' && !s.closed);
    if (portals.length) out.push({ kind: 'portal', key: portals[Math.floor(Math.random() * portals.length)].id });
    if (app.threeD) out.push({ kind: 'cable', key: '' });
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    if (out.length > 1 && `${out[0].kind}:${out[0].key}` === this.last) out.push(out.shift()!);
    return out;
  }

  private next() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);
    this.map.stop();
    this.step++;
    if (this.step >= this.steps.length) { this.steps = this.plan(); this.step = 0; }
    const s = this.steps[this.step];
    this.last = `${s.kind}:${s.key}`;
    this.reset();
    const ms = stepMs();
    const ok =
      s.kind === 'overview' ? this.overview(ms) :
      s.kind === 'corridor' ? this.corridor(s.key, ms) :
      s.kind === 'station' ? this.busiest(ms) :
      s.kind === 'slow' ? this.slow(ms) :
      s.kind === 'portal' ? this.portal(s.key, ms) :
      this.cableStep(ms);
    // Paso sin datos ahora: el siguiente, sin esperar.
    if (ok === false) { this.timer = window.setTimeout(() => this.next(), 0); return; }
    this.timer = window.setTimeout(() => this.next(), ms);
  }

  private reset() {
    this.following = null;
    this.fleet.selectedId = null;
    this.fleet.focusRoute = null;
    this.layers.setFocus(null);
    this.layers.setSelectedPlace(null);
  }

  private publish(kind: StepKind, ms: number, p: Partial<TourState>) {
    app.tour = {
      step: this.step, total: this.steps.length, kind, title: '', detail: '', color: null, zone: null, buses: 0, bus: null,
      startedAt: performance.now(), duration: ms, ...p,
    };
  }

  /** La ciudad entera, girando despacio. */
  private overview(ms: number) {
    let n = 0;
    for (const b of this.fleet.buses.values()) if (!b.missing && b.age <= 300 && !this.fleet.isHidden(b)) n++;
    this.publish('overview', ms, { title: 'Bogotá', detail: `${n.toLocaleString('es-CO')} buses en vía en los sistemas visibles` });
    const cam = this.map.cameraForBounds([[-74.21, 4.5], [-74.03, 4.8]], { padding: 40 });
    if (!cam) return;
    const pitch = app.threeD ? 45 : 0;
    this.orbit({ center: cam.center, zoom: (cam.zoom ?? 11) - 0.1, bearing: this.map.getBearing(), pitch }, ms, 20);
  }

  /** Una troncal: sigue a uno de sus buses en movimiento; sin buses, la troncal entera. */
  private corridor(z: string, ms: number) {
    const zinfo = { letter: z, ...this.zones[z] };
    const on = this.busesOn(z);
    const buses = on.length;
    const bus = this.pickBus(on);
    const leg = bus?.route && bus.onPath ? legAtS(bus.route, bus.sFix) : null;
    this.publish('corridor', ms, {
      title: `Troncal ${zinfo.name}`, color: zinfo.color, zone: zinfo, buses,
      bus: bus && bus.route ? { id: bus.id, label: bus.label, code: leg?.c ?? busCode(bus.route), dest: leg?.d ?? bus.route.dest, color: bus.route.color } : null,
    });
    if (!bus) {
      const segs = this.net.corridors.filter((s) => s.z === z);
      if (!segs.length) return false;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of segs) for (const [x, y] of s.c) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const cam = this.map.cameraForBounds([[x0, y0], [x1, y1]], { padding: 80 });
      if (cam) this.fly({ center: cam.center, zoom: cam.zoom ?? 13, bearing: this.map.getBearing(), pitch: app.threeD ? 50 : 0 });
      return;
    }
    this.following = bus.id;
    this.fleet.selectedId = bus.id;
    this.fleet.focusRoute = bus.routeId;
    this.layers.setFocus(bus.routeId);
    this.fleet.update(Date.now());
    // En 3D, detrás del bus (como al seguir uno, R10.3); en 2D, rumbo arriba algo inclinado.
    const behind = app.threeD;
    const h = this.map.getContainer().clientHeight;
    const offset: [number, number] = [0, Math.round(h * (behind ? 0.2 : 0.08))];
    this.fly({ center: [bus.x / KX, bus.y / KY], zoom: behind ? 16.6 : 15.4, bearing: this.headingOf(bus), pitch: behind ? 62 : 35, offset }, () => this.follow(offset));
  }

  /** La estación con más buses llegando en 5 min (estimado), con la cámara girando alrededor. */
  private busiest(ms: number) {
    const loads = stationLoads(this.net, this.fleet, app.version, Date.now());
    let best: { id: string; n: number } | null = null;
    for (const [id, n] of loads) if (!best || n > best.n) best = { id, n };
    const st = best ? this.net.stations.get(best.id) : undefined;
    if (!st || !best || best.n < 2) return false;
    this.layers.setSelectedPlace(st.id);
    this.publish('station', ms, { title: st.short, detail: `Estación con más llegadas ahora: ${best.n} buses en los próximos 5 min (estimado)` });
    this.orbit({ center: [st.lon, st.lat], zoom: 16.3, bearing: this.map.getBearing(), pitch: app.threeD ? 60 : 40 }, ms, 50);
  }

  /** El tramo más lento de la troncal ahora (velocidad medida con los buses que pasan). */
  private slow(ms: number) {
    const s = this.speed?.slowest();
    if (!s || s.v > 15) return false;
    let near = '', bd = Infinity;
    for (const st of this.net.stations.values()) {
      const d = (st.lon - s.lon) ** 2 * KX * KX + (st.lat - s.lat) ** 2 * KY * KY;
      if (d < bd) { bd = d; near = st.short; }
    }
    this.publish('slow', ms, { title: 'Tramo más lento', detail: `Cerca de ${near} · ${Math.round(s.v)} km/h, medida con ${s.n} ${s.n === 1 ? 'bus' : 'buses'} en las lecturas recientes` });
    this.orbit({ center: [s.lon, s.lat], zoom: 15.6, bearing: this.map.getBearing(), pitch: app.threeD ? 55 : 30 }, ms, 25);
  }

  /** Un portal al azar, girando alrededor, con sus llegadas de los próximos 5 min. */
  private portal(id: string, ms: number) {
    const st = this.net.stations.get(id);
    if (!st) return false;
    const n = stationLoads(this.net, this.fleet, app.version, Date.now()).get(id) ?? 0;
    this.layers.setSelectedPlace(st.id);
    this.publish('portal', ms, { title: st.short, detail: n ? `${n} ${n === 1 ? 'bus llega' : 'buses llegan'} en los próximos 5 min (estimado)` : 'Sin llegadas estimadas en los próximos 5 min' });
    this.orbit({ center: [st.lon, st.lat], zoom: 15.9, bearing: this.map.getBearing(), pitch: app.threeD ? 60 : 40 }, ms, 50);
  }

  /** TransMiCable en 3D: la línea entera, girando despacio. */
  private cableStep(ms: number) {
    if (!app.threeD) return false;
    this.publish('cable', ms, { title: 'TransMiCable', detail: 'Portal Tunal – Mirador del Paraíso · cabinas sin posición en vivo', color: '#e30613' });
    void this.cable().then((pts) => {
      if (this.stopped || !pts?.length || app.tour?.kind !== 'cable') return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const cam = this.map.cameraForBounds([[x0, y0], [x1, y1]], { padding: 60 });
      if (cam) this.orbit({ center: cam.center, zoom: Math.min(16, (cam.zoom ?? 15) + 0.2), bearing: this.map.getBearing(), pitch: 62 }, ms, 40);
    });
  }

  /** De los buses sobre la troncal, uno en movimiento y lejos del final de su recorrido (que no termine
   * en el paso). */
  private pickBus(on: Bus[]): Bus | null {
    let best: Bus | null = null, score = -Infinity;
    for (const b of on) {
      const r = b.route;
      if (!r || !b.onPath || b.age > 150) continue;
      const left = r.len - b.sFix;
      if (left < 1500) continue;
      const s = (b.speed ?? 0) * 2 + Math.min(left, 6000) / 1000 + Math.random() * 3;
      if (s > score) { score = s; best = b; }
    }
    return best;
  }

  /** Rumbo de brújula del bus (grados): la cámara mira hacia donde va. */
  private headingOf(b: Bus): number {
    return (Math.atan2(b.hx, b.hy) * 180) / Math.PI;
  }

  /** Vuelo y, al llegar, giro lento de `deg` grados durante lo que queda del paso. */
  private orbit(to: { center: LngLatLike | undefined; zoom: number; bearing: number; pitch: number }, ms: number, deg: number) {
    const b0 = to.bearing;
    this.fly(to, () => {
      if (!this.reduced) this.map.easeTo({ bearing: b0 + deg, duration: Math.max(1000, ms - FLY_MS), easing: (t) => t });
    });
  }

  private fly(opts: { center: LngLatLike | undefined; zoom: number; bearing: number; pitch: number; offset?: [number, number] }, done?: () => void) {
    this.flying = true;
    const end = () => { this.flying = false; if (!this.stopped) done?.(); };
    if (this.reduced) {
      this.map.jumpTo({ center: opts.center, zoom: opts.zoom, pitch: opts.pitch, bearing: this.map.getBearing() });
      setTimeout(end, 0);
      return;
    }
    this.map.flyTo({ ...opts, duration: FLY_MS, essential: true, curve: 1.6 });
    this.map.once('moveend', end);
  }

  /** Cámara pegada al bus, girando suave hacia su rumbo; 30 cuadros por segundo bastan. */
  private follow(offset: [number, number]) {
    const tick = (t: number) => {
      if (this.stopped || !this.following) return;
      this.raf = requestAnimationFrame(tick);
      if (this.flying || t - this.lastFrame < 33) return;
      const dt = this.lastFrame ? t - this.lastFrame : 33;
      this.lastFrame = t;
      const b = this.fleet.buses.get(this.following);
      if (!b) { this.next(); return; }
      this.fleet.update(Date.now());
      const m = this.map;
      let bearing = m.getBearing();
      if (!this.reduced) {
        const d = ((this.headingOf(b) - bearing + 540) % 360) - 180;
        bearing += d * Math.min(1, dt / 1500);
        m.setBearing(bearing);
      }
      // El bus queda `offset` por debajo del centro (con el rumbo ya girado).
      const p = m.project([b.x / KX, b.y / KY]);
      m.jumpTo({ center: m.unproject([p.x - offset[0], p.y - offset[1]]), bearing });
    };
    this.raf = requestAnimationFrame(tick);
  }
}

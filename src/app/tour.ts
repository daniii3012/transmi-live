import type { LngLatLike, Map as MLMap } from 'maplibre-gl';
import type { Network } from '../data/network';
import type { Fleet, Bus } from '../live/fleet';
import type { NetworkLayers } from '../map/networkLayers';
import { KX, KY } from '../domain/geo';
import { busCode, legAtS } from '../domain/legs';
import { app } from './store.svelte';

/**
 * Recorrido automático (revisión R9): la página como pieza de visualización. Alterna una vista de la
 * ciudad con un paseo por cada troncal siguiendo uno de sus buses en movimiento, con la cámara
 * orientada hacia donde va. Cualquier toque, rueda o tecla lo termina (lo hace el controlador).
 *
 * Sin buses en vivo (alimentador detenido, madrugada), cada troncal se muestra entera sin seguir a
 * nadie. Con «reducir movimiento», cortes en lugar de vuelos y sin giros de cámara.
 */

/** Orden de las troncales: de norte a sur y de oriente a occidente, para que los vuelos sean cortos. */
const ORDER = ['B', 'A', 'L', 'M', 'K', 'J', 'D', 'C', 'E', 'G', 'H', 'F', 'S'];
const OVERVIEW_MS = 12_000;
const CORRIDOR_MS = 24_000;
const FLY_MS = 2800;

export interface TourState {
  /** Paso actual (0 = ciudad) y total de pasos de la vuelta. */
  step: number;
  total: number;
  kind: 'overview' | 'corridor';
  zone: { letter: string; name: string; color: string } | null;
  /** Buses troncales de la troncal en vía. */
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
  private steps: (string | null)[] = [];
  private following: string | null = null;
  private flying = false;
  private stopped = false;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private lastFrame = 0;

  constructor(
    private map: MLMap,
    private net: Network,
    private fleet: Fleet,
    private layers: NetworkLayers,
    private zones: Record<string, { name: string; color: string }>,
  ) {}

  start() {
    this.stopped = false;
    this.next();
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
    app.tour = null;
  }

  /** Troncales con buses ahora (en el orden de `ORDER`), y la vista de la ciudad al principio. */
  private plan(): (string | null)[] {
    const with_ = new Set<string>();
    for (const b of this.fleet.buses.values()) if (b.sys === 'troncal' && b.route?.zone && !b.missing && b.age < 300) with_.add(b.route.zone);
    const letters = ORDER.filter((z) => this.zones[z] && (with_.size === 0 || with_.has(z)));
    return [null, ...letters];
  }

  private next() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);
    this.step++;
    if (this.step >= this.steps.length) { this.steps = this.plan(); this.step = 0; }
    const z = this.steps[this.step];
    if (z === null) this.overview();
    else this.corridor(z);
  }

  private publish(kind: TourState['kind'], zone: string | null, bus: Bus | null, duration: number) {
    const zinfo = zone ? { letter: zone, ...this.zones[zone] } : null;
    let buses = 0;
    for (const b of this.fleet.buses.values()) {
      if (b.sys !== 'troncal' || b.missing || b.age > 300) continue;
      if (!zone || b.route?.zone === zone) buses++;
    }
    const leg = bus?.route && bus.onPath ? legAtS(bus.route, bus.sFix) : null;
    app.tour = {
      step: this.step, total: this.steps.length, kind, zone: zinfo, buses,
      bus: bus && bus.route ? { id: bus.id, label: bus.label, code: leg?.c ?? busCode(bus.route), dest: leg?.d ?? bus.route.dest, color: bus.route.color } : null,
      startedAt: performance.now(), duration,
    };
  }

  /** La ciudad entera, girando despacio. */
  private overview() {
    this.following = null;
    this.fleet.selectedId = null;
    this.fleet.focusRoute = null;
    this.layers.setFocus(null);
    this.publish('overview', null, null, OVERVIEW_MS);
    const cam = this.map.cameraForBounds([[-74.21, 4.5], [-74.03, 4.8]], { padding: 40 });
    const bearing = this.map.getBearing();
    if (!cam) { this.timer = window.setTimeout(() => this.next(), OVERVIEW_MS); return; }
    const pitch = app.threeD ? 45 : 0;
    this.fly({ center: cam.center, zoom: (cam.zoom ?? 11) - 0.1, bearing, pitch }, () => {
      if (!this.reduced) this.map.easeTo({ bearing: bearing + 20, duration: OVERVIEW_MS - FLY_MS, easing: (t) => t });
    });
    this.timer = window.setTimeout(() => this.next(), OVERVIEW_MS);
  }

  /** Una troncal: sigue a uno de sus buses en movimiento; sin buses, la troncal entera. */
  private corridor(z: string) {
    const bus = this.pickBus(z);
    this.publish('corridor', z, bus, CORRIDOR_MS);
    if (!bus) {
      this.following = null;
      this.fleet.selectedId = null;
      this.fleet.focusRoute = null;
      this.layers.setFocus(null);
      const segs = this.net.corridors.filter((s) => s.z === z);
      if (!segs.length) { this.next(); return; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of segs) for (const [x, y] of s.c) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const cam = this.map.cameraForBounds([[x0, y0], [x1, y1]], { padding: 80 });
      if (cam) this.fly({ center: cam.center, zoom: cam.zoom ?? 13, bearing: this.map.getBearing(), pitch: app.threeD ? 50 : 0 });
      this.timer = window.setTimeout(() => this.next(), CORRIDOR_MS / 2);
      return;
    }
    this.following = bus.id;
    this.fleet.selectedId = bus.id;
    this.fleet.focusRoute = bus.routeId;
    this.layers.setFocus(bus.routeId);
    this.fleet.update(Date.now());
    this.fly({ center: [bus.x / KX, bus.y / KY], zoom: 15.4, bearing: this.headingOf(bus), pitch: app.threeD ? 55 : 35 }, () => this.follow());
    this.timer = window.setTimeout(() => this.next(), CORRIDOR_MS);
  }

  /** Un bus de la troncal en movimiento, lejos de las puntas de su recorrido (que no termine en el paso). */
  private pickBus(z: string): Bus | null {
    let best: Bus | null = null, score = -Infinity;
    for (const b of this.fleet.buses.values()) {
      const r = b.route;
      if (b.sys !== 'troncal' || r?.zone !== z || !b.onPath || b.missing || b.age > 150) continue;
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

  private fly(opts: { center: LngLatLike | undefined; zoom: number; bearing: number; pitch: number }, done?: () => void) {
    this.flying = true;
    const end = () => { this.flying = false; if (!this.stopped) done?.(); };
    if (this.reduced) {
      this.map.jumpTo({ ...opts, bearing: this.map.getBearing() });
      setTimeout(end, 0);
      return;
    }
    this.map.flyTo({ ...opts, duration: FLY_MS, essential: true, curve: 1.6 });
    this.map.once('moveend', end);
  }

  /** Cámara pegada al bus, girando suave hacia su rumbo; 30 cuadros por segundo bastan. */
  private follow() {
    const tick = (t: number) => {
      if (this.stopped || !this.following) return;
      this.raf = requestAnimationFrame(tick);
      if (this.flying || t - this.lastFrame < 33) return;
      this.lastFrame = t;
      const b = this.fleet.buses.get(this.following);
      if (!b) { this.next(); return; }
      this.fleet.update(Date.now());
      const target = this.headingOf(b);
      let bearing = this.map.getBearing();
      if (!this.reduced) {
        const d = ((target - bearing + 540) % 360) - 180;
        bearing += d * 0.02;
      }
      this.map.jumpTo({ center: [b.x / KX, b.y / KY], bearing });
    };
    this.raf = requestAnimationFrame(tick);
  }
}

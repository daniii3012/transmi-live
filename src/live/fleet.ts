import type { Network } from '../data/network';
import type { Route, SystemKey } from '../domain/types';
import { KX, KY, type MetricPath } from '../domain/geo';
import { LAT0, LON0, Q, type VehiclesV1 } from './api';

/** Reglas medidas en el simulador sobre 706.281 lecturas troncales (ver decisiones/006). */
export const MAX_OFF = 60;
export const HOLD_BACK = 30;
export const MAX_JUMP = 3000;
/** Más viejo que esto, el bus se atenúa; más que `DROP_AGE`, no se dibuja. */
export const STALE_AGE = 180;
export const DROP_AGE = 600;

export interface Bus {
  id: string;
  label: string;
  plate: string;
  routeId: string;
  route: Route | undefined;
  path: MetricPath | undefined;
  sys: SystemKey | undefined;
  /** Lectura más reciente. */
  fixX: number;
  fixY: number;
  fixAt: number;
  age: number;
  stopId: string;
  seq: number;
  start: number;
  /** Movimiento sobre el recorrido. */
  onPath: boolean;
  offPath: number;
  sFix: number;
  s0: number;
  s1: number;
  /** Movimiento en línea recta (fuera del recorrido). */
  x0: number; y0: number; x1: number; y1: number;
  t0: number;
  t1: number;
  /** Velocidad media reciente (m/s) a lo largo del recorrido. */
  speed: number | null;
  bornAt: number;
  /** Posición del último cuadro (metros) y rumbo (vector unitario este/norte). */
  x: number;
  y: number;
  hx: number;
  hy: number;
  s: number;
}

const hexRGB = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** Tamaño relativo por sistema: articulados de 18 m en troncal y dual, 12 m en zonal. */
const SIZE: Record<SystemKey, number> = { troncal: 1, dual: 1, alimentador: 0.68, zonal: 0.66, cable: 0.4 };

/** Desplazamiento en mercator (0–1) para una posición en metros locales. */
export function mercator(x: number, y: number, out: number[] | Float64Array) {
  const lon = x / KX, lat = y / KY;
  out[0] = (lon + 180) / 360;
  const s = Math.sin((lat * Math.PI) / 180);
  out[1] = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return out;
}

/** Origen de la capa (centro de Bogotá) para no perder precisión en float32. */
export const ORIGIN = mercator(-74.1 * KX, 4.65 * KY, [0, 0]) as number[];

/**
 * La flota en vivo: ubica cada lectura sobre el recorrido de su ruta y calcula, cuadro a cuadro,
 * dónde dibujar cada bus. Ver docs/ARQUITECTURA.md §4.3.
 */
export class Fleet {
  readonly buses = new Map<string, Bus>();
  feedTime = 0;
  /** Intervalo esperado entre lecturas nuevas (ms), estimado de las instantáneas recibidas. */
  interval = 20_000;
  hidden = new Set<SystemKey>();
  focusRoute: string | null = null;
  selectedId: string | null = null;
  hoverId: string | null = null;
  /** Buffer intercalado para la capa WebGL. */
  static readonly STRIDE = 10;
  private buf = new Float32Array(1024 * Fleet.STRIDE);
  private colors = new Map<string, [number, number, number]>();
  private lastFeedAt = 0;
  private tmp = new Float64Array(2);
  listeners = new Set<() => void>();

  constructor(private net: Network) {}

  /** Incorpora una instantánea. `now` en ms (reloj de pared). */
  ingest(d: VehiclesV1, now = Date.now()) {
    if (d.t !== this.feedTime) {
      if (this.lastFeedAt) {
        const gap = now - this.lastFeedAt;
        if (gap > 4000 && gap < 90_000) this.interval = Math.min(35_000, Math.max(8_000, 0.7 * this.interval + 0.3 * gap));
      }
      this.lastFeedAt = now;
    }
    this.feedTime = d.t;
    const seen = new Set<string>();
    for (let i = 0; i < d.n; i++) {
      const id = d.id[i] || d.label[i];
      seen.add(id);
      const lat = LAT0 + d.lat[i] / Q, lon = LON0 + d.lon[i] / Q;
      const x = lon * KX, y = lat * KY;
      const age = d.age[i];
      const fixAt = (d.t - age) * 1000;
      const routeId = d.route[i];
      let b = this.buses.get(id);
      if (b && b.fixAt === fixAt && b.routeId === routeId) {
        b.age = age;
        continue; // misma lectura: el bus no ha reportado de nuevo
      }
      if (!b || b.routeId !== routeId) {
        const route = this.net.routes.get(routeId);
        const fresh: Bus = {
          id, label: d.label[i], plate: d.plate[i], routeId, route, path: this.net.paths.get(routeId), sys: route?.sys,
          fixX: x, fixY: y, fixAt, age, stopId: d.stop[i], seq: d.seq[i], start: d.start[i],
          onPath: false, offPath: Infinity, sFix: 0, s0: 0, s1: 0, x0: x, y0: y, x1: x, y1: y, t0: now, t1: now,
          speed: null, bornAt: b ? b.bornAt : now, x, y, hx: 1, hy: 0, s: 0,
        };
        if (b) { fresh.x = b.x; fresh.y = b.y; fresh.hx = b.hx; fresh.hy = b.hy; }
        this.place(fresh, x, y, fixAt, now, true);
        this.buses.set(id, fresh);
        continue;
      }
      b.label = d.label[i];
      b.plate = d.plate[i];
      b.age = age;
      b.stopId = d.stop[i];
      b.seq = d.seq[i];
      b.start = d.start[i];
      this.place(b, x, y, fixAt, now, false);
    }
    for (const id of this.buses.keys()) if (!seen.has(id)) this.buses.delete(id);
    for (const f of this.listeners) f();
  }

  /** Ubica una lectura y programa el movimiento hasta ella. */
  private place(b: Bus, x: number, y: number, fixAt: number, now: number, first: boolean) {
    const path = b.path;
    const end = now + this.interval;
    if (path && path.size > 1) {
      const hit = path.nearest(x, y, first ? undefined : b.sFix, 250, 3500, MAX_OFF);
      if (hit && hit.d <= MAX_OFF) {
        const wasOn = b.onPath && !first;
        const cur = wasOn ? this.sAt(b, now) : hit.s;
        let target = hit.s;
        // Velocidad reciente sobre el recorrido.
        if (wasOn && b.fixAt) {
          const dt = (fixAt - b.fixAt) / 1000;
          if (dt > 5 && dt < 240) {
            const v = Math.max(0, (hit.s - b.sFix) / dt);
            b.speed = b.speed == null ? v : 0.5 * b.speed + 0.5 * v;
          }
        }
        if (target < cur && cur - target <= HOLD_BACK) target = cur; // ruido del GPS: no retrocede
        const teleport = !wasOn || target < cur || target - cur > MAX_JUMP;
        b.onPath = true;
        b.offPath = hit.d;
        b.sFix = hit.s;
        b.fixAt = fixAt;
        b.fixX = x;
        b.fixY = y;
        if (teleport) {
          b.s0 = b.s1 = target;
          b.t0 = b.t1 = now;
          if (!first) {
            // Fundido solo si el salto se ve; un ajuste corto no merece desaparecer.
            const q = path.pointAt(target, this.tmp);
            if (Math.hypot(q[0] - b.x, q[1] - b.y) > 150) b.bornAt = now;
          }
        } else {
          b.s0 = cur;
          b.s1 = target;
          b.t0 = now;
          b.t1 = end;
        }
        return;
      }
    }
    // Fuera de todo recorrido: línea recta desde donde se ve.
    const wasOn = b.onPath;
    b.onPath = false;
    b.offPath = Infinity;
    b.fixAt = fixAt;
    b.fixX = x;
    b.fixY = y;
    const jump = Math.hypot(x - b.x, y - b.y);
    if (first || wasOn || jump > MAX_JUMP) {
      b.x0 = b.x1 = x; b.y0 = b.y1 = y; b.t0 = b.t1 = now;
      if (!first && jump > MAX_JUMP) b.bornAt = now;
    } else {
      b.x0 = b.x; b.y0 = b.y; b.x1 = x; b.y1 = y; b.t0 = now; b.t1 = end;
    }
  }

  private sAt(b: Bus, now: number): number {
    if (now >= b.t1 || b.t1 <= b.t0) return b.s1;
    const k = (now - b.t0) / (b.t1 - b.t0);
    return b.s0 + (b.s1 - b.s0) * k;
  }

  private lastUpdate = 0;

  /**
   * Avanza todos los buses a `now`. Una búsqueda binaria por bus: posición sobre el segmento y
   * rumbo del segmento, suavizado en el tiempo (las esquinas giran en ~120 ms, sin saltos).
   * Devuelve si algún bus sigue en movimiento (para pedir otro cuadro).
   */
  update(now = Date.now()): boolean {
    const dt = this.lastUpdate ? Math.min(200, now - this.lastUpdate) : 1000;
    this.lastUpdate = now;
    const k = 1 - Math.exp(-dt / 120);
    let moving = false;
    for (const b of this.buses.values()) {
      if (now < b.t1) moving = true;
      if (b.onPath && b.path) {
        const s = this.sAt(b, now);
        const P = b.path;
        if (s === b.s && b.x !== 0) continue;
        const i = P.segmentAt(s);
        const a = P.cum[i - 1], l = P.cum[i] - a;
        const f = l > 0 ? Math.min(1, Math.max(0, (s - a) / l)) : 0;
        const dx = P.x[i] - P.x[i - 1], dy = P.y[i] - P.y[i - 1];
        b.x = P.x[i - 1] + dx * f;
        b.y = P.y[i - 1] + dy * f;
        const len = Math.hypot(dx, dy);
        if (len > 0) this.turn(b, dx / len, dy / len, b.s === 0 && b.hx === 1 && b.hy === 0 ? 1 : k);
        b.s = s;
      } else {
        const kk = now >= b.t1 || b.t1 <= b.t0 ? 1 : (now - b.t0) / (b.t1 - b.t0);
        const nx = b.x0 + (b.x1 - b.x0) * kk, ny = b.y0 + (b.y1 - b.y0) * kk;
        const dx = nx - b.x, dy = ny - b.y, l = Math.hypot(dx, dy);
        if (l > 0.3) this.turn(b, dx / l, dy / l, k);
        b.x = nx; b.y = ny;
      }
    }
    return moving;
  }

  /** ¿Algún bus se está desvaneciendo (aparece o reaparece)? */
  animating(now = Date.now()): boolean {
    for (const b of this.buses.values()) if (now - b.bornAt < 650) return true;
    return false;
  }

  private turn(b: Bus, tx: number, ty: number, k: number) {
    let hx = b.hx + (tx - b.hx) * k, hy = b.hy + (ty - b.hy) * k;
    const l = Math.hypot(hx, hy);
    if (l < 1e-6) { hx = tx; hy = ty; } else { hx /= l; hy /= l; }
    b.hx = hx; b.hy = hy;
  }

  private colorOf(b: Bus): [number, number, number] {
    const key = b.route?.color ?? '#8a929c';
    let c = this.colors.get(key);
    if (!c) { c = hexRGB(key); this.colors.set(key, c); }
    return c;
  }

  /**
   * Llena el buffer de la capa: [mx, my, hx, hy, r, g, b, alfa, tamaño, banderas] por bus, con los
   * atenuados primero y el seleccionado al final (se dibuja encima). Devuelve cuántos hay.
   * Banderas: 1 atenuado, 2 lectura vieja, 4 seleccionado, 8 bajo el cursor.
   */
  fill(now = Date.now()): { data: Float32Array; count: number } {
    const S = Fleet.STRIDE;
    if (this.buf.length < this.buses.size * S) this.buf = new Float32Array(Math.ceil(this.buses.size * 1.5) * S);
    const out = this.buf;
    const m = this.tmp;
    let n = 0;
    const focus = this.focusRoute;
    let selected: Bus | null = null;
    const write = (b: Bus, flags: number) => {
      mercator(b.x, b.y, m);
      const o = n * S;
      out[o] = m[0] - ORIGIN[0];
      out[o + 1] = m[1] - ORIGIN[1];
      out[o + 2] = b.hx;
      out[o + 3] = -b.hy; // mercator: y hacia el sur
      const c = this.colorOf(b);
      out[o + 4] = c[0]; out[o + 5] = c[1]; out[o + 6] = c[2];
      out[o + 7] = Math.min(1, (now - b.bornAt) / 600);
      out[o + 8] = b.sys ? SIZE[b.sys] : 0.66;
      out[o + 9] = flags;
      n++;
    };
    // Dos pasadas: atenuados abajo, el resto encima.
    for (let pass = 0; pass < 2; pass++) {
      for (const b of this.buses.values()) {
        if (b.age > DROP_AGE) continue;
        if (b.sys && this.hidden.has(b.sys)) continue;
        if (b.id === this.selectedId) { selected = b; continue; }
        const dim = !!focus && b.routeId !== focus;
        if ((pass === 0) !== dim) continue;
        write(b, (dim ? 1 : 0) | (b.age > STALE_AGE ? 2 : 0) | (b.id === this.hoverId ? 8 : 0));
      }
    }
    if (selected) write(selected, 4 | (selected.age > STALE_AGE ? 2 : 0));
    return { data: out, count: n };
  }

  /** Bus más cercano a un punto de pantalla, dentro de `radius` px. */
  pick(project: (lon: number, lat: number) => { x: number; y: number }, px: number, py: number, radius: number): Bus | null {
    let best: Bus | null = null, bd = radius * radius;
    for (const b of this.buses.values()) {
      if (b.age > DROP_AGE || (b.sys && this.hidden.has(b.sys))) continue;
      const p = project(b.x / KX, b.y / KY);
      const d = (p.x - px) ** 2 + (p.y - py) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  /** Conteo de buses por sistema (sin filtro). */
  counts(): Record<SystemKey, number> {
    const c: Record<SystemKey, number> = { troncal: 0, dual: 0, alimentador: 0, zonal: 0, cable: 0 };
    for (const b of this.buses.values()) if (b.sys && b.age <= DROP_AGE) c[b.sys]++;
    return c;
  }
}

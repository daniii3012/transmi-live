import type { Network } from '../data/network';
import type { Route, SystemKey } from '../domain/types';
import { KX, KY, type MetricPath } from '../domain/geo';
import { LAT0, LON0, Q, type VehiclesV1 } from './api';
import { busKind, type BusKind } from '../domain/fleetTypes';

/** Reglas medidas en el simulador sobre 706.281 lecturas troncales (ver decisiones/006). */
export const MAX_OFF = 60;
export const HOLD_BACK = 30;
export const MAX_JUMP = 3000;
/** Más allá de la última lectura, el bus sigue con su velocidad y se detiene suavemente en ~`EXTRA` ms. */
const EXTRA = 5000;
/** Recuperación del retraso propio de un bus tras una pausa del alimentador: se reproduce a 1,2×. */
const CATCH = 0.2;
/** Puntos recientes que se guardan por bus para la curva (lecturas y nudos de anclaje). */
const TRACK = 10;
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
  /** Tipo de bus por su etiqueta (articulado, biarticulado, dual), si se conoce. */
  kind: BusKind | null;
  /** Lectura más reciente. */
  fixX: number;
  fixY: number;
  fixAt: number;
  age: number;
  stopId: string;
  seq: number;
  start: number;
  /** Movimiento sobre el recorrido: lecturas recientes (hora en ms, abscisa en m, no decreciente). Se
   * reproducen con el retraso de la flota (`Fleet.lag`) más uno propio (`off`) que tras una pausa del
   * alimentador evita el salto y se recupera solo. */
  onPath: boolean;
  offPath: number;
  sFix: number;
  tt: number[];
  ts: number[];
  /** Velocidad fijada en un punto (m/ms; NaN: la de la curva). Los nudos de anclaje la llevan. */
  tm: number[];
  off: number;
  offAt: number;
  /** El próximo cuadro va directo a su punto (lectura reiniciada o bus fuera de vista). */
  snap: boolean;
  /** Lectura imposible respecto de las anteriores (salto o retroceso grande), en espera de que la
   * siguiente la confirme; si no, era un error del GPS y se descarta. El retraso de reproducción
   * permite esperar sin que se note. */
  suspect: { s: number; at: number } | null;
  /** Último cuadro calculado y velocidad dibujada (m/s). */
  drawnAt: number;
  v: number;
  /** Movimiento en línea recta (fuera del recorrido). */
  x0: number; y0: number; x1: number; y1: number;
  t0: number;
  t1: number;
  /** Velocidad media reciente (m/s) a lo largo del recorrido. */
  speed: number | null;
  /** Lecturas sobre el recorrido de los últimos 8 min (para el ritmo frente al horario). */
  hist: { at: number; s: number }[];
  bornAt: number;
  /** Hora de la última lectura nueva (para la onda de actualización) y desfase propio (0–1), para
   * que las ondas de una instantánea no salgan todas a la vez. */
  pingAt: number;
  seed: number;
  /** Posición del último cuadro (metros) y rumbo (vector unitario este/norte). */
  x: number;
  y: number;
  hx: number;
  hy: number;
  s: number;
}

/** Velocidad máxima que se muestra (m/s): 90 km/h. Entre 70 y 90 es rara pero posible (las troncales van
 * a 60; algún tramo de autopista); por encima, es un error del cálculo. */
export const MAX_SPEED = 90 / 3.6;

/**
 * Velocidad sobre el recorrido (m/s) entre la lectura más vieja de los últimos 3 min y la más reciente,
 * con al menos 20 s entre ellas: ninguna fuente la trae, se calcula. Con dos lecturas seguidas (como
 * antes), unos metros de error del GPS en pocos segundos daban 80 km/h; en una ventana se diluyen.
 * Sin ventana suficiente o por encima de 90 km/h, `null` (la ficha muestra «—», no una cifra falsa).
 */
export function windowSpeed(h: { at: number; s: number }[]): number | null {
  if (h.length < 2) return null;
  const last = h[h.length - 1];
  const first = h.find((e) => last.at - e.at <= 180_000);
  if (!first || last.at - first.at < 20_000) return null;
  const v = (last.s - first.s) / ((last.at - first.at) / 1000);
  return v >= 0 && v <= MAX_SPEED ? v : null;
}

/** Número estable en [0, 1) a partir del id del bus. */
function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

const hexRGB = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** Tamaño relativo por sistema: articulados de 18 m en troncal y dual, 12 m en zonal. */
const SIZE: Record<SystemKey, number> = { troncal: 1, dual: 1, alimentador: 0.68, zonal: 0.66, cable: 0.4 };
/** Largo relativo a un articulado de 18 m. El biarticulado mide 27 m. En el zonal no hay dato por bus:
 * se estima por el tipo de servicio (urbano, padrón de 12 m; complementario, busetón de ~10 m;
 * especial, buseta de ~8,5 m, la de las rutas de ladera). */
function sizeOf(b: Bus): number {
  // Por el tipo del bus: biarticulado 27 m, articulado y articulado dual 18 m, padrón dual 12 m.
  if (b.kind === 'biarticulated') return 1.5;
  if (b.kind === 'articulated' || b.kind === 'dual-articulated') return 1;
  if (b.kind === 'dual' || b.sys === 'dual') return 0.67;
  if (b.sys === 'zonal') return b.route?.sub === 'especial' ? 0.47 : b.route?.sub === 'complementario' ? 0.56 : 0.66;
  return b.sys ? SIZE[b.sys] : 0.66;
}

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
  /** Toda la flota atenuada (capa de velocidad encendida). */
  allDim = false;
  /** Buses puntuales en foco (llegadas resaltadas de una estación); manda sobre las rutas. */
  focusBuses: Set<string> | null = null;
  /** Varias rutas en foco a la vez (las de un viaje planeado); manda sobre `focusRoute`. */
  focusRoutes: Set<string> | null = null;
  selectedId: string | null = null;
  hoverId: string | null = null;
  /** Estelas para toda la flota (si no, solo la ruta en foco y el seleccionado). */
  trails = false;
  /** Buffer intercalado para la capa WebGL. */
  static readonly STRIDE = 14;
  /** Altura (m) sobre los puentes de la troncal, con la vista 3D (ver map/structures.ts). */
  elevation: ((x: number, y: number, hx: number, hy: number) => number) | null = null;
  /** Calcular el rumbo del tramo trasero (cuerpos 3D que se doblan en las curvas). */
  rearDirs = false;
  private rp0 = [0, 0];
  private rp1 = [0, 0];
  /** Buses que llegan pronto a la estación abierta: se marcan con una onda suave. */
  arriving = new Set<string>();
  private buf = new Float32Array(1024 * Fleet.STRIDE);
  private colors = new Map<string, [number, number, number]>();
  private lastFeedAt = 0;
  private tmp = new Float64Array(2);
  listeners = new Set<() => void>();

  constructor(private net: Network) {}

  /**
   * Retraso de reproducción (ms): los buses se dibujan donde estaban hace `lag`, entre lecturas
   * reales, para moverse sin paradas ni cambios bruscos aunque las instantáneas lleguen a destiempo
   * (el alimentador se regenera cada ~21 s y se consulta cada 15 s; a veces se detiene un minuto).
   * Para no quedarse sin lecturas justo antes de que llegue la siguiente, cubre el intervalo entre
   * lecturas (mediana de `gaps`) más lo que tardan en llegar (máximo de `delays`): ~43 s con el
   * alimentador de hoy, lo mismo que el modelo anterior al final de cada tramo. Cambia despacio (±10 %).
   * Una pausa más larga la absorbe el retraso propio de cada bus (`off`).
   */
  lag = 40_000;
  private lagTarget = 40_000;
  private delays: number[] = [];
  private gaps: number[] = [];

  /** Incorpora una instantánea. `now` en ms (reloj de pared). */
  ingest(d: VehiclesV1, now = Date.now()) {
    // La misma instantánea otra vez (alimentador detenido): nada nuevo. Sin esto, volverían los buses
    // que el respaldo por ruta reemplazó y se irían los suyos.
    if (d.t === this.feedTime && this.buses.size) return;
    // Lo que tarda en llegar una lectura nueva (todas las de una instantánea traen la misma hora) y el
    // intervalo entre instantáneas del alimentador.
    if (d.t !== this.feedTime && d.n) {
      const delay = now - d.t * 1000;
      if (delay > -30_000 && delay < 120_000) {
        this.delays.push(delay);
        if (this.delays.length > 8) this.delays.shift();
      }
      if (this.feedTime && d.t > this.feedTime) {
        this.gaps.push((d.t - this.feedTime) * 1000);
        if (this.gaps.length > 8) this.gaps.shift();
      }
      if (this.delays.length) {
        const g = this.gaps.length ? [...this.gaps].sort((a, b) => a - b)[this.gaps.length >> 1] : 20_000;
        this.lagTarget = Math.min(60_000, Math.max(8_000, Math.min(g, 40_000) + Math.max(...this.delays) + 1000));
        if (!this.lastFeedAt) this.lag = this.lagTarget;
      }
    }
    if (d.t !== this.feedTime) {
      if (this.lastFeedAt) {
        const gap = now - this.lastFeedAt;
        if (gap > 4000 && gap < 90_000) this.interval = Math.min(35_000, Math.max(8_000, 0.7 * this.interval + 0.3 * gap));
      }
      this.lastFeedAt = now;
    }
    this.feedTime = d.t;
    const seen = new Set<string>();
    for (let i = 0; i < d.n; i++) seen.add(this.upsert(d, i, now));
    for (const id of this.buses.keys()) if (!seen.has(id)) this.buses.delete(id);
    for (const f of this.listeners) f();
  }

  /**
   * Lecturas de UNA ruta (respaldo por ruta, ver live/backup.svelte.ts): se incorporan como las del
   * alimentador, pero sin quitar los demás buses ni tocar el ritmo del alimentador (retraso, intervalo).
   */
  merge(d: VehiclesV1, now = Date.now(), replaceCodes: string[] = []) {
    const got = new Set<string>();
    for (let i = 0; i < d.n; i++) got.add(this.upsert(d, i, now));
    // Con `replaceCodes`, el respaldo reemplaza a esas rutas: sus buses que no vinieron en él salen.
    if (replaceCodes.length) {
      const codes = new Set(replaceCodes.map((c) => c.toUpperCase()));
      for (const [id, b] of this.buses) if (!got.has(id) && b.route && codes.has(b.route.code.toUpperCase())) this.buses.delete(id);
    }
    for (const f of this.listeners) f();
  }

  /** Incorpora la lectura `i` de una instantánea; devuelve el id del bus. */
  private upsert(d: VehiclesV1, i: number, now: number): string {
    const id = d.id[i] || d.label[i];
    const lat = LAT0 + d.lat[i] / Q, lon = LON0 + d.lon[i] / Q;
    const x = lon * KX, y = lat * KY;
    const age = d.age[i];
    const fixAt = (d.t - age) * 1000;
    const routeId = d.route[i];
    let b = this.buses.get(id);
    if (b && b.fixAt === fixAt && b.routeId === routeId) {
      b.age = age;
      return id; // misma lectura: el bus no ha reportado de nuevo
    }
    if (!b || b.routeId !== routeId) {
      const route = this.net.routes.get(routeId);
      const fresh: Bus = {
        id, label: d.label[i], plate: d.plate[i], routeId, route, path: this.net.paths.get(routeId), sys: route?.sys, kind: busKind(d.label[i], route?.code, route?.sys),
        fixX: x, fixY: y, fixAt, age, stopId: d.stop[i], seq: d.seq[i], start: d.start[i],
        onPath: false, offPath: Infinity, sFix: 0, tt: [], ts: [], tm: [], off: 0, offAt: now, snap: true, suspect: null, drawnAt: 0, v: 0, x0: x, y0: y, x1: x, y1: y, t0: now, t1: now,
        speed: null, hist: [], bornAt: b ? b.bornAt : now, pingAt: 0, seed: seedOf(id), x, y, hx: 1, hy: 0, s: 0,
      };
      if (b) { fresh.x = b.x; fresh.y = b.y; fresh.hx = b.hx; fresh.hy = b.hy; }
      this.place(fresh, x, y, fixAt, now, true);
      this.buses.set(id, fresh);
      return id;
    }
    b.label = d.label[i];
    b.plate = d.plate[i];
    b.age = age;
    b.stopId = d.stop[i];
    b.seq = d.seq[i];
    b.start = d.start[i];
    b.pingAt = now;
    this.place(b, x, y, fixAt, now, false);
    return id;
  }

  /** Ubica una lectura y programa el movimiento hasta ella. */
  private place(b: Bus, x: number, y: number, fixAt: number, now: number, first: boolean) {
    const path = b.path;
    const end = now + this.interval;
    if (path && path.size > 1) {
      const hit = path.nearest(x, y, first ? undefined : b.sFix, 250, 3500, MAX_OFF);
      if (hit && hit.d <= MAX_OFF) {
        const n = b.tt.length;
        const wasOn = b.onPath && !first && n > 0;
        if (wasOn && fixAt <= b.tt[n - 1]) return; // lectura más vieja que la última: se ignora
        const last = wasOn ? b.ts[n - 1] : 0;
        const fwd = hit.s - last;
        // Retroceso grande, salto imposible (más de 3 km o de ~145 km/h): se reinicia en la lectura.
        const odd = wasOn && (-fwd > HOLD_BACK || fwd > MAX_JUMP || fwd / Math.max(1, (fixAt - b.tt[n - 1]) / 1000) > 40);
        if (odd) {
          // Se acepta solo si la lectura anterior ya apuntaba allí (a menos de 300 m).
          const sus = b.suspect;
          if (!sus || Math.abs(hit.s - sus.s) > 300) { b.suspect = { s: hit.s, at: fixAt }; return; }
        }
        b.suspect = null;
        const reset = !wasOn || odd;
        b.onPath = true;
        b.offPath = hit.d;
        if (!wasOn || hit.s < b.sFix - HOLD_BACK) b.hist = [];
        b.hist.push({ at: fixAt, s: Math.max(hit.s, b.hist.length ? b.hist[b.hist.length - 1].s : 0) });
        while (b.hist.length > 2 && fixAt - b.hist[0].at > 8 * 60_000) b.hist.shift();
        // Velocidad: solo con lecturas aceptadas (una imposible, en espera o descartada, no cuenta).
        b.speed = windowSpeed(b.hist);
        b.sFix = hit.s;
        b.fixAt = fixAt;
        b.fixX = x;
        b.fixY = y;
        if (reset) {
          b.tt = [fixAt];
          b.ts = [hit.s];
          b.tm = [NaN];
          b.off = 0;
          b.offAt = now;
          b.snap = true;
          if (!first) {
            // Fundido solo si el salto se ve; un ajuste corto no merece desaparecer.
            const q = path.pointAt(hit.s, this.tmp);
            if (Math.hypot(q[0] - b.x, q[1] - b.y) > 150) b.bornAt = now;
          }
          return;
        }
        // La lectura nueva cambia la curva desde el punto anterior: si lo que se dibuja ya está en ese
        // tramo (o más allá), se ancla un nudo en el instante dibujado con su posición y su velocidad,
        // y la curva nueva parte de ahí. Sin el nudo, el tramo en pantalla se deformaría de golpe.
        const off = this.offOf(b, now);
        const tr = now - this.lag - off;
        const T = b.tt, S = b.ts;
        const anchor = tr > T[Math.max(0, n - 2)] ? { s: this.curve(b, tr), v: Math.max(0, (this.curve(b, tr + 50) - this.curve(b, tr - 50)) / 100) } : null;
        // Si ya pasó la última lectura (llegó tarde o el alimentador se detuvo), el bus está quieto o
        // siguió un poco por inercia: su retraso propio crece lo justo para que la curva nueva arranque
        // donde se ve, al ritmo del bus, y se recupera después a 1,2×.
        const tau = tr - T[n - 1];
        if (tau > 0) {
          const d = Math.max(0, fwd) / Math.max(1, fixAt - T[n - 1]);
          const ahead = Math.max(0, (anchor?.s ?? b.s) - last);
          const tauEq = d > 0 ? Math.min(tau, ahead / d) : 0;
          b.off = off + (tau - tauEq);
          b.offAt = now;
          if (b.off > 90_000) { b.tt = [fixAt]; b.ts = [hit.s]; b.tm = [NaN]; b.off = 0; b.snap = true; return; }
        }
        const sNew = Math.max(hit.s, last); // ruido del GPS (< 30 m atrás): no retrocede
        T.push(fixAt);
        S.push(sNew);
        b.tm.push(NaN);
        if (anchor) {
          const tk = now - this.lag - this.offOf(b, now);
          let k = T.length - 1;
          while (k > 0 && T[k - 1] >= tk) k--;
          const sk = Math.min(Math.max(anchor.s, k > 0 ? S[k - 1] : -Infinity), sNew);
          if (k > 0 && tk - T[k - 1] < 200) b.tm[k - 1] = anchor.v; // cae sobre un punto: se fija su velocidad
          else if (k > 0 && T[k] - tk > 200) { T.splice(k, 0, tk); S.splice(k, 0, sk); b.tm.splice(k, 0, anchor.v); }
        }
        while (T.length > TRACK) { T.shift(); S.shift(); b.tm.shift(); }
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

  private offOf(b: Bus, now: number): number {
    return b.off > 0 ? Math.max(0, b.off - (now - b.offAt) * CATCH) : 0;
  }

  /** Abscisa del bus en `now` (hora de reproducción: `now − lag − off`). */
  sAt(b: Bus, now: number): number {
    return b.tt.length ? this.curve(b, now - this.lag - this.offOf(b, now)) : b.sFix;
  }

  /**
   * Abscisa en la hora de reproducción `t`: curva cúbica monótona (Fritsch–Butland) por los puntos
   * recientes. Velocidad continua, nunca hacia atrás, sin pasarse de una lectura; después de la
   * última sigue con su velocidad y se detiene suavemente.
   */
  private curve(b: Bus, t: number): number {
    const T = b.tt, S = b.ts, M = b.tm, n = T.length;
    if (n === 1 || t <= T[0]) return S[0];
    const sec = (k: number) => (S[k + 1] - S[k]) / (T[k + 1] - T[k]);
    const tan = (k: number) => {
      if (!Number.isNaN(M[k])) return M[k];
      if (k === 0) return sec(0);
      if (k === n - 1) return sec(n - 2);
      const a = sec(k - 1), c = sec(k);
      return a > 0 && c > 0 ? (2 * a * c) / (a + c) : 0;
    };
    if (t >= T[n - 1]) {
      const v = Math.min(tan(n - 1), 3 * Math.max(0, sec(n - 2)));
      return S[n - 1] + v * EXTRA * (1 - Math.exp(-(t - T[n - 1]) / EXTRA));
    }
    let i = n - 1;
    while (i > 1 && T[i - 1] > t) i--;
    const h = T[i] - T[i - 1], d = (S[i] - S[i - 1]) / h;
    // Dentro de la región de Fritsch–Carlson (≤ 3 veces la pendiente del tramo): monótona.
    const m0 = d > 0 ? Math.min(Math.max(0, tan(i - 1)), 3 * d) : 0;
    const m1 = d > 0 ? Math.min(Math.max(0, tan(i)), 3 * d) : 0;
    const u = (t - T[i - 1]) / h, u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * S[i - 1] + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * S[i] + (u3 - u2) * h * m1;
  }

  private lastUpdate = 0;
  private lastMoving = false;

  /**
   * Avanza todos los buses a `now`. Una búsqueda binaria por bus: posición sobre el segmento y
   * rumbo del segmento, suavizado en el tiempo (las esquinas giran en ~120 ms, sin saltos).
   * Devuelve si algún bus sigue en movimiento (para pedir otro cuadro).
   */
  update(now = Date.now(), box?: [number, number, number, number]): boolean {
    // Dos capas (atenuados debajo del foco, el resto encima) piden el mismo cuadro: se calcula una vez.
    if (this.lastUpdate && now - this.lastUpdate < 4) return this.lastMoving;
    const dt = this.lastUpdate ? Math.min(200, now - this.lastUpdate) : 1000;
    this.lastUpdate = now;
    const k = 1 - Math.exp(-dt / 120);
    // El retraso cambia despacio (reproducción entre 0,9× y 1,1×): un cambio brusco movería a todos.
    this.lag += Math.max(-0.1 * dt, Math.min(0.1 * dt, this.lagTarget - this.lag));
    const ks = 1 - Math.exp(-dt / 150);
    let moving = false;
    for (const b of this.buses.values()) {
      // Fuera de la vista no se calcula (se pone al día cuando entra; su posición solo depende del tiempo).
      if (box && (b.fixX < box[0] || b.fixX > box[2] || b.fixY < box[1] || b.fixY > box[3]) && b.id !== this.selectedId) continue;
      if (b.onPath && b.path) {
        const target = this.sAt(b, now);
        // Adelante, se sigue la curva (con un suavizado de 150 ms que absorbe lecturas reiniciadas);
        // atrás nunca: si la inercia lo llevó más lejos que la lectura nueva, espera ahí.
        const fresh = b.snap || now - b.drawnAt > 500;
        const s = fresh ? target : target >= b.s ? b.s + (target - b.s) * ks : b.s;
        b.v = fresh || now === b.drawnAt ? 0 : ((s - b.s) / (now - b.drawnAt)) * 1000;
        b.drawnAt = now;
        b.snap = false;
        if (Math.abs(target - s) > 0.05 || b.v > 0.05) moving = true;
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
        if (now < b.t1) moving = true;
        const kk = now >= b.t1 || b.t1 <= b.t0 ? 1 : (now - b.t0) / (b.t1 - b.t0);
        const nx = b.x0 + (b.x1 - b.x0) * kk, ny = b.y0 + (b.y1 - b.y0) * kk;
        const dx = nx - b.x, dy = ny - b.y, l = Math.hypot(dx, dy);
        if (l > 0.3) this.turn(b, dx / l, dy / l, k);
        b.x = nx; b.y = ny;
      }
    }
    this.lastMoving = moving;
    return moving;
  }

  /** Recorridos que llegaron tarde (zonal): los buses que aún no lo tenían se ubican ya, sin
   * esperar a su próxima lectura. */
  relocate(now = Date.now()) {
    for (const b of this.buses.values()) {
      if (b.path) continue;
      b.path = this.net.paths.get(b.routeId);
      if (b.path) this.place(b, b.fixX, b.fixY, b.fixAt, now, true);
    }
  }

  /** ¿Avanza ahora a más de ~2 m/s? */
  private moving(b: Bus, now: number): boolean {
    if (b.onPath) return b.v > 2;
    if (now >= b.t1 || b.t1 <= b.t0) return false;
    return Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / ((b.t1 - b.t0) / 1000) > 2;
  }

  /** ¿Hay ondas de lectura en curso? (lectura nueva hace menos de 2,4 s y algo en foco) */
  pinging(now = Date.now()): boolean {
    return now - this.lastFeedAt < 2400 && (this.selectedId !== null || !!this.focusRoute || !!this.focusRoutes || this.arriving.size > 0);
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
   * Llena el buffer de la capa: [mx, my, hx, hy, r, g, b, alfa, tamaño, banderas, onda, rumbo trasero
   * (2), altura] por bus, con los
   * atenuados primero y el seleccionado al final (se dibuja encima). Devuelve cuántos hay.
   * Banderas: 1 atenuado, 2 lectura vieja, 4 seleccionado, 8 bajo el cursor, 16 estela, 32 de la ruta en foco.
   */
  fill(now = Date.now(), only: 'all' | 'dim' | 'main' = 'all', box?: [number, number, number, number]): { data: Float32Array; count: number } {
    const S = Fleet.STRIDE;
    if (this.buf.length < this.buses.size * S) this.buf = new Float32Array(Math.ceil(this.buses.size * 1.5) * S);
    const out = this.buf;
    const m = this.tmp;
    let n = 0;
    const focus = this.focusRoute;
    const set = this.focusRoutes;
    const fb = this.focusBuses;
    // Con la capa de velocidad, la flota entera va atenuada debajo (salvo lo que esté en foco).
    const inFocus = (b: Bus) => (fb ? fb.has(b.id) : set ? set.has(b.routeId) : focus ? b.routeId === focus : !this.allDim);
    const anyFocus = !!fb || !!set || !!focus || this.allDim;
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
      out[o + 8] = sizeOf(b);
      out[o + 9] = flags;
      // Onda de lectura nueva (1,6 s, con desfase propio) solo donde la persona está mirando: el bus
      // seleccionado, la ruta en foco y los próximos en llegar. En toda la flota sería ruido cada 15 s.
      const ping = (now - b.pingAt) / 1000 - b.seed * 0.7;
      out[o + 10] = b.pingAt && flags & (4 | 32 | 64) && ping >= 0 && ping < 1.6 ? ping / 1.6 : -1;
      // Rumbo del tramo trasero: el recorrido entre 0,53 y 0,14 del largo por detrás del centro.
      out[o + 11] = b.hx; out[o + 12] = -b.hy;
      out[o + 13] = this.elevation && b.onPath ? this.elevation(b.x, b.y, b.hx, b.hy) : 0;
      if (this.rearDirs && b.onPath && b.path && b.path.size > 1) {
        const L = 18 * out[o + 8];
        const a = b.path.pointAt(b.s - 0.53 * L, this.rp0), c = b.path.pointAt(b.s - 0.14 * L, this.rp1);
        const dx = c[0] - a[0], dy = c[1] - a[1], l = Math.hypot(dx, dy);
        if (l > 1) { out[o + 11] = dx / l; out[o + 12] = -dy / l; }
      }
      n++;
    };
    const inView = (b: Bus) => !box || (b.x >= box[0] && b.x <= box[2] && b.y >= box[1] && b.y <= box[3]);
    // Pasadas: atenuados abajo; luego zonal y alimentador; encima troncal, dual y cable.
    const major = (b: Bus) => b.sys === 'troncal' || b.sys === 'dual' || b.sys === 'cable';
    for (let pass = only === 'main' ? 1 : 0; pass < (only === 'dim' ? 1 : 3); pass++) {
      for (const b of this.buses.values()) {
        if (b.age > DROP_AGE) continue;
        if (b.sys && this.hidden.has(b.sys)) continue;
        if (b.id === this.selectedId) { selected = b; continue; }
        if (!inView(b)) continue;
        const dim = anyFocus && !inFocus(b);
        if ((pass === 0) !== dim) continue;
        if (pass > 0 && (pass === 2) !== major(b)) continue;
        const trail = !dim && (this.trails || (anyFocus && inFocus(b))) && this.moving(b, now);
        write(b, (dim ? 1 : 0) | (b.age > STALE_AGE ? 2 : 0) | (b.id === this.hoverId ? 8 : 0) | (trail ? 16 : 0) | (anyFocus && !dim ? 32 : 0) | (this.arriving.has(b.id) ? 64 : 0));
      }
    }
    if (selected && only !== 'dim') write(selected, 4 | (selected.age > STALE_AGE ? 2 : 0) | (this.moving(selected, now) ? 16 : 0));
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

import type { Network } from '../data/network';
import type { Route, SystemKey } from '../domain/types';
import { classOf, type FilterKey } from '../domain/filter';
import { KX, KY, type MetricPath } from '../domain/geo';
import { LAT0, LON0, Q, type VehiclesV1 } from './api';
import { busKind, type BusKind } from '../domain/fleetTypes';
import { allCodes } from '../domain/legs';

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
/**
 * Movimiento entre lecturas (Configuración, decisión 013): `continuo` (por defecto) reproduce cada bus
 * con retraso sobre una curva continua; `directo` lo lleva en `GLIDE` ms por su recorrido a la última
 * lectura aceptada y lo deja ahí hasta la siguiente.
 */
export type Motion = 'continuo' | 'directo';
export const GLIDE = 400;
/** Más viejo que esto, el bus se atenúa; más que `DROP_AGE`, no se dibuja. */
export const STALE_AGE = 180;
export const DROP_AGE = 600;
/**
 * Un bus que falta en una instantánea no sale enseguida. El alimentador omite buses y los devuelve
 * unas vueltas después: medido el 9 nov. 2026 (hora pico, 5.300 buses), 27 por minuto faltan y
 * vuelven, casi siempre con la misma ruta y a ~200 m de donde estaban; el 36 % vuelve en 2 min, el
 * 65 % en 5 y el 93 % en 10. Sacarlos al instante los hacía desaparecer y reaparecer en el mapa (y
 * cerraba la ficha del bus que se estaba siguiendo). Se conserva hasta `KEEP_S` segundos del reloj del
 * alimentador sin aparecer: mientras tanto llega a su última lectura, se queda ahí y se atenúa como
 * cualquier lectura vieja (`STALE_AGE`).
 */
export const KEEP_S = 300;
/** Un bus que solo trae el respaldo por ruta se conserva este tiempo desde su última lectura de ahí
 * (el alimentador no lo trae: sus instantáneas no deben sacarlo). */
export const BACKUP_KEEP = 180_000;

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
  /** Hora del alimentador (s) de la última instantánea que lo trajo; 0 si solo viene del respaldo. */
  seenT: number;
  /** Hora (ms) de su última lectura del respaldo por ruta; 0 si nunca. */
  backupAt: number;
  /** Falta en la última instantánea del alimentador (se conserva un tiempo; ver `KEEP_S`). */
  missing: boolean;
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
  /** Modo directo: desde dónde y cuándo empezó el deslizamiento a la última lectura. */
  glideFrom: number;
  glideAt: number;
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
  /** Clases ocultas por el filtro de sistemas (R10.2). */
  hidden = new Set<FilterKey>();
  /** Si el filtro oculta este bus. */
  isHidden(b: Bus): boolean {
    if (!this.hidden.size || !b.sys) return false;
    const c = classOf(b.sys, b.route?.sub);
    return !!c && this.hidden.has(c);
  }
  focusRoute: string | null = null;
  /** Toda la flota atenuada (capa de velocidad encendida). */
  allDim = false;
  /** Buses puntuales en foco (llegadas resaltadas de una estación); manda sobre las rutas. */
  focusBuses: Set<string> | null = null;
  /** Varias rutas en foco a la vez (las de un viaje planeado); manda sobre `focusRoute`. */
  focusRoutes: Set<string> | null = null;
  selectedId: string | null = null;
  hoverId: string | null = null;
  /** Estelas de toda la flota (capa opcional). */
  trails = false;
  /** Largo mínimo de una estela en metros a este zoom (30 px; lo pone la capa antes de `fill`). */
  tailMin = 60;
  /** Buffer intercalado para la capa WebGL. */
  static readonly STRIDE = 15;
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
   * alimentador regenerándose cada 21 s; hasta 2 min con el de noviembre de 2026 (ver `lagCap`). Cambia
   * despacio (±10 %). Una pausa más larga la absorbe el retraso propio de cada bus (`off`).
   */
  lag = 40_000;
  private lagTarget = 40_000;
  /**
   * Topes del retraso (ms): del total, de lo que aporta el intervalo entre lecturas y del retraso propio
   * de un bus antes de reiniciarlo en su lectura. Hasta el 6 nov. 2026 el alimentador se regeneraba cada
   * ~21 s y bastaban 60 s; desde el 9 nov. trae lecturas de 40–90 s de antigüedad cada 50–65 s. Con el
   * tope en 60 s cada bus acumulaba el resto como retraso propio (el mismo atraso, ~106 s, pero con
   * paradas en espera de datos el 18 % del tiempo y 10 reinicios por bus y hora); con 120 s: 6 % y 4.
   */
  lagCap = 120_000;
  gapCap = 60_000;
  offCap = 90_000;
  /** Movimiento entre lecturas (ver `Motion`) y duración del deslizamiento del modo directo (0 con
   * «reducir movimiento» del sistema: va de una vez). */
  motion: Motion = 'continuo';
  glide = GLIDE;
  private delays: number[] = [];
  private gaps: number[] = [];

  /**
   * Cambia el movimiento. A `directo`: cada bus va de donde se ve a su última lectura. A `continuo`:
   * vuelve una vez a la hora de reproducción (unos segundos atrás) y sigue sin pausas desde ahí.
   */
  setMotion(m: Motion, now = Date.now()) {
    if (m === this.motion) return;
    this.motion = m;
    for (const b of this.buses.values()) {
      if (m === 'directo') { b.glideFrom = b.s; b.glideAt = now; } else b.snap = true;
    }
    for (const f of this.listeners) f();
  }

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
        this.lagTarget = Math.min(this.lagCap, Math.max(8_000, Math.min(g, this.gapCap) + Math.max(...this.delays) + 1000));
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
    for (let i = 0; i < d.n; i++) seen.add(this.upsert(d, i, now, false));
    let byLabel: Map<string, string> | null = null;
    for (const [id, b] of this.buses) {
      if (seen.has(id)) continue;
      // Solo del respaldo por ruta: si el alimentador ya trae ese bus con su propio id, sobra este
      // (la vista abierta pasa al id del alimentador); si no, dura lo que duren sus lecturas.
      if (!b.seenT) {
        if (b.label) {
          if (!byLabel) { byLabel = new Map(); for (const sid of seen) { const o = this.buses.get(sid); if (o?.label) byLabel.set(o.label, sid); } }
          const twin = byLabel.get(b.label);
          if (twin) { this.replace(id, twin); continue; }
        }
        if (now - b.backupAt > BACKUP_KEEP) this.buses.delete(id);
        continue;
      }
      // Con lecturas recientes del respaldo, el respaldo manda.
      if (b.backupAt && now - b.backupAt <= BACKUP_KEEP) continue;
      // Falta en esta instantánea: su lectura envejece con el reloj del alimentador.
      b.age = Math.max(b.age, d.t - Math.round(b.fixAt / 1000));
      if (d.t - b.seenT > KEEP_S || b.age > DROP_AGE) this.buses.delete(id);
      else b.missing = true;
    }
    for (const f of this.listeners) f();
  }

  /** Aviso de que un bus cambió de id (el del respaldo pasó al del alimentador), para la vista abierta. */
  onReplace: ((from: string, to: string) => void) | null = null;
  private replace(from: string, to: string) {
    this.buses.delete(from);
    if (this.selectedId === from) this.selectedId = to;
    if (this.hoverId === from) this.hoverId = to;
    this.onReplace?.(from, to);
  }

  /** Buses de una ruta (por código) que el alimentador trae ahora: presentes en su última instantánea. */
  reporting(code: string): number {
    const c = code.toUpperCase();
    let n = 0;
    for (const b of this.buses.values()) if (b.seenT && !b.missing && b.age <= DROP_AGE && b.route && allCodes(b.route).includes(c)) n++;
    return n;
  }

  /** Saca los buses del respaldo por ruta que ya no se actualizan (con el alimentador detenido no hay
   * instantáneas que lo hagan). Los que también trae el alimentador siguen su regla. */
  prune(now = Date.now()): boolean {
    let cut = false;
    for (const [id, b] of this.buses) {
      if (b.seenT || now - b.backupAt <= BACKUP_KEEP || id === this.selectedId) continue;
      this.buses.delete(id);
      cut = true;
    }
    if (cut) for (const f of this.listeners) f();
    return cut;
  }

  /**
   * Lecturas de UNA ruta (respaldo por ruta, ver live/backup.svelte.ts): se incorporan como las del
   * alimentador, pero sin quitar los demás buses ni tocar el ritmo del alimentador (retraso, intervalo).
   */
  merge(d: VehiclesV1, now = Date.now(), replaceCodes: string[] = []) {
    const got = new Set<string>();
    for (let i = 0; i < d.n; i++) got.add(this.upsert(d, i, now, true));
    // Con `replaceCodes`, el respaldo reemplaza a esas rutas: sus buses que no vinieron en él salen.
    if (replaceCodes.length) {
      const codes = new Set(replaceCodes.map((c) => c.toUpperCase()));
      for (const [id, b] of this.buses) if (!got.has(id) && b.route && allCodes(b.route).some((c) => codes.has(c))) this.buses.delete(id);
    }
    for (const f of this.listeners) f();
  }

  /** Incorpora la lectura `i` de una instantánea; devuelve el id del bus. */
  private upsert(d: VehiclesV1, i: number, now: number, backup: boolean): string {
    const id = d.id[i] || d.label[i];
    const lat = LAT0 + d.lat[i] / Q, lon = LON0 + d.lon[i] / Q;
    const x = lon * KX, y = lat * KY;
    const age = d.age[i];
    const fixAt = (d.t - age) * 1000;
    const routeId = d.route[i];
    let b = this.buses.get(id);
    // Presente en esta fuente: del alimentador (su hora) o del respaldo (la hora de llegada).
    const mark = (x: Bus) => { if (backup) x.backupAt = now; else { x.seenT = d.t; x.missing = false; } };
    if (b && b.fixAt === fixAt && b.routeId === routeId) {
      b.age = age;
      mark(b);
      return id; // misma lectura: el bus no ha reportado de nuevo
    }
    if (!b || b.routeId !== routeId) {
      const route = this.net.routes.get(routeId);
      const fresh: Bus = {
        id, label: d.label[i], plate: d.plate[i], routeId, route, path: this.net.paths.get(routeId), sys: route?.sys, kind: busKind(d.label[i], route?.code, route?.sys),
        fixX: x, fixY: y, fixAt, age, seenT: b?.seenT ?? 0, backupAt: b?.backupAt ?? 0, missing: false, stopId: d.stop[i], seq: d.seq[i], start: d.start[i],
        onPath: false, offPath: Infinity, sFix: 0, tt: [], ts: [], tm: [], off: 0, offAt: now, snap: true, suspect: null, glideFrom: 0, glideAt: 0, drawnAt: 0, v: 0, x0: x, y0: y, x1: x, y1: y, t0: now, t1: now,
        speed: null, hist: [], bornAt: b ? b.bornAt : now, pingAt: 0, seed: seedOf(id), x, y, hx: 1, hy: 0, s: 0,
      };
      if (b) { fresh.x = b.x; fresh.y = b.y; fresh.hx = b.hx; fresh.hy = b.hy; }
      mark(fresh);
      this.place(fresh, x, y, fixAt, now, true);
      this.buses.set(id, fresh);
      return id;
    }
    mark(b);
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
    const end = now + (this.motion === 'directo' ? this.glide : this.interval);
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
        // Modo directo: desde donde se ve hacia esta lectura.
        b.glideFrom = b.s;
        b.glideAt = now;
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
          if (b.off > this.offCap) { b.tt = [fixAt]; b.ts = [hit.s]; b.tm = [NaN]; b.off = 0; b.snap = true; return; }
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
   * Modo directo: abscisa en `now` del deslizamiento hacia la última lectura (aceleración y frenado
   * suaves, por el recorrido: no corta esquinas). Nunca hacia atrás: una lectura apenas detrás de lo
   * dibujado es ruido del GPS.
   */
  directAt(b: Bus, now: number): number {
    const end = b.ts.length ? b.ts[b.ts.length - 1] : b.sFix;
    if (b.snap || this.glide <= 0) return end;
    const u = Math.min(1, Math.max(0, (now - b.glideAt) / this.glide));
    const e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
    return b.glideFrom + Math.max(0, end - b.glideFrom) * e;
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
        const direct = this.motion === 'directo';
        const target = direct ? this.directAt(b, now) : this.sAt(b, now);
        // Adelante, se sigue la curva (con un suavizado de 150 ms que absorbe lecturas reiniciadas; el
        // deslizamiento del modo directo ya es suave); atrás nunca: si la inercia lo llevó más lejos que
        // la lectura nueva, espera ahí.
        const fresh = b.snap || now - b.drawnAt > 500;
        const s = fresh ? target : target >= b.s ? (direct ? target : b.s + (target - b.s) * ks) : b.s;
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
   * (2), altura, pendiente] por bus, con los
   * atenuados primero y el seleccionado al final (se dibuja encima). Devuelve cuántos hay.
   * Banderas: 1 atenuado, 2 lectura vieja, 4 seleccionado, 8 bajo el cursor, 32 de la ruta en foco, 64
   * llegando; por encima (×256), el largo de la estela en quinceavos (0: sin estela).
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
      // Altura sobre un puente y pendiente (de 6 m atrás a 6 m adelante): el cuerpo sube inclinado.
      if (this.elevation && b.onPath) {
        const E = this.elevation;
        out[o + 13] = E(b.x, b.y, b.hx, b.hy);
        const g = (E(b.x + b.hx * 6, b.y + b.hy * 6, b.hx, b.hy) - E(b.x - b.hx * 6, b.y - b.hy * 6, b.hx, b.hy)) / 12;
        out[o + 14] = Math.max(-0.15, Math.min(0.15, g));
      } else {
        out[o + 13] = 0;
        out[o + 14] = 0;
      }
      if (this.rearDirs && b.onPath && b.path && b.path.size > 1) {
        const L = 18 * out[o + 8];
        const a = b.path.pointAt(b.s - 0.53 * L, this.rp0), c = b.path.pointAt(b.s - 0.14 * L, this.rp1);
        const dx = c[0] - a[0], dy = c[1] - a[1], l = Math.hypot(dx, dy);
        if (l > 1) { out[o + 11] = dx / l; out[o + 12] = -dy / l; }
      }
      n++;
    };
    const inView = (b: Bus) => !box || (b.x >= box[0] && b.x <= box[2] && b.y >= box[1] && b.y <= box[3]);
    // Lectura vieja: por el reloj del alimentador (el bus dejó de reportar) o por el de pared (el
    // alimentador entero se detuvo: toda la flota se atenúa y el mapa mismo dice que los datos son viejos).
    const old = (b: Bus) => b.age > STALE_AGE || now - b.fixAt > STALE_AGE * 1000;
    // Pasadas: atenuados abajo; luego zonal y alimentador; encima troncal, dual y cable.
    const major = (b: Bus) => b.sys === 'troncal' || b.sys === 'dual' || b.sys === 'cable';
    for (let pass = only === 'main' ? 1 : 0; pass < (only === 'dim' ? 1 : 3); pass++) {
      for (const b of this.buses.values()) {
        if (b.age > DROP_AGE) continue;
        if (this.isHidden(b)) continue;
        if (b.id === this.selectedId) { selected = b; continue; }
        if (!inView(b)) continue;
        const dim = anyFocus && !inFocus(b);
        if ((pass === 0) !== dim) continue;
        if (pass > 0 && (pass === 2) !== major(b)) continue;
        // Estela: solo con la capa «Estelas» y fuera del foco. El bus seleccionado y los de la ruta en
        // foco van sobre el trazo de su ruta: en recta la estela no se veía y en curva salía derecha,
        // cortando la esquina.
        const tail = this.trails && !dim && !(anyFocus && inFocus(b)) ? this.tail(b, now) : 0;
        write(b, (dim ? 1 : 0) | (old(b) ? 2 : 0) | (b.id === this.hoverId ? 8 : 0) | (anyFocus && !dim ? 32 : 0) | (this.arriving.has(b.id) ? 64 : 0) | (tail << 8));
      }
    }
    if (selected && only !== 'dim') write(selected, 4 | (old(selected) ? 2 : 0));
    return { data: out, count: n };
  }

  /**
   * Largo de la estela de un bus en movimiento, en quinceavos del largo completo: lo que el recorrido
   * hacia atrás sigue derecho. La estela es una franja recta tras el bus; en una curva se acorta hasta
   * donde el recorrido se aparta de esa recta (2,5 m), en vez de atravesar la esquina.
   */
  private tail(b: Bus, now: number): number {
    if (!this.moving(b, now)) return 0;
    if (!b.onPath || !b.path || b.path.size < 2) return 15;
    const L = Math.max(this.tailMin, 54 * sizeOf(b));
    let ok = 0;
    for (let k = 1; k <= 5; k++) {
      const p = b.path.pointAt(b.s - (L * k) / 5, this.rp0);
      const dx = p[0] - b.x, dy = p[1] - b.y;
      if (Math.abs(dx * b.hy - dy * b.hx) > 2.5 || dx * b.hx + dy * b.hy > 0) break;
      ok = k;
    }
    return ok * 3;
  }

  /** Bus más cercano a un punto de pantalla, dentro de `radius` px. */
  pick(project: (lon: number, lat: number) => { x: number; y: number }, px: number, py: number, radius: number): Bus | null {
    let best: Bus | null = null, bd = radius * radius;
    for (const b of this.buses.values()) {
      if (b.age > DROP_AGE || this.isHidden(b)) continue;
      const p = project(b.x / KX, b.y / KY);
      const d = (p.x - px) ** 2 + (p.y - py) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  /** Conteo de buses por sistema (sin filtro): los que reportan ahora. Los que el alimentador omitió en
   * su última instantánea se conservan en el mapa, pero no se cuentan (la mitad no vuelve: terminó). */
  counts(): Record<FilterKey, number> {
    const c: Record<FilterKey, number> = { troncal: 0, dual: 0, alimentador: 0, cable: 0, 'zonal-urbano': 0, 'zonal-complementario': 0, 'zonal-especial': 0 };
    for (const b of this.buses.values()) {
      if (!b.sys || b.age > DROP_AGE || b.missing) continue;
      const k = classOf(b.sys, b.route?.sub);
      if (k) c[k]++;
    }
    return c;
  }
}

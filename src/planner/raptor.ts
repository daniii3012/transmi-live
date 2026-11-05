/**
 * Planificador (hito 6): RAPTOR sobre un modelo de frecuencias.
 *
 * El horario publicado trae ~180.000 viajes; llevarlos al teléfono no tiene sentido para planear
 * con la precisión que da un sistema de buses. El modelo usa, por ruta, su patrón de paradas, los
 * tiempos entre paradas de la franja y las salidas por hora: la espera esperada es la mitad del
 * intervalo (con tope), el viaje es el tiempo del horario. Cada ronda de RAPTOR agrega un bus más;
 * de cada ronda sale el mejor viaje con ese número de buses, así que las alternativas «menos
 * transbordos» y «llegar antes» salen solas.
 *
 * Sin dependencias del navegador: corre en un Web Worker y en las pruebas.
 */

export interface RoutePattern {
  id: string;
  stops: number[];
  /** Tiempos (s desde el inicio del viaje) por franja; null si la franja no tiene viajes. */
  times: (number[] | null)[];
  /** Salidas por hora del día (0–29) para el tipo de día de la consulta. */
  perHour: number[];
}

export interface StopInfo { id: string; lon: number; lat: number; station: string | null }

export interface Model {
  stops: StopInfo[];
  routes: RoutePattern[];
  /** Por parada: [ruta, posición en el patrón]. */
  routesAt: [number, number][][];
  /** Por parada: [parada vecina, segundos a pie]. */
  walks: [number, number][][];
}

export const WALK_MS = 1.2; // m/s
export const DETOUR = 1.3; // la calle no es la línea recta
export const MAX_WAIT = 20 * 60;
export const MIN_TRANSFER = 60; // bajarse y volver a subir no es instantáneo
const BAND_EDGES = [6, 9, 16, 20, 30];

export const bandOf = (sec: number) => {
  const h = sec / 3600;
  const i = BAND_EDGES.findIndex((e) => h < e);
  return i < 0 ? 4 : i;
};

function timesFor(r: RoutePattern, sec: number): number[] | null {
  const b = bandOf(sec);
  for (let d = 0; d < 5; d++) for (const x of [b - d, b + d]) if (x >= 0 && x < r.times.length && r.times[x]) return r.times[x];
  return null;
}

/** Espera esperada para subir a la ruta a la hora `sec` (mitad del intervalo); null si no opera. */
export function expectedWait(r: RoutePattern, sec: number, offset: number): number | null {
  // Las salidas se cuentan en la cabecera; a esta parada el bus llega `offset` s después.
  const h = Math.floor(Math.max(0, sec - offset) / 3600);
  const n = r.perHour[Math.min(29, h)] ?? 0;
  if (!n) return null;
  return Math.min(MAX_WAIT, 3600 / n / 2);
}

export interface Access { stop: number; seconds: number }

export type Leg =
  | { kind: 'walk'; from: number | null; to: number | null; seconds: number; meters: number; start: number; end: number }
  | { kind: 'ride'; route: number; from: number; to: number; fromPos: number; toPos: number; wait: number; start: number; board: number; end: number };

export interface Journey { legs: Leg[]; depart: number; arrive: number; rides: number; walkSeconds: number }

interface Label { time: number; parent: { kind: 'origin' } | { kind: 'walk'; from: number; seconds: number } | { kind: 'ride'; route: number; fromPos: number; toPos: number; wait: number; board: number } }

/**
 * Consulta: desde los accesos de origen (paradas con su caminata) a los de destino, saliendo a
 * `depart` (s desde medianoche). Devuelve hasta `maxRides` alternativas (una por número de buses,
 * solo si mejoran la llegada), de la más rápida a la de menos buses.
 */
export function plan(m: Model, origins: Access[], targets: Access[], depart: number, maxRides = 4, exclude?: Set<number>): Journey[] {
  const N = m.stops.length;
  const best = new Float64Array(N).fill(Infinity);
  const rounds: Map<number, Label>[] = [new Map()];
  let marked = new Set<number>();
  for (const o of origins) {
    const t = depart + o.seconds;
    if (t < best[o.stop]) {
      best[o.stop] = t;
      rounds[0].set(o.stop, { time: t, parent: { kind: 'origin' } });
      marked.add(o.stop);
    }
  }
  relaxWalks(m, rounds[0], best, marked);

  const targetWalk = new Map(targets.map((t) => [t.stop, t.seconds]));
  const results: { k: number; arrive: number; stop: number }[] = [];
  let bestArrive = Infinity;

  for (let k = 1; k <= maxRides; k++) {
    const prev = rounds[k - 1];
    const cur = new Map<number, Label>();
    rounds.push(cur);
    // Rutas que pasan por paradas marcadas, desde la primera posición marcada.
    const queue = new Map<number, number>();
    for (const s of marked) for (const [r, pos] of m.routesAt[s]) {
      if (exclude?.has(r)) continue;
      const q = queue.get(r);
      if (q === undefined || pos < q) queue.set(r, pos);
    }
    const nextMarked = new Set<number>();
    for (const [ri, startPos] of queue) {
      const r = m.routes[ri];
      let boardPos = -1, boardTime = 0, wait = 0, tt: number[] | null = null;
      for (let p = startPos; p < r.stops.length; p++) {
        const s = r.stops[p];
        // Bajarse aquí.
        if (boardPos >= 0 && tt) {
          const arr = boardTime + (tt[p] - tt[boardPos]);
          if (arr < best[s] && arr < bestArrive) {
            best[s] = arr;
            cur.set(s, { time: arr, parent: { kind: 'ride', route: ri, fromPos: boardPos, toPos: p, wait, board: boardTime } });
            nextMarked.add(s);
          }
        }
        // ¿Subir (o volver a subir) aquí da un viaje más temprano?
        const l = prev.get(s);
        if (l) {
          const ready = l.time + (l.parent.kind === 'ride' ? MIN_TRANSFER : 0);
          const t2 = timesFor(r, ready);
          if (!t2) continue;
          const w = expectedWait(r, ready, t2[p]);
          if (w === null) continue;
          const candidate = ready + w;
          const current = boardPos >= 0 && tt ? boardTime + (tt[p] - tt[boardPos]) : Infinity;
          if (candidate < current) { boardPos = p; boardTime = candidate; wait = w; tt = t2; }
        }
      }
    }
    relaxWalks(m, cur, best, nextMarked);
    // Mejor llegada con k buses.
    let arrive = Infinity, at = -1;
    for (const [s, l] of cur) {
      const w = targetWalk.get(s);
      if (w !== undefined && l.time + w < arrive) { arrive = l.time + w; at = s; }
    }
    // Un bus más solo vale si ahorra al menos 5 min frente a la mejor opción con menos buses.
    if (at >= 0 && arrive < bestArrive - 300) {
      bestArrive = arrive;
      results.push({ k, arrive, stop: at });
    }
    if (!nextMarked.size) break;
    marked = nextMarked;
  }
  return results.map((r) => build(m, rounds, r.k, r.stop, depart, r.arrive, targetWalk.get(r.stop)!)).reverse();
}

function relaxWalks(m: Model, labels: Map<number, Label>, best: Float64Array, marked: Set<number>) {
  for (const s of [...marked]) {
    const l = labels.get(s);
    if (!l || l.parent.kind === 'walk') continue;
    for (const [n, sec] of m.walks[s]) {
      const t = l.time + sec;
      if (t < best[n]) {
        best[n] = t;
        labels.set(n, { time: t, parent: { kind: 'walk', from: s, seconds: sec } });
        marked.add(n);
      }
    }
  }
}

function build(m: Model, rounds: Map<number, Label>[], k: number, stop: number, depart: number, arrive: number, lastWalk: number): Journey {
  const legs: Leg[] = [];
  let s = stop, round = k;
  if (lastWalk > 0) {
    const l = rounds[k].get(stop)!;
    legs.push({ kind: 'walk', from: stop, to: null, seconds: lastWalk, meters: lastWalk * WALK_MS / DETOUR, start: l.time, end: l.time + lastWalk });
  }
  while (round >= 0) {
    const l = rounds[round].get(s);
    if (!l) break;
    const p = l.parent;
    if (p.kind === 'origin') {
      if (l.time > depart) legs.push({ kind: 'walk', from: null, to: s, seconds: l.time - depart, meters: (l.time - depart) * WALK_MS / DETOUR, start: depart, end: l.time });
      break;
    }
    if (p.kind === 'walk') {
      legs.push({ kind: 'walk', from: p.from, to: s, seconds: p.seconds, meters: p.seconds * WALK_MS / DETOUR, start: l.time - p.seconds, end: l.time });
      s = p.from;
      continue;
    }
    const r = m.routes[p.route];
    const from = r.stops[p.fromPos];
    legs.push({ kind: 'ride', route: p.route, from, to: s, fromPos: p.fromPos, toPos: p.toPos, wait: p.wait, start: p.board - p.wait, board: p.board, end: l.time });
    s = from;
    round--;
  }
  legs.reverse();
  const walkSeconds = legs.reduce((a, l) => a + (l.kind === 'walk' ? l.seconds : 0), 0);
  return { legs, depart, arrive, rides: legs.filter((l) => l.kind === 'ride').length, walkSeconds };
}

/**
 * Alternativas: el mejor viaje por número de buses y, además, los que salen al prohibir una a una
 * las rutas del mejor (otra forma de hacer el mismo viaje). Sin repetidos, por hora de llegada.
 */
export function alternatives(m: Model, origins: Access[], targets: Access[], depart: number, want = 4): Journey[] {
  const base = plan(m, origins, targets, depart, 4);
  if (!base.length) return [];
  const key = (j: Journey) => j.legs.filter((l) => l.kind === 'ride').map((l) => (l as { route: number }).route).join('>');
  const seen = new Map(base.map((j) => [key(j), j]));
  const best = base.reduce((a, b) => (b.arrive < a.arrive ? b : a));
  const rides = best.legs.filter((l) => l.kind === 'ride') as { route: number }[];
  const tried = new Set<string>();
  const queue: Set<number>[] = rides.map((r) => new Set([r.route]));
  while (queue.length && seen.size < want + 2) {
    const ex = queue.shift()!;
    const k = [...ex].sort().join(',');
    if (tried.has(k)) continue;
    tried.add(k);
    for (const j of plan(m, origins, targets, depart, 4, ex)) {
      if (!seen.has(key(j))) seen.set(key(j), j);
      // Segunda vuelta: prohibir también la primera ruta de esta alternativa.
      const first = j.legs.find((l) => l.kind === 'ride') as { route: number } | undefined;
      if (first && ex.size < 2) queue.push(new Set([...ex, first.route]));
    }
  }
  return [...seen.values()]
    // Nada que llegue más de 25 min después que la mejor: no es una alternativa razonable.
    .filter((j) => j.arrive - best.arrive <= 25 * 60)
    .sort((a, b) => a.arrive - b.arrive || a.rides - b.rides)
    .slice(0, want);
}

/** Paradas a pie de un punto (lon, lat), con los segundos de caminata. */
export function accessFrom(m: Model, lon: number, lat: number, maxMeters = 700, limit = 40): Access[] {
  const KX = 111_320 * Math.cos((4.65 * Math.PI) / 180), KY = 110_574;
  const out: Access[] = [];
  m.stops.forEach((s, i) => {
    const d = Math.hypot((s.lon - lon) * KX, (s.lat - lat) * KY);
    if (d <= maxMeters) out.push({ stop: i, seconds: Math.round((d * DETOUR) / WALK_MS) });
  });
  return out.sort((a, b) => a.seconds - b.seconds).slice(0, limit);
}

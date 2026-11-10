import type { Network } from '../data/network';
import type { Fleet } from './fleet';
import { apiBase, type VehiclesV1 } from './api';
import { KX, KY } from '../domain/geo';
import { resolveReading } from './backupResolve';
import { STALE_FEED_S } from './poller';

/**
 * Respaldo por ruta (ver transmi-live-worker/docs/WORKER.md): las posiciones de las rutas que se están
 * mirando se piden al servicio por ruta con las credenciales de quien usa la página (appid y uuid, como
 * en la app nativa) cuando el alimentador en vivo no las da.
 *
 * - Las credenciales se guardan solo en este navegador (`localStorage`) y viajan en el cuerpo de la
 *   petición al Worker, que las reenvía sin guardarlas. Sin credenciales, no hay respaldo.
 * - Dos casos: el alimentador quieto (más de `STALE_FEED_S` sin datos nuevos), o en marcha pero sin
 *   ningún bus de esa ruta (trae solo parte de la flota: el 9 nov. 2026 faltaba entera la del FZ63). En
 *   el segundo no se reemplaza nada: solo se suman los buses que el alimentador no trae.
 * - Solo para la ruta abierta, el bus seguido o los tramos del viaje: a lo sumo 4 rutas, cada 20 s. Una
 *   ruta para la que el respaldo tampoco trae buses se vuelve a consultar a los 2 min.
 * - Los buses que solo trae el respaldo duran 3 min desde su última lectura (`BACKUP_KEEP` en la flota):
 *   al dejar de mirar la ruta, salen del mapa.
 * - Credenciales rechazadas: se detiene hasta que se cambien. Servicio caído: espera 1 min.
 */
export interface Credentials { appid: string; uuid: string }

interface RouteResponse {
  v: 1; code: string; t: number; n: number;
  id: string[]; label: string[]; route: string[]; rcode: string[]; dest: string[]; sys: ('troncal' | 'zonal')[];
  lat: number[]; lon: number[]; bearing: number[]; age: number[]; occ: string[];
}

const KEY = 'transmi-live:respaldo:v1';
const EVERY = 20_000;
const MAX_ROUTES = 4;
/** Espera antes de volver a consultar una ruta para la que el respaldo no trajo buses. */
const EMPTY_WAIT = 120_000;

function load(): Credentials | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Credentials | null;
    return v && typeof v.appid === 'string' && v.appid ? { appid: v.appid, uuid: typeof v.uuid === 'string' ? v.uuid : '' } : null;
  } catch { return null; }
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

class Backup {
  creds = $state<Credentials | null>(load());
  /** `off` sin credenciales; `ready` con ellas y sin usarse; `active` en uso; `rejected`/`unavailable` tras un error. */
  status = $state<'off' | 'ready' | 'active' | 'rejected' | 'unavailable'>(load() ? 'ready' : 'off');
  /** Rutas consultadas en la última vuelta y su hora. */
  codes = $state<string[]>([]);
  at = $state<number | null>(null);
  /** Tras incorporar lecturas (la app actualiza conteos y listas, como con el alimentador). */
  onChange: (() => void) | null = null;
  private lastRun = 0;
  private pauseUntil = 0;
  private running = false;

  save(c: Credentials) {
    const v = { appid: c.appid.trim(), uuid: c.uuid.trim() };
    localStorage.setItem(KEY, JSON.stringify(v));
    this.creds = v;
    this.status = 'ready';
    this.pauseUntil = 0;
  }

  clear() {
    localStorage.removeItem(KEY);
    this.creds = null;
    this.status = 'off';
    this.codes = [];
  }

  /**
   * Cada segundo (reloj de la app): si toca, consulta las rutas y las incorpora a la flota.
   * `feedTime` es la hora del alimentador (s); `codes`, las rutas a mirar.
   */
  tick(net: Network | null, fleet: Fleet | null, feedTime: number | null, codes: string[], now = Date.now()) {
    if (!this.creds || !net || !fleet || this.running) return;
    const stale = !feedTime || now / 1000 - feedTime > STALE_FEED_S;
    // Con el alimentador en marcha, solo las rutas de las que no trae ningún bus.
    const want = this.wanted(fleet, codes, stale, now);
    if (!want.length) {
      if (this.status === 'active') { this.status = 'ready'; this.codes = []; }
      return;
    }
    if (this.status === 'rejected' || now < this.pauseUntil || now - this.lastRun < EVERY) return;
    this.lastRun = now;
    void this.run(net, fleet, want, stale);
  }

  /** Rutas que toca consultar ahora (ver los dos casos arriba), sin repetir y a lo sumo `MAX_ROUTES`. */
  wanted(fleet: Fleet, codes: string[], stale: boolean, now: number): string[] {
    const out: string[] = [];
    for (const c of new Set(codes.map((x) => x.toUpperCase()))) {
      if ((this.emptyUntil.get(c) ?? 0) > now) continue;
      if (stale || fleet.reporting(c) === 0) out.push(c);
    }
    return out.slice(0, MAX_ROUTES);
  }
  private emptyUntil = new Map<string, number>();

  private async run(net: Network, fleet: Fleet, codes: string[], replace: boolean) {
    const creds = this.creds;
    if (!creds) return;
    this.running = true;
    try {
      const got: string[] = [];
      for (const code of codes) {
        const res = await fetch(`${apiBase()}/v1/respaldo/ruta`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ruta: code, appid: creds.appid, uuid: creds.uuid }),
          cache: 'no-store',
        }).catch(() => null);
        if (!res) { this.fail(); return; }
        if (res.status === 401) { this.status = 'rejected'; this.codes = []; return; }
        if (res.status === 404) { this.status = 'unavailable'; this.pauseUntil = Date.now() + 10 * 60_000; return; } // respaldo apagado en el Worker
        if (!res.ok) { this.fail(); return; }
        const data = (await res.json()) as RouteResponse;
        // Con el alimentador detenido reemplaza: los buses del GTFS de este código que no vinieron en
        // el respaldo salen (son de antes de que se detuviera). Con el alimentador en marcha solo suma.
        const snap = this.toSnapshot(net, fleet, data);
        fleet.merge(snap, Date.now(), replace ? [code] : []);
        if (snap.n) { got.push(code); this.emptyUntil.delete(code); }
        else this.emptyUntil.set(code, Date.now() + EMPTY_WAIT);
      }
      this.status = got.length ? 'active' : 'ready';
      this.codes = got;
      this.at = Date.now();
      this.onChange?.();
    } finally {
      this.running = false;
    }
  }

  private fail() {
    this.status = 'unavailable';
    this.pauseUntil = Date.now() + 60_000;
  }

  /** Respuesta del Worker → instantánea parcial para `Fleet.merge`, con rutas e ids de nuestra red. */
  private toSnapshot(net: Network, fleet: Fleet, r: RouteResponse): VehiclesV1 {
    const byLabel = new Map<string, string>();
    for (const b of fleet.buses.values()) if (b.label) byLabel.set(b.label, b.id);
    const out: VehiclesV1 = { v: 1, t: r.t, n: 0, id: [], label: [], plate: [], route: [], lat: [], lon: [], age: [], stop: [], seq: [], start: [] };
    for (let i = 0; i < r.n; i++) {
      const lon = -74.1 + r.lon[i] / 1e5, lat = 4.6 + r.lat[i] / 1e5;
      const id = (r.label[i] && byLabel.get(r.label[i])) || `ruta:${r.label[i] || r.id[i]}`;
      const prev = fleet.buses.get(id);
      // Variante y sentido por destino, rumbo y cercanía (la Ruta Fácil 5 no mezcla Portal Américas con
      // Av. Jiménez). Sin variante que corresponda, no se dibuja.
      const routeId = resolveReading(net, { routeId: r.route[i], code: r.rcode[i] || r.code, dest: r.dest[i], sys: r.sys[i], x: lon * KX, y: lat * KY, bearing: r.bearing[i] }, prev?.routeId);
      if (!routeId) continue;
      out.id.push(id);
      out.label.push(r.label[i]);
      out.plate.push(prev?.plate ?? '');
      out.route.push(routeId);
      out.lat.push(r.lat[i]);
      out.lon.push(r.lon[i]);
      out.age.push(Math.max(0, r.age[i]));
      out.stop.push(prev?.stopId ?? '');
      out.seq.push(prev?.seq ?? 0);
      out.start.push(prev?.start ?? 0);
      out.n++;
    }
    return out;
  }
}

export const backup = new Backup();

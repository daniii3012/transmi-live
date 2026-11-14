import { fetchVehicles, type VehiclesV1 } from './api';

export interface PollState {
  /** `live`: datos al día; `stale`: la última lectura tiene más de `STALE_FEED_S`; `error`: falla; `idle`: pausado. */
  status: 'connecting' | 'live' | 'stale' | 'error' | 'idle';
  feedTime: number | null;
  receivedAt: number | null;
  error: string | null;
  vehicles: number;
}

/**
 * Segundos sin lecturas nuevas para dar el alimentador por detenido. Desde el 9 nov. 2026 sus lecturas
 * llegan con 25–95 s de antigüedad (se regenera cada ~50 s con lecturas de ~40 s): con 120 s, una sola
 * vuelta perdida ya lo marcaba «Sin actualizar».
 */
export const STALE_FEED_S = 150;

function saveData(): boolean {
  return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

/** Una consulta que lleva más de esto sin terminar se da por colgada: se cancela y se pide de nuevo. */
export const STUCK_MS = 20_000;
/** Cada cuánto revisa el vigía que el sondeo siga vivo (solo compara horas: no cuesta nada). */
export const WATCH_MS = 1_000;

/**
 * Sondeo del API: cada `interval` ms con la pestaña visible; nada con la pestaña oculta; espera
 * creciente tras errores (15 → 30 → 60 s). `If-None-Match` evita bajar dos veces la misma instantánea.
 *
 * Al volver de segundo plano, un iPhone puede no avisar (o avisar tarde, con la página aún «oculta»;
 * WebKit 207256), y lo que estaba en curso puede no terminar nunca. Por eso, además de
 * `visibilitychange`, un vigía revisa cada `WATCH_MS` con la hora del reloj: con la página visible, pide
 * ya si no hay consulta programada a tiempo, si la que corre está colgada o si sus propios temporizadores
 * estuvieron congelados (la app suspendida): lo que estaba en curso o programado es de antes. Una sola
 * vuelta a la vez: cada consulta lleva su número y la que fue reemplazada no programa la siguiente.
 */
export class Poller {
  private etag: string | null = null;
  private timer = 0;
  private watcher = 0;
  private failures = 0;
  private ctrl: AbortController | null = null;
  private stopped = false;
  /** Número de la vuelta vigente: una consulta de otra vuelta no toca el estado ni programa nada. */
  private gen = 0;
  /** Inicio de la consulta en curso (0: ninguna) y hora de la siguiente programada (0: ninguna). */
  private busySince = 0;
  private nextAt = 0;
  /** Inicio de la última consulta y última revisión del vigía. */
  private lastStart = 0;
  private lastCheck = 0;
  state: PollState = { status: 'connecting', feedTime: null, receivedAt: null, error: null, vehicles: 0 };

  constructor(
    private base: string,
    private onData: (d: VehiclesV1, receivedAt: number) => void,
    private onState: (s: PollState) => void,
    private interval = 15_000,
  ) {
    document.addEventListener('visibilitychange', this.onVisibility);
    // Otras señales de regreso: página restaurada, ventana enfocada, red de vuelta.
    for (const ev of ['pageshow', 'focus', 'online'] as const) addEventListener(ev, this.check);
  }

  start() {
    this.stopped = false;
    clearInterval(this.watcher);
    this.watcher = window.setInterval(this.check, WATCH_MS);
    this.tick();
  }

  stop() {
    this.stopped = true;
    this.cancel();
    clearInterval(this.watcher);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const ev of ['pageshow', 'focus', 'online'] as const) removeEventListener(ev, this.check);
  }

  /** Pide ya (por ejemplo al volver a la pestaña). */
  now() { this.cancel(); this.tick(); }

  /** Termina la vuelta vigente: sin temporizador ni consulta en curso. */
  private cancel() {
    this.gen++;
    clearTimeout(this.timer);
    this.nextAt = 0;
    this.busySince = 0;
    this.ctrl?.abort();
    this.ctrl = null;
  }

  /** Vigía: con la página visible, pide ya si no hay nada programado a tiempo o la consulta se colgó. */
  private check = () => {
    const t = Date.now(), prev = this.lastCheck;
    this.lastCheck = t;
    if (this.stopped || document.hidden || t - this.lastStart < WATCH_MS) return;
    const frozen = prev > 0 && t - prev > 3 * WATCH_MS && t - this.lastStart > 3 * WATCH_MS;
    const stuck = this.busySince > 0 && t - this.busySince > STUCK_MS;
    const late = !this.busySince && (!this.nextAt || t > this.nextAt + 5_000);
    if (frozen || stuck || late) this.now();
  };

  private onVisibility = () => {
    if (document.hidden) {
      this.cancel();
      this.set({ status: 'idle' });
    } else if (!this.stopped && Date.now() - this.lastStart >= WATCH_MS) this.now();
  };

  private set(p: Partial<PollState>) {
    this.state = { ...this.state, ...p };
    this.onState(this.state);
  }

  private async tick() {
    if (this.stopped || document.hidden) return;
    const g = ++this.gen;
    const ctrl = (this.ctrl = new AbortController());
    this.busySince = this.lastStart = Date.now();
    this.nextAt = 0;
    // Tiempo límite: una petición colgada no puede dejar la página en «Conectando» para siempre.
    let timedOut = false;
    const limit = window.setTimeout(() => { timedOut = true; ctrl.abort(); }, 12_000);
    let r = await fetchVehicles(this.base, this.etag, ctrl.signal);
    clearTimeout(limit);
    if (g !== this.gen) return;
    this.busySince = 0;
    this.ctrl = null;
    if (timedOut && r.status === 'error') r = { status: 'error', message: 'sin respuesta' };
    const now = Date.now();
    if (r.status === 'ok') {
      this.failures = 0;
      this.etag = r.etag;
      this.onData(r.data, now);
      this.set({ status: now / 1000 - r.data.t > STALE_FEED_S ? 'stale' : 'live', feedTime: r.data.t, receivedAt: now, error: null, vehicles: r.data.n });
    } else if (r.status === 'same') {
      this.failures = 0;
      const t = this.state.feedTime;
      this.set({ status: t && now / 1000 - t > STALE_FEED_S ? 'stale' : 'live', error: null });
    } else if (r.message !== 'cancelado') {
      this.failures++;
      this.set({ status: 'error', error: r.message });
    }
    if (this.stopped || document.hidden) return;
    // Con el ahorro de datos del sistema (Android/Chrome), cada 30 s: en `passthrough` cada sondeo son
    // ≈ 290 kB. El movimiento entre lecturas lo suaviza el rastreo; la flota se adapta al intervalo.
    const every = saveData() ? Math.max(this.interval, 30_000) : this.interval;
    const wait = this.failures ? Math.min(60_000, every * 2 ** (this.failures - 1)) : every;
    this.nextAt = Date.now() + wait;
    this.timer = window.setTimeout(() => this.tick(), wait);
  }
}

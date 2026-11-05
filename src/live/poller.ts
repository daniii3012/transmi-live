import { fetchVehicles, type VehiclesV1 } from './api';

export interface PollState {
  /** `live`: datos al día; `stale`: la última respuesta tiene más de 2 min; `error`: falla; `idle`: pausado. */
  status: 'connecting' | 'live' | 'stale' | 'error' | 'idle';
  feedTime: number | null;
  receivedAt: number | null;
  error: string | null;
  vehicles: number;
}

function saveData(): boolean {
  return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

/**
 * Sondeo del API: cada `interval` ms con la pestaña visible; nada con la pestaña oculta; espera
 * creciente tras errores (15 → 30 → 60 s). `If-None-Match` evita bajar dos veces la misma instantánea.
 */
export class Poller {
  private etag: string | null = null;
  private timer = 0;
  private failures = 0;
  private ctrl: AbortController | null = null;
  private stopped = false;
  state: PollState = { status: 'connecting', feedTime: null, receivedAt: null, error: null, vehicles: 0 };

  constructor(
    private base: string,
    private onData: (d: VehiclesV1, receivedAt: number) => void,
    private onState: (s: PollState) => void,
    private interval = 15_000,
  ) {
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  start() { this.stopped = false; this.tick(); }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ctrl?.abort();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  /** Pide ya (por ejemplo al volver a la pestaña). */
  now() { clearTimeout(this.timer); this.tick(); }

  private onVisibility = () => {
    if (document.hidden) {
      clearTimeout(this.timer);
      this.ctrl?.abort();
      this.set({ status: 'idle' });
    } else if (!this.stopped) this.now();
  };

  private set(p: Partial<PollState>) {
    this.state = { ...this.state, ...p };
    this.onState(this.state);
  }

  private async tick() {
    if (this.stopped || document.hidden) return;
    this.ctrl = new AbortController();
    // Tiempo límite: una petición colgada no puede dejar la página en «Conectando» para siempre.
    let timedOut = false;
    const ctrl = this.ctrl;
    const limit = window.setTimeout(() => { timedOut = true; ctrl.abort(); }, 12_000);
    let r = await fetchVehicles(this.base, this.etag, this.ctrl.signal);
    clearTimeout(limit);
    if (timedOut && r.status === 'error') r = { status: 'error', message: 'sin respuesta' };
    const now = Date.now();
    if (r.status === 'ok') {
      this.failures = 0;
      this.etag = r.etag;
      this.onData(r.data, now);
      this.set({ status: now / 1000 - r.data.t > 120 ? 'stale' : 'live', feedTime: r.data.t, receivedAt: now, error: null, vehicles: r.data.n });
    } else if (r.status === 'same') {
      this.failures = 0;
      const t = this.state.feedTime;
      this.set({ status: t && now / 1000 - t > 120 ? 'stale' : 'live', error: null });
    } else if (r.message !== 'cancelado') {
      this.failures++;
      this.set({ status: 'error', error: r.message });
    }
    if (this.stopped || document.hidden) return;
    // Con el ahorro de datos del sistema (Android/Chrome), cada 30 s: en `passthrough` cada sondeo son
    // ≈ 290 kB. El movimiento entre lecturas lo suaviza el rastreo; la flota se adapta al intervalo.
    const every = saveData() ? Math.max(this.interval, 30_000) : this.interval;
    const wait = this.failures ? Math.min(60_000, every * 2 ** (this.failures - 1)) : every;
    this.timer = window.setTimeout(() => this.tick(), wait);
  }
}

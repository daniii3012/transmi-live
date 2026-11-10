import type { Network } from '../data/network';
import type { Fleet } from '../live/fleet';
import { etas, bandIndex, bandTimes, pace, etaText } from '../domain/eta';
import { bogotaSeconds } from '../domain/time';

/**
 * Aviso de llegada: un bus y una parada de su itinerario; cuando le falten `threshold` segundos (estimado),
 * aviso en pantalla, vibración y, si la app está en segundo plano y hay permiso, notificación del
 * sistema. Funciona con la app abierta (sin servidor de avisos todavía; ver APP_NATIVA.md).
 */
export interface Watched { busId: string; busLabel: string; routeCode: string; color: string; index: number; stopName: string; threshold: number }
export interface Toast { text: string; busId: string | null; at: number; action?: { label: string; run: () => void } }

/** Tiempo que el aviso espera a un bus que salió de la flota antes de cancelarse. */
const LOST_MS = 4 * 60_000;

class Watch {
  item = $state<Watched | null>(null);
  toast = $state<Toast | null>(null);
  /** Estimado actual hasta la parada (s), para mostrarlo en la ficha. */
  seconds = $state<number | null>(null);
  private toastTimer = 0;
  /** Desde cuándo falta en la flota el bus del aviso. */
  private lostAt: number | null = null;

  is(busId: string, index: number) { return this.item?.busId === busId && this.item.index === index; }

  set(w: Watched | null) {
    this.item = w;
    this.seconds = null;
    this.lostAt = null;
    if (w && typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission().catch(() => {});
  }

  show(text: string, busId: string | null, action?: Toast['action'], ms = 12_000) {
    clearTimeout(this.toastTimer);
    this.toast = { text, busId, at: Date.now(), action };
    if (ms > 0) this.toastTimer = window.setTimeout(() => (this.toast = null), ms);
  }

  /** Cada segundo (reloj de la app). */
  check(net: Network | null, fleet: Fleet | null, now = Date.now()) {
    const w = this.item;
    if (!w || !net || !fleet) return;
    const bus = fleet.buses.get(w.busId);
    // El bus salió de la flota: se espera unos minutos por si vuelve (el alimentador omite buses por
    // momentos) y, si no, el aviso se cancela diciéndolo: esperar para siempre sería un aviso que no llega.
    if (!bus) {
      this.lostAt ??= now;
      if (now - this.lostAt > LOST_MS) {
        this.set(null);
        this.show(`Aviso cancelado: el bus ${w.busLabel} (${w.routeCode}) dejó de reportar antes de ${w.stopName}`, null);
      }
      return;
    }
    this.lostAt = null;
    const p = net.pattern(bus.routeId);
    if (!p || !bus.onPath) return; // sin dato por ahora: se sigue esperando
    const band = bandIndex(bogotaSeconds(now));
    const t = bandTimes(p, band);
    const k = t ? pace(p, t, bus.hist) : 1;
    const e = etas(p, band, bus.sFix, (now - bus.fixAt) / 1000, k, 80).find((x) => x.index === w.index);
    if (!e) {
      this.set(null);
      this.show(`Aviso cancelado: el ${w.routeCode} (bus ${w.busLabel}) ya pasó por ${w.stopName}`, w.busId);
      return;
    }
    this.seconds = e.seconds;
    if (e.seconds > w.threshold) return;
    const text = `${w.routeCode} llegando a ${w.stopName} · ${e.seconds < 60 ? 'ahora' : etaText(e.seconds)}`;
    this.set(null);
    this.show(text, w.busId);
    navigator.vibrate?.([120, 80, 120]);
    if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification('TransMi Live', { body: text, tag: `llegada-${w.busId}` }); } catch { /* algunos navegadores solo desde el service worker */ }
    }
  }
}

export const watch = new Watch();

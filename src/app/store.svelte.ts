import type { Network } from '../data/network';
import type { Fleet } from '../live/fleet';
import type { PollState } from '../live/poller';
import type { SystemKey } from '../domain/types';
import type { Alert } from '../live/alerts';
import { parse, type View } from './router';

/**
 * Estado de la interfaz (runas de Svelte 5). El mapa y el motor no viven aquí: el controlador los
 * conecta y escribe en este estado lo que la interfaz necesita leer.
 */
class AppState {
  net = $state.raw<Network | null>(null);
  fleet = $state.raw<Fleet | null>(null);
  view = $state<View>(parse());
  hidden = $state<SystemKey[]>([]);
  poll = $state<PollState>({ status: 'connecting', feedTime: null, receivedAt: null, error: null, vehicles: 0 });
  counts = $state<Record<SystemKey, number>>({ troncal: 0, dual: 0, alimentador: 0, zonal: 0, cable: 0 });
  /** Cambia con cada instantánea nueva: las vistas que dependen de la flota se recalculan. */
  version = $state(0);
  /** Reloj de la interfaz (1 Hz) para antigüedades y cuentas regresivas. */
  now = $state(Date.now());
  following = $state(false);
  searchOpen = $state(false);
  patternsReady = $state(false);
  narrow = $state(typeof window !== 'undefined' && window.innerWidth < 760);
  /** Altura de la hoja inferior (móvil) en px, para el relleno de la cámara. */
  sheetHeight = $state(0);
  locating = $state(false);
  threeD = $state(false);
  /** Ubicación propia (lon, lat), si la persona la pidió. */
  userPos = $state<[number, number] | null>(null);
  alerts = $state.raw<Alert[]>([]);
  /** Pulso: buses en vía por instantánea desde que se abrió la página (hasta 2 h). */
  pulse = $state.raw<{ t: number; n: number }[]>([]);
}

export const app = new AppState();

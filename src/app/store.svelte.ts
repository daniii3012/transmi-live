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
const LAYERS_KEY = 'transmi-live:capas:v1';
function loadLayers() {
  // El trazado zonal de fondo, apagado por defecto: llenaba la ciudad de azul (revisión R1.7).
  // Recorridos duales también apagados (R2): sin foco, el mapa muestra solo la guía de cada troncal.
  // Las troncales en obra (modo de obras), apagadas: son una vista previa.
  const base = { zonal: false, dual: false, stops: true, metro: false, obras: false, trails: false, speed: false };
  try { return { ...base, ...JSON.parse(localStorage.getItem(LAYERS_KEY) ?? '{}') }; } catch { return base; }
}
const PREFS_KEY = 'transmi-live:preferencias:v1';
export interface Prefs { hidden: SystemKey[]; threeD: boolean; motion?: 'continuo' | 'directo'; camera?: { center: [number, number]; zoom: number; bearing: number; pitch: number; hash: string; at: number } }
export function loadPrefs(): Prefs {
  try { return { hidden: [], threeD: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }; } catch { return { hidden: [], threeD: false }; }
}
export function savePrefs(p: Partial<Prefs>) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...p })); } catch { /* modo privado */ }
}

export function saveLayers(v: object) { try { localStorage.setItem(LAYERS_KEY, JSON.stringify(v)); } catch { /* modo privado */ } }

class AppState {
  net = $state.raw<Network | null>(null);
  fleet = $state.raw<Fleet | null>(null);
  view = $state<View>(parse());
  hidden = $state<SystemKey[]>(typeof localStorage !== 'undefined' ? loadPrefs().hidden : []);
  /** Movimiento de los buses entre lecturas (Configuración); por defecto, continuo. */
  motion = $state<'continuo' | 'directo'>(typeof localStorage !== 'undefined' ? loadPrefs().motion ?? 'continuo' : 'continuo');
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
  /** Alto de la barra superior (móvil) en px; en la app instalada es más alta (la isla). */
  topbarH = $state(0);
  locating = $state(false);
  threeD = $state(false);
  /** Menú del mapa (mantener presionado o clic derecho): punto y posición en pantalla. */
  ctxMenu = $state<{ x: number; y: number; lon: number; lat: number } | null>(null);
  themePref = $state<'system' | 'dark' | 'light'>('system');
  /** Capas opcionales del mapa (se guardan en el dispositivo). */
  layersOn = $state<{ zonal: boolean; dual: boolean; stops: boolean; metro: boolean; obras: boolean; trails: boolean; speed: boolean }>(loadLayers());
  layersOpen = $state(false);
  /** Ubicación propia (lon, lat), si la persona la pidió. */
  userPos = $state<[number, number] | null>(null);
  alerts = $state.raw<Alert[]>([]);
  /** Pulso: buses en vía por instantánea desde que se abrió la página (hasta 2 h). */
  pulse = $state.raw<{ t: number; n: number }[]>([]);
}

export const app = new AppState();

/** Formato `vehicles` v1 del Worker (ver docs/WORKER.md en el repositorio del Worker). */
export interface VehiclesV1 {
  v: 1;
  t: number;
  n: number;
  id: string[];
  label: string[];
  plate: string[];
  route: string[];
  lat: number[];
  lon: number[];
  age: number[];
  stop: string[];
  seq: number[];
  start: number[];
}
export const LAT0 = 4.6, LON0 = -74.1, Q = 1e5;

/**
 * Dirección del API en vivo: `?api=` en la URL (desarrollo, repetición), si no la de compilación
 * (`VITE_API_BASE`), si no el Worker local.
 */
export function apiBase(): string {
  const q = new URLSearchParams(location.search).get('api');
  if (q) return q.replace(/\/$/, '');
  const env = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '');
  if (env) return env;
  // En desarrollo, el Worker local en la misma máquina que sirvió la página: así funciona también
  // abriendo la página desde otro equipo de la red (por la IP).
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' ? 'http://127.0.0.1:8787' : `http://${h}:8787`;
}

export type FetchResult =
  | { status: 'ok'; data: VehiclesV1; etag: string | null }
  | { status: 'same' }
  | { status: 'error'; message: string };

/**
 * Tiempo que se espera al decodificador. Decodificar toma decenas de milisegundos; si no responde, el
 * hilo se da por perdido (un iPhone que suspende la app instalada puede dejarlo sin responder) y la
 * consulta siguiente crea otro. Antes se esperaba sin límite: una respuesta perdida dejaba el sondeo
 * detenido hasta cerrar la app.
 */
export const DECODE_TIMEOUT_MS = 10_000;

type Pending = { resolve: (d: VehiclesV1) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
let decoder: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

/** Descarta el hilo y rechaza lo que esperaba respuesta de él. */
function dropDecoder(reason: string) {
  decoder?.terminate();
  decoder = null;
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
  pending.clear();
}

function getDecoder(): Worker {
  if (decoder) return decoder;
  const w = new Worker(new URL('./pb/decode.worker.ts', import.meta.url), { type: 'module' });
  // Cada respuesta va a la petición que la pidió (con dos sondeos cruzados, ninguna se pierde).
  w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; data?: VehiclesV1; message?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    clearTimeout(p.timer);
    if (e.data.ok) p.resolve(e.data.data!); else p.reject(new Error(e.data.message));
  };
  w.onerror = () => { if (decoder === w) dropDecoder('decodificador caído'); };
  w.onmessageerror = () => { if (decoder === w) dropDecoder('decodificador caído'); };
  return (decoder = w);
}

/** Protobuf (Worker en modo `passthrough`) → formato v1, en un Web Worker. */
function decodePb(buf: ArrayBuffer, signal?: AbortSignal): Promise<VehiclesV1> {
  if (signal?.aborted) return Promise.reject(new DOMException('cancelado', 'AbortError'));
  const w = getDecoder();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (decoder === w) dropDecoder('decodificador sin respuesta'); }, DECODE_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    signal?.addEventListener('abort', () => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      reject(new DOMException('cancelado', 'AbortError'));
    }, { once: true });
    w.postMessage({ id, buf }, [buf]);
  });
}

export async function fetchVehicles(base: string, etag: string | null, signal?: AbortSignal): Promise<FetchResult> {
  try {
    const res = await fetch(`${base}/v1/vehicles`, { headers: etag ? { 'if-none-match': etag } : {}, signal, cache: 'no-store' });
    if (res.status === 304) return { status: 'same' };
    if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
    // El Worker decide el formato: JSON compacto o, en modo `passthrough`, el protobuf tal cual.
    const pb = (res.headers.get('content-type') ?? '').includes('protobuf');
    const data = pb ? await decodePb(await res.arrayBuffer(), signal) : ((await res.json()) as VehiclesV1);
    if (data.v !== 1) return { status: 'error', message: 'formato desconocido' };
    return { status: 'ok', data, etag: res.headers.get('etag') };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { status: 'error', message: 'cancelado' };
    if (/^decodificador/.test((e as Error).message)) return { status: 'error', message: (e as Error).message };
    return { status: 'error', message: 'sin conexión' };
  }
}

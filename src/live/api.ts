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
  return (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || 'http://127.0.0.1:8787';
}

export type FetchResult =
  | { status: 'ok'; data: VehiclesV1; etag: string | null }
  | { status: 'same' }
  | { status: 'error'; message: string };

export async function fetchVehicles(base: string, etag: string | null, signal?: AbortSignal): Promise<FetchResult> {
  try {
    const res = await fetch(`${base}/v1/vehicles`, { headers: etag ? { 'if-none-match': etag } : {}, signal, cache: 'no-store' });
    if (res.status === 304) return { status: 'same' };
    if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
    const data = (await res.json()) as VehiclesV1;
    if (data.v !== 1) return { status: 'error', message: 'formato desconocido' };
    return { status: 'ok', data, etag: res.headers.get('etag') };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { status: 'error', message: 'cancelado' };
    return { status: 'error', message: 'sin conexión' };
  }
}

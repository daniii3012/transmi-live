// Copia de transmi-live-worker/src/compact.ts (mantener las dos iguales).
import type { Vehicle } from './positions';

/** Origen de las coordenadas enteras del formato compacto. */
export const LAT0 = 4.6, LON0 = -74.1, Q = 1e5;
/** Lecturas más viejas que esto respecto a la más reciente no se envían. */
export const MAX_AGE_S = 20 * 60;

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

/** «HH:MM:SS» → minutos desde medianoche (puede pasar de 1440 en viajes de madrugada). */
export function minutes(hms: string): number {
  const m = /^(\d+):(\d\d)/.exec(hms);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

/**
 * Formato columnar v1. Una entrada por vehículo (la lectura más reciente si viene repetido), en
 * orden estable por id para que el gzip encuentre repeticiones entre columnas.
 */
export function compact(vehicles: Vehicle[]): VehiclesV1 {
  const latest = new Map<string, Vehicle>();
  let t = 0;
  for (const v of vehicles) {
    const key = v.id || v.label;
    const prev = latest.get(key);
    if (!prev || v.ts > prev.ts) latest.set(key, v);
    if (v.ts > t) t = v.ts;
  }
  const list = [...latest.values()].filter((v) => t - v.ts <= MAX_AGE_S).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: VehiclesV1 = { v: 1, t, n: list.length, id: [], label: [], plate: [], route: [], lat: [], lon: [], age: [], stop: [], seq: [], start: [] };
  for (const v of list) {
    out.id.push(v.id);
    out.label.push(v.label);
    out.plate.push(v.plate);
    out.route.push(v.routeId);
    out.lat.push(Math.round((v.lat - LAT0) * Q) || 0); // `|| 0`: sin ceros negativos
    out.lon.push(Math.round((v.lon - LON0) * Q) || 0);
    out.age.push(Math.max(0, t - v.ts));
    out.stop.push(v.stopId);
    out.seq.push(v.seq);
    out.start.push(minutes(v.startTime));
  }
  return out;
}

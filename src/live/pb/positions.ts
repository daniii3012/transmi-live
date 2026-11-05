// Copia de transmi-live-worker/src/positions.ts (mantener las dos iguales). Se usa solo si el Worker
// corre en modo `passthrough` y entrega el protobuf sin decodificar.


/** Una lectura de posición tal como viene en el alimentador. */
export interface Vehicle {
  id: string;
  label: string;
  plate: string;
  tripId: string;
  routeId: string;
  startTime: string;
  lat: number;
  lon: number;
  bearing: number | null;
  speed: number | null;
  ts: number;
  stopId: string;
  seq: number;
  status: number | null;
}

export interface Feed { header: number; vehicles: Vehicle[] }

/** El `trip_id` no se usa en el formato compacto; decodificarlo cuesta ~10 % del tiempo. */
let withTripIds = false;

// Decodificador de posiciones con un solo cursor y sin reservar objetos por campo: con la flota
// completa (8.000+ vehículos) el lector genérico creaba ~100.000 objetos por instantánea y pasaba del
// límite de CPU del plan gratuito. Mismo resultado que con `Reader` (las pruebas comparan).
let B: Uint8Array;
let P = 0;
let V: DataView;
const td8 = new TextDecoder();

function vi(): number {
  let x = 0, mul = 1, b: number;
  do { b = B[P++]; x += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
  return x;
}
/** Fin de un campo de longitud: primero se lee la longitud (avanza el cursor), luego se suma. */
function endOf(): number { const n = vi(); return P + n; }
function str(end: number): string {
  const s = P;
  P = end;
  if (end - s <= 24) {
    let out = '';
    for (let i = s; i < end; i++) { const c = B[i]; if (c > 127) return td8.decode(B.subarray(s, end)); out += String.fromCharCode(c); }
    return out;
  }
  return td8.decode(B.subarray(s, end));
}
function skip(w: number) {
  if (w === 0) vi(); else if (w === 1) P += 8; else if (w === 2) { const n = vi(); P += n; } else if (w === 5) P += 4; else throw new Error(`tipo de cable no soportado: ${w}`);
}

/** Decodifica `positions.pb` (FeedMessage de GTFS-Realtime 2.0). */
export function decodePositions(buf: Uint8Array, opts: { tripIds?: boolean } = {}): Feed {
  withTripIds = opts.tripIds ?? false;
  B = buf; P = 0; V = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let header = 0;
  const vehicles: Vehicle[] = [];
  const end = buf.length;
  while (P < end) {
    const tag = vi(), f = tag >>> 3, w = tag & 7;
    if (f === 1 && w === 2) {
      const e = endOf();
      while (P < e) { const t2 = vi(); if ((t2 >>> 3) === 3 && (t2 & 7) === 0) header = vi(); else skip(t2 & 7); }
      P = e;
    } else if (f === 2 && w === 2) {
      const e = endOf();
      while (P < e) {
        const t2 = vi();
        if ((t2 >>> 3) === 4 && (t2 & 7) === 2) {
          const ve = endOf();
          const v = vehiclePosition(ve);
          if (v) vehicles.push(v);
          P = ve;
        } else skip(t2 & 7);
      }
      P = e;
    } else skip(w);
  }
  return { header, vehicles };
}

function vehiclePosition(end: number): Vehicle | null {
  const v: Vehicle = {
    id: '', label: '', plate: '', tripId: '', routeId: '', startTime: '',
    lat: NaN, lon: NaN, bearing: null, speed: null, ts: 0, stopId: '', seq: -1, status: null,
  };
  while (P < end) {
    const tag = vi(), f = tag >>> 3, w = tag & 7;
    if (f === 1 && w === 2) { // TripDescriptor
      const e = endOf();
      while (P < e) {
        const t = vi(), g = t >>> 3;
        if (g === 5) v.routeId = str(endOf());
        else if (g === 2) v.startTime = str(endOf());
        else if (g === 1 && withTripIds) v.tripId = str(endOf());
        else skip(t & 7);
      }
      P = e;
    } else if (f === 2 && w === 2) { // Position
      const e = endOf();
      while (P < e) {
        const t = vi(), g = t >>> 3;
        if (g === 1) { v.lat = V.getFloat32(P, true); P += 4; }
        else if (g === 2) { v.lon = V.getFloat32(P, true); P += 4; }
        else if (g === 3) { v.bearing = V.getFloat32(P, true); P += 4; }
        else if (g === 5) { v.speed = V.getFloat32(P, true); P += 4; }
        else skip(t & 7);
      }
      P = e;
    } else if (f === 3) v.seq = vi();
    else if (f === 4) v.status = vi();
    else if (f === 5) v.ts = vi();
    else if (f === 7 && w === 2) v.stopId = str(endOf());
    else if (f === 8 && w === 2) { // VehicleDescriptor
      const e = endOf();
      while (P < e) {
        const t = vi(), g = t >>> 3;
        if (g === 1) v.id = str(endOf());
        else if (g === 2) v.label = str(endOf());
        else if (g === 3) v.plate = str(endOf());
        else skip(t & 7);
      }
      P = e;
    } else skip(w);
  }
  if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon) || (!v.id && !v.label)) return null;
  return v;
}

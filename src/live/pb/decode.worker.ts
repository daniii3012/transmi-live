/// <reference lib="webworker" />
// Decodifica `positions.pb` fuera del hilo principal (modo `passthrough` del Worker): ~1 MB cada
// 15 s; en un teléfono, decenas de milisegundos que no deben trabar el mapa.
import { decodePositions } from './positions';
import { compact } from './compact';

// Cada petición lleva su número y la respuesta lo devuelve (ver `decodePb` en api.ts).
self.onmessage = (e: MessageEvent<{ id: number; buf: ArrayBuffer }>) => {
  const { id, buf } = e.data;
  try {
    const data = compact(decodePositions(new Uint8Array(buf)).vehicles);
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: true, data });
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};

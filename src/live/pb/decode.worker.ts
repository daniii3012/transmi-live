/// <reference lib="webworker" />
// Decodifica `positions.pb` fuera del hilo principal (modo `passthrough` del Worker): ~1 MB cada
// 15 s; en un teléfono, decenas de milisegundos que no deben trabar el mapa.
import { decodePositions } from './positions';
import { compact } from './compact';

self.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  try {
    const data = compact(decodePositions(new Uint8Array(e.data)).vehicles);
    (self as DedicatedWorkerGlobalScope).postMessage({ ok: true, data });
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};

/// <reference lib="webworker" />
// Decodifica `alerts.pb` fuera del hilo principal (modo `passthrough` del Worker): ~100 kB por minuto.
import { decodeAlerts } from './alerts';

self.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  try {
    (self as DedicatedWorkerGlobalScope).postMessage({ ok: true, data: decodeAlerts(new Uint8Array(e.data)) });
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};

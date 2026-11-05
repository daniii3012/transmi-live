import type { Answer, Place, Query } from './planner.worker';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (a: Answer) => void>();

/** Consulta al planificador (en su Web Worker). El primer pedido carga datos y arma el modelo. */
export function planTrip(from: Place, to: Place, depart: number, day: Query['day']): Promise<Answer> {
  if (!worker) {
    worker = new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<Answer>) => { pending.get(e.data.id)?.(e.data); pending.delete(e.data.id); };
  }
  const id = ++seq;
  const base = new URL(import.meta.env.BASE_URL, location.href).href;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker!.postMessage({ id, base, from, to, depart, day } satisfies Query);
  });
}

export type { Place };

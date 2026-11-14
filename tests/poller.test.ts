import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Sondeo al volver de segundo plano (iPhone, app instalada): el aviso de «oculta» puede llegar tarde y
// lo que estaba en curso puede no terminar nunca. El sondeo tiene que seguir solo, sin cerrar la app.
const h = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'hang' | 'slow', calls: 0 }));
vi.mock('../src/live/api', () => ({
  fetchVehicles: (_base: string, _etag: string | null, signal: AbortSignal) =>
    new Promise((resolve) => {
      h.calls++;
      if (h.mode === 'ok') {
        signal.addEventListener('abort', () => resolve({ status: 'error', message: 'cancelado' }));
        queueMicrotask(() => resolve({ status: 'same' }));
      }
      // `slow`: como el decodificador de antes, no atiende la cancelación y responde a los 3 s.
      if (h.mode === 'slow') setTimeout(() => resolve({ status: 'same' }), 3000);
      // `hang`: no responde nunca ni atiende la cancelación (una respuesta perdida).
    }),
}));
import { Poller, type PollState } from '../src/live/poller';

class FakeDoc extends EventTarget { hidden = false; }
let doc: FakeDoc;
let poller: Poller;
let state: PollState;

function hide(hidden: boolean, notify = true) {
  doc.hidden = hidden;
  if (notify) doc.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  doc = new FakeDoc();
  const win = new EventTarget();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
  vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win));
  vi.useFakeTimers();
  h.mode = 'ok';
  h.calls = 0;
  poller = new Poller('http://api', () => {}, (s) => (state = s));
});

afterEach(() => {
  poller.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sondeo al volver de segundo plano', () => {
  it('sigue aunque el aviso de «oculta» llegue tarde y el de «visible» no llegue', async () => {
    poller.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.calls).toBe(1);
    hide(true); // aviso tardío: llega con la página aún marcada como oculta
    expect(state.status).toBe('idle');
    hide(false, false); // la página ya está a la vista, sin aviso
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.calls).toBe(2);
    expect(state.status).toBe('live');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.calls).toBe(3);
  });

  it('una consulta que no termina nunca se reemplaza', async () => {
    h.mode = 'hang';
    poller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.calls).toBe(1); // colgada: ni el límite de 12 s la saca (no atiende la cancelación)
    h.mode = 'ok';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toBe(2);
    expect(state.status).toBe('live');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls).toBe(4);
  });

  it('ocultar y volver mientras una consulta espera no duplica el sondeo', async () => {
    h.mode = 'slow';
    poller.start(); // consulta 1: responde a los 3 s
    await vi.advanceTimersByTimeAsync(1000);
    hide(true);
    await vi.advanceTimersByTimeAsync(500);
    hide(false); // consulta 2: responde a los 4,5 s; la 1 ya no cuenta
    await vi.advanceTimersByTimeAsync(58_500);
    // Una sola vuelta: 0 s y 1,5 s, luego cada 15 s tras cada respuesta (19,5, 37,5 y 55,5 s). Con dos
    // vueltas serían 8.
    expect(h.calls).toBe(5);
  });

  it('al volver de una suspensión con una consulta en curso, pide de nuevo enseguida', async () => {
    h.mode = 'slow';
    poller.start(); // consulta 1 a los 0 s
    await vi.advanceTimersByTimeAsync(1000);
    // Suspendida 20 s: el reloj avanza pero ningún temporizador corre (como iOS con la app en segundo plano).
    vi.setSystemTime(Date.now() + 20_000);
    await vi.advanceTimersByTimeAsync(1500);
    // Sin esto, la respuesta de la consulta 1 (de antes) llegaría y la siguiente esperaría 15 s más.
    expect(h.calls).toBe(2);
  });

  it('con la página oculta no consulta', async () => {
    poller.start();
    await vi.advanceTimersByTimeAsync(10);
    hide(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.calls).toBe(1);
    hide(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.calls).toBe(2);
  });
});

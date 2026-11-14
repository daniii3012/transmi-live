import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchVehicles, DECODE_TIMEOUT_MS } from '../src/live/api';

// Decodificador en un hilo aparte (modo `passthrough`): una respuesta perdida no puede dejar el sondeo
// esperando para siempre, y con dos peticiones cruzadas cada una recibe la suya.
type Msg = { id: number; buf: ArrayBuffer };
const workers: FakeWorker[] = [];
let reply: 'never' | 'later' = 'later';

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  inbox: Msg[] = [];
  constructor() { workers.push(this); }
  postMessage(m: Msg) {
    this.inbox.push(m);
    if (reply === 'later') setTimeout(() => this.answer(m), 50);
  }
  answer(m: Msg) {
    if (!this.terminated) this.onmessage?.({ data: { id: m.id, ok: true, data: { v: 1, t: new Uint8Array(m.buf)[0], n: 0 } } });
  }
  terminate() { this.terminated = true; }
}

/** Respuesta del Worker en `passthrough`; el primer byte hace de hora para reconocerla. */
const pbResponse = (tag: number) => new Response(new Uint8Array([tag, 0, 0]), { headers: { 'content-type': 'application/x-protobuf' } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  reply = 'later';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('decodificador', () => {
  it('sin respuesta, se da por perdido y la consulta siguiente usa uno nuevo', async () => {
    let tag = 1;
    vi.stubGlobal('fetch', async () => pbResponse(tag++));
    reply = 'never';
    const first = fetchVehicles('http://api', null);
    await vi.advanceTimersByTimeAsync(DECODE_TIMEOUT_MS + 10);
    expect(await first).toEqual({ status: 'error', message: 'decodificador sin respuesta' });
    const lost = workers.at(-1)!;
    expect(lost.terminated).toBe(true);
    reply = 'later';
    const second = fetchVehicles('http://api', null);
    await vi.advanceTimersByTimeAsync(100);
    const r = await second;
    expect(r.status).toBe('ok');
    expect(workers.at(-1)).not.toBe(lost);
  });

  it('dos peticiones cruzadas reciben cada una la suya', async () => {
    let tag = 7;
    vi.stubGlobal('fetch', async () => pbResponse(tag++));
    reply = 'never';
    const a = fetchVehicles('http://api', null);
    const b = fetchVehicles('http://api', null);
    await vi.advanceTimersByTimeAsync(10);
    const w = workers.at(-1)!;
    const [m1, m2] = w.inbox.slice(-2);
    w.answer(m2); // responde primero la segunda
    w.answer(m1);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status === 'ok' && ra.data.t).toBe(7);
    expect(rb.status === 'ok' && rb.data.t).toBe(8);
  });

  it('al cancelar, deja de esperar al decodificador', async () => {
    vi.stubGlobal('fetch', async () => pbResponse(3));
    reply = 'never';
    const ctrl = new AbortController();
    const r = fetchVehicles('http://api', null, ctrl.signal);
    await vi.advanceTimersByTimeAsync(10);
    ctrl.abort();
    expect(await r).toEqual({ status: 'error', message: 'cancelado' });
  });
});

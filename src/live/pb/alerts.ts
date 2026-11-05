// Copia de transmi-live-worker/src/alerts.ts (mantener las dos iguales; aquí el import va sin
// extensión). Se usa solo si el Worker corre en modo `passthrough` y entrega el protobuf.
import { Reader, LEN } from './protobuf';

export interface Alert {
  id: string;
  start: number | null;
  end: number | null;
  cause: number | null;
  effect: number | null;
  header: string;
  description: string;
  routes: string[];
  stops: string[];
}

/** Decodifica `alerts.pb`. */
export function decodeAlerts(buf: Uint8Array): Alert[] {
  const r = new Reader(buf);
  const out: Alert[] = [];
  while (r.more()) {
    const [f, w] = r.tag();
    if (f !== 2 || w !== LEN) { r.skip(w); continue; }
    const [s, e] = r.sub();
    const er = new Reader(buf, s, e);
    let id = '';
    while (er.more()) {
      const [g, x] = er.tag();
      if (g === 1) id = er.string();
      else if (g === 5 && x === LEN) {
        const [a, b] = er.sub();
        out.push(alert(buf, a, b, id));
      } else er.skip(x);
    }
  }
  return out;
}

function alert(buf: Uint8Array, s: number, e: number, id: string): Alert {
  const r = new Reader(buf, s, e);
  const al: Alert = { id, start: null, end: null, cause: null, effect: null, header: '', description: '', routes: [], stops: [] };
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1 && w === LEN) {
      const [a, b] = r.sub();
      const t = new Reader(buf, a, b);
      while (t.more()) {
        const [g, x] = t.tag();
        if (g === 1) al.start = t.varint(); else if (g === 2) al.end = t.varint(); else t.skip(x);
      }
    } else if (f === 5 && w === LEN) {
      const [a, b] = r.sub();
      const t = new Reader(buf, a, b);
      while (t.more()) {
        const [g, x] = t.tag();
        if (g === 2) al.routes.push(t.string()); else if (g === 5) al.stops.push(t.string()); else t.skip(x);
      }
    } else if (f === 6) al.cause = r.varint();
    else if (f === 7) al.effect = r.varint();
    else if ((f === 10 || f === 11) && w === LEN) {
      const [a, b] = r.sub();
      const text = translated(buf, a, b);
      if (f === 10) al.header = text; else al.description = text;
    } else r.skip(w);
  }
  return al;
}

function translated(buf: Uint8Array, s: number, e: number): string {
  const r = new Reader(buf, s, e);
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1 && w === LEN) {
      const [a, b] = r.sub();
      const t = new Reader(buf, a, b);
      while (t.more()) {
        const [g, x] = t.tag();
        if (g === 1) return t.string();
        t.skip(x);
      }
    } else r.skip(w);
  }
  return '';
}

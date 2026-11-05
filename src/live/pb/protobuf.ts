// Copia de transmi-live-worker/src/protobuf.ts (mantener las dos iguales).
/**
 * Lector mínimo de protobuf (formato de cable). Sin dependencias y sin reservar subarreglos: cada
 * mensaje se recorre con un cursor sobre el mismo `Uint8Array`. Suficiente para GTFS-Realtime.
 */
export const VARINT = 0, I64 = 1, LEN = 2, I32 = 5;

export class Reader {
  pos: number;
  readonly view: DataView;
  readonly buf: Uint8Array;
  readonly end: number;

  constructor(buf: Uint8Array, start = 0, end = buf.length) {
    this.buf = buf;
    this.end = end;
    this.pos = start;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  more(): boolean { return this.pos < this.end; }

  /** Varint como número (exacto hasta 2^53, de sobra para marcas de tiempo y enteros del feed). */
  varint(): number {
    const b = this.buf;
    let x = 0, mul = 1, byte: number;
    do {
      byte = b[this.pos++];
      x += (byte & 0x7f) * mul;
      mul *= 128;
    } while (byte & 0x80);
    return x;
  }

  tag(): [field: number, wire: number] {
    const t = this.varint();
    return [Math.floor(t / 8), t & 7];
  }

  /** Delimita un mensaje anidado: devuelve [inicio, fin] y avanza el cursor más allá. */
  sub(): [number, number] {
    const n = this.varint();
    const s = this.pos;
    this.pos += n;
    return [s, s + n];
  }

  float(): number { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  double(): number { const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }

  string(): string {
    const [s, e] = this.sub();
    return decodeUtf8(this.buf, s, e);
  }

  skip(wire: number) {
    if (wire === VARINT) this.varint();
    else if (wire === I64) this.pos += 8;
    else if (wire === LEN) { const n = this.varint(); this.pos += n; } // varint primero: avanza el cursor
    else if (wire === I32) this.pos += 4;
    else throw new Error(`tipo de cable no soportado: ${wire}`);
  }
}

const td = new TextDecoder();

/** UTF-8 con atajo para ASCII, que es casi todo lo que trae el feed (ids, placas, rutas). */
export function decodeUtf8(b: Uint8Array, s: number, e: number): string {
  if (e - s < 32) {
    let out = '';
    for (let i = s; i < e; i++) {
      const c = b[i];
      if (c > 127) return td.decode(b.subarray(s, e));
      out += String.fromCharCode(c);
    }
    return out;
  }
  return td.decode(b.subarray(s, e));
}

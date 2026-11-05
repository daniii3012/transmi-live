export interface Alert {
  id: string;
  start: number | null;
  end: number | null;
  effect: number | null;
  header: string;
  description: string;
  routes: string[];
  stops: string[];
}

let decoder: Worker | null = null;
/** Protobuf (Worker en modo `passthrough`) → alertas, en un Web Worker. */
function decodePb(buf: ArrayBuffer): Promise<Alert[]> {
  decoder ??= new Worker(new URL('./pb/alerts.worker.ts', import.meta.url), { type: 'module' });
  const w = decoder;
  return new Promise((resolve, reject) => {
    w.onmessage = (e: MessageEvent<{ ok: boolean; data?: Alert[]; message?: string }>) => (e.data.ok ? resolve(e.data.data!) : reject(new Error(e.data.message)));
    w.postMessage(buf, [buf]);
  });
}

let last: { base: string; etag: string; list: Alert[] } | null = null;

/** Alertas activas del Worker, cada 60 s con la pestaña visible. Con ETag: si no cambiaron, 304 sin cuerpo. */
export async function fetchAlerts(base: string): Promise<Alert[] | null> {
  try {
    const prev = last?.base === base ? last : null;
    const r = await fetch(`${base}/v1/alerts`, { cache: 'no-store', headers: prev ? { 'if-none-match': prev.etag } : {} });
    let list: Alert[];
    if (r.status === 304 && prev) list = prev.list;
    else if (!r.ok) return null;
    else {
      // El Worker decide el formato: JSON o, en modo `passthrough`, el protobuf tal cual.
      const pb = (r.headers.get('content-type') ?? '').includes('protobuf');
      list = pb ? await decodePb(await r.arrayBuffer()) : ((await r.json()) as Alert[]);
      const etag = r.headers.get('etag');
      last = etag ? { base, etag, list } : null;
    }
    const now = Date.now() / 1000;
    return list.filter((a) => (!a.start || a.start <= now) && (!a.end || a.end >= now));
  } catch {
    return null;
  }
}

/**
 * Texto legible de una alerta. El alimentador trae un código interno como título
 * («EMOBRASMETROCLL42SURAV1MAYO») y en la descripción el tramo afectado
 * («Novedad en la operacion en linea 191\424A08_Pquia. Santa Margarita\169A08_Colegio Giraldilla»).
 */
export function describe(a: Alert): { title: string; detail: string | null; code: string } {
  const parts = a.description.split('\\').map((s) => s.trim()).filter(Boolean);
  const places = parts.slice(1).map((p) => p.replace(/^[0-9A-Z]+_/, '').trim()).filter(Boolean);
  const title = a.effect === 4 ? 'Desvío en la operación' : a.effect === 1 ? 'Sin servicio' : a.effect === 3 ? 'Servicio reducido' : 'Novedad en la operación';
  const detail = places.length >= 2 ? `entre ${places[0]} y ${places[places.length - 1]}` : places[0] ? `en ${places[0]}` : null;
  return { title, detail, code: a.header.trim() };
}

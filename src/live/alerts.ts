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

/** Alertas activas del Worker, cada 60 s con la pestaña visible. */
export async function fetchAlerts(base: string): Promise<Alert[] | null> {
  try {
    const r = await fetch(`${base}/v1/alerts`, { cache: 'no-store' });
    if (!r.ok) return null;
    const list = (await r.json()) as Alert[];
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

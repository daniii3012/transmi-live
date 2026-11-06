/** Vistas con dirección propia: cada una se puede compartir y el botón atrás funciona. */
export type View =
  | { kind: 'home' }
  | { kind: 'route'; id: string }
  | { kind: 'bus'; id: string }
  | { kind: 'station'; id: string }
  | { kind: 'stop'; id: string }
  | { kind: 'plan'; id: string }
  | { kind: 'changes'; id: string }
  | { kind: 'settings'; id: string };

const SEG: Record<View['kind'], string> = { home: '', route: 'ruta', bus: 'bus', station: 'estacion', stop: 'paradero', plan: 'planear', changes: 'cambios', settings: 'configuracion' };
const BY_SEG = Object.fromEntries(Object.entries(SEG).map(([k, v]) => [v, k])) as Record<string, View['kind']>;

export function parse(hash = location.hash): View {
  if (hash === '#/planear') return { kind: 'plan', id: '' };
  if (hash === '#/cambios') return { kind: 'changes', id: '' };
  if (hash === '#/configuracion') return { kind: 'settings', id: '' };
  const m = /^#\/([a-z]+)\/(.+)$/.exec(hash);
  const kind = m && BY_SEG[m[1]];
  if (!m || !kind || kind === 'home') return { kind: 'home' };
  return { kind, id: decodeURIComponent(m[2]) } as View;
}

export function href(v: View): string {
  if (v.kind === 'plan' && !v.id) return '#/planear';
  if (v.kind === 'changes') return '#/cambios';
  if (v.kind === 'settings') return '#/configuracion';
  return v.kind === 'home' ? '#/' : `#/${SEG[v.kind]}/${encodeURIComponent(v.id)}`;
}

export function go(v: View, replace = false) {
  const h = href(v);
  if (location.hash === h) return;
  if (replace) history.replaceState(null, '', h);
  else location.hash = h;
  if (replace) dispatchEvent(new HashChangeEvent('hashchange'));
}

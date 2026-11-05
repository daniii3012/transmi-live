/** Tema de la interfaz y del mapa: según el sistema, oscuro o claro (revisión R1.16). */
export type ThemePref = 'system' | 'dark' | 'light';
export type Theme = 'dark' | 'light';
const KEY = 'transmi-live:tema:v1';
const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: light)') : null;

export function themePref(): ThemePref {
  try { return (localStorage.getItem(KEY) as ThemePref) || 'system'; } catch { return 'system'; }
}
export function effective(p: ThemePref = themePref()): Theme {
  return p === 'system' ? (mq?.matches ? 'light' : 'dark') : p;
}
export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#fbfbfc' : '#101418');
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', t);
}
export function saveThemePref(p: ThemePref) { try { localStorage.setItem(KEY, p); } catch { /* modo privado */ } }
export function onSystemChange(fn: () => void) { mq?.addEventListener('change', fn); }

import type { Route, SystemKey } from './types';

/**
 * Filtro de sistemas (R10.2). La lista «Sistemas» del inicio muestra cuatro grupos en este orden:
 * Troncal (con Dual: van por la troncal), Zonal (con sus tres clases del GTFS: Urbano, Complementario
 * y Especial), Alimentador y TransMiCable. Cada grupo se muestra u oculta entero o, desplegado, por
 * clase. Lo que se guarda son las clases ocultas.
 */
export type FilterKey = 'troncal' | 'dual' | 'alimentador' | 'cable' | 'zonal-urbano' | 'zonal-complementario' | 'zonal-especial';
export type GroupKey = 'troncal' | 'zonal' | 'alimentador' | 'cable';

export interface FilterClass { key: FilterKey; name: string; sys: SystemKey }
export interface FilterGroup { key: GroupKey; sys: SystemKey; classes: FilterClass[] }

export const FILTER_GROUPS: FilterGroup[] = [
  { key: 'troncal', sys: 'troncal', classes: [{ key: 'troncal', name: 'Troncal', sys: 'troncal' }, { key: 'dual', name: 'Dual', sys: 'dual' }] },
  {
    key: 'zonal', sys: 'zonal', classes: [
      { key: 'zonal-urbano', name: 'Urbano', sys: 'zonal' },
      { key: 'zonal-complementario', name: 'Complementario', sys: 'zonal' },
      { key: 'zonal-especial', name: 'Especial', sys: 'zonal' },
    ],
  },
  { key: 'alimentador', sys: 'alimentador', classes: [{ key: 'alimentador', name: 'Alimentador', sys: 'alimentador' }] },
  { key: 'cable', sys: 'cable', classes: [{ key: 'cable', name: 'TransMiCable', sys: 'cable' }] },
];
export const FILTER_KEYS: FilterKey[] = FILTER_GROUPS.flatMap((g) => g.classes.map((c) => c.key));

// Textos fijos (sin armar uno por bus en cada cuadro).
const ZONAL: Record<string, FilterKey> = { urbano: 'zonal-urbano', complementario: 'zonal-complementario', especial: 'zonal-especial' };

/** Clase de una ruta o de un bus (por su sistema y, en el zonal, su clase del GTFS; sin clase, urbano). */
export function classOf(sys: SystemKey | undefined, sub?: Route['sub']): FilterKey | undefined {
  if (!sys) return undefined;
  return sys === 'zonal' ? ZONAL[sub ?? 'urbano'] ?? 'zonal-urbano' : sys;
}

/** Lo guardado antes de R10.2 tenía `zonal` entero: pasa a sus tres clases. Fuera lo desconocido. */
export function migrateHidden(list: readonly string[] | undefined): FilterKey[] {
  const out = new Set<FilterKey>();
  for (const k of list ?? []) {
    if (k === 'zonal') for (const z of Object.values(ZONAL)) out.add(z);
    else if ((FILTER_KEYS as string[]).includes(k)) out.add(k as FilterKey);
  }
  // Todo oculto no tiene sentido (el mapa quedaría vacío): se muestra todo.
  return out.size >= FILTER_KEYS.length ? [] : FILTER_KEYS.filter((k) => out.has(k));
}

/** Estado de un grupo: todo visible, todo oculto o en parte. */
export function groupState(hidden: readonly FilterKey[], g: FilterGroup): 'on' | 'off' | 'part' {
  const n = g.classes.filter((c) => hidden.includes(c.key)).length;
  return n === 0 ? 'on' : n === g.classes.length ? 'off' : 'part';
}

const ordered = (s: Set<FilterKey>) => FILTER_KEYS.filter((k) => s.has(k));

/** Muestra u oculta unas clases (un grupo entero o una clase). Si con eso no quedaría nada visible,
 * no cambia nada (devuelve `null`). Un grupo en parte visible se oculta entero. */
export function toggle(hidden: readonly FilterKey[], keys: readonly FilterKey[]): FilterKey[] | null {
  const h = new Set(hidden);
  const anyOn = keys.some((k) => !h.has(k));
  for (const k of keys) { if (anyOn) h.add(k); else h.delete(k); }
  if (h.size >= FILTER_KEYS.length) return null;
  return ordered(h);
}

/** «Solo esto» (doble clic): deja visibles solo esas clases; si ya era así, vuelve a mostrar todo. */
export function solo(hidden: readonly FilterKey[], keys: readonly FilterKey[]): FilterKey[] {
  const rest = FILTER_KEYS.filter((k) => !keys.includes(k));
  const already = rest.every((k) => hidden.includes(k)) && keys.every((k) => !hidden.includes(k));
  return already ? [] : rest;
}

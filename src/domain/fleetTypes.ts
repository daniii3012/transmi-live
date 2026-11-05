import fleet from '../../data/curated/fleet.json';

/**
 * Tipo de bus (data/curated/fleet.json). Por la etiqueta de flota («N0172» → serie N, número 172); si
 * el número no cae en ningún rango conocido y la ruta es troncal, por el tipo observado en esa ruta.
 * Hay códigos compartidos entre sistemas (C15, C25, 7 existen en troncal y en zonal): el respaldo se
 * aplica solo a la ruta troncal, y la serie Z (flota zonal) nunca toma un tipo troncal.
 */
export type BusKind = 'articulated' | 'biarticulated' | 'dual' | 'dual-articulated';
const RANGES = fleet.ranges as unknown as Record<string, Partial<Record<BusKind, [number, number][]>>>;
const ROUTES = (fleet as unknown as { routes?: Record<string, BusKind> }).routes ?? {};
const TYPES = fleet.types as unknown as Record<BusKind, { name: string; length: number }>;
export const KIND_NAME: Record<BusKind, string> = {
  articulated: TYPES.articulated?.name ?? 'Articulado',
  biarticulated: TYPES.biarticulated?.name ?? 'Biarticulado',
  dual: TYPES.dual?.name ?? 'Padrón dual',
  'dual-articulated': TYPES['dual-articulated']?.name ?? 'Articulado dual eléctrico',
};
/** Largo en metros de cada tipo. */
export const KIND_LENGTH: Record<BusKind, number> = { articulated: 18, biarticulated: 27, dual: 12, 'dual-articulated': 18 };

export function busKind(label: string, routeCode?: string, sys?: string): BusKind | null {
  const m = /^([A-Z]+)0*(\d+)$/.exec(label.trim());
  if (m?.[1].startsWith('Z')) return null;
  if (m) {
    const series = RANGES[m[1]];
    // El alimentador escribe un cero que el bus no lleva pintado: «K10657» es el K1657 de la calle.
    const digits = m[2].length === 5 && m[2].startsWith('10') ? m[2][0] + m[2].slice(2) : m[2];
    const n = Number(digits);
    if (series) {
      for (const [kind, ranges] of Object.entries(series) as [BusKind, [number, number][]][]) {
        if (ranges.some(([a, b]) => n >= a && n <= b)) return kind;
      }
    }
  }
  return routeCode && sys === 'troncal' ? ROUTES[routeCode] ?? null : null;
}

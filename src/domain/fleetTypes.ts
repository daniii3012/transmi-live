import fleet from '../../data/curated/fleet.json';

export type BusKind = 'articulated' | 'biarticulated' | 'dual';
const RANGES = fleet.ranges as unknown as Record<string, Partial<Record<BusKind, [number, number][]>>>;
export const KIND_NAME: Record<BusKind, string> = { articulated: 'Articulado', biarticulated: 'Biarticulado', dual: 'Dual' };

/** Tipo de bus por su etiqueta de flota («N0172» → serie N, número 172). Sin dato: null. */
export function busKind(label: string): BusKind | null {
  const m = /^([A-Z]+)0*(\d+)$/.exec(label.trim());
  if (!m) return null;
  const series = RANGES[m[1]];
  if (!series) return null;
  const n = Number(m[2]);
  for (const [kind, ranges] of Object.entries(series) as [BusKind, [number, number][]][]) {
    if (ranges.some(([a, b]) => n >= a && n <= b)) return kind;
  }
  return null;
}

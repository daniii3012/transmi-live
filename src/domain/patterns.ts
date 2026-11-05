import type { Pattern } from './types';

/**
 * `patterns.json` v2 guarda abscisas y tiempos por diferencias (crecen de parada en parada): 36 % menos
 * con gzip. Aquí se reconstruyen los acumulados, en el mismo objeto. Acepta también v1 (acumulados).
 */
export function undeltaPatterns(f: { v?: number; patterns: Record<string, Pattern> }): Record<string, Pattern> {
  if (f.v !== 2) return f.patterns;
  const sum = (a: number[]) => { for (let i = 1; i < a.length; i++) a[i] += a[i - 1]; };
  for (const p of Object.values(f.patterns)) {
    sum(p.s);
    for (const t of p.t) if (t) sum(t);
  }
  f.v = 1;
  return f.patterns;
}

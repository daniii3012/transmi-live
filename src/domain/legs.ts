import type { Route, RouteLeg } from './types';

/**
 * El código que va en el bus (revisión R9). El catálogo une los dos sentidos de muchas rutas bajo un
 * código que no se ve en la calle: «CA153» es el A153 hasta Centro y el C153 de vuelta; «HH710» es el
 * H710. `codes` trae los códigos del bus y `legs`, dónde cambia uno por otro a lo largo del recorrido
 * (del letrero de cada parada en el GTFS). Sin `legs` se conocen los códigos, no el punto de cambio.
 */

/** Códigos del bus, en orden («A153/C153»); el del catálogo si no hay otros. */
export function busCodes(r: Route): string[] {
  return r.codes?.length ? r.codes : [r.code];
}

/** Para mostrar sin contexto: «A153/C153», «H710», «B10». */
export function busCode(r: Route): string {
  return busCodes(r).join('/');
}

/** Tramo al que pertenece la parada `index` del patrón. */
export function legAtStop(r: Route, index: number): RouteLeg | null {
  if (!r.legs?.length) return null;
  let leg = r.legs[0];
  for (const l of r.legs) if (l.i <= index) leg = l;
  return leg;
}

/** Tramo de un bus en la abscisa `s`: el nuevo desde que pasa la última parada del anterior. */
export function legAtS(r: Route, s: number): RouteLeg | null {
  if (!r.legs?.length) return null;
  let leg = r.legs[0];
  for (const l of r.legs) if (l === r.legs[0] || s > l.b + 8) leg = l;
  return leg;
}

/** Destino del código `c` del bus: el de su tramo o, en un circuito de dos partes, el de la suya. */
export function destOfCode(r: Route, c: string): string {
  const leg = r.legs?.find((l) => l.c === c);
  if (leg) return leg.d;
  const codes = busCodes(r);
  if (r.loop && codes.length === 2 && r.origin) return c === codes[1] ? r.origin : r.dest;
  return r.dest;
}

/** Códigos que identifican la ruta, el del catálogo incluido, en mayúsculas (búsqueda y respaldo). */
export function allCodes(r: Route): string[] {
  return [...new Set([r.code, ...busCodes(r)].map((c) => c.toUpperCase()))];
}

import type { Network } from '../data/network';
import type { Place } from './client';

/** Un extremo del viaje: estación, paradero, ubicación propia o un punto del mapa. */
export type End =
  | { kind: 'station'; id: string }
  | { kind: 'stop'; id: string }
  | { kind: 'here' }
  | { kind: 'point'; lon: number; lat: number };

/** Codificación en la URL: `s123`, `p456`, `u`, `@-74.1,4.6`. */
export function encodeEnd(e: End | null): string {
  if (!e) return '';
  if (e.kind === 'station') return `s${e.id}`;
  if (e.kind === 'stop') return `p${e.id}`;
  if (e.kind === 'here') return 'u';
  return `@${e.lon.toFixed(5)},${e.lat.toFixed(5)}`;
}

export function decodeEnd(s: string): End | null {
  if (!s) return null;
  if (s === 'u') return { kind: 'here' };
  if (s[0] === 's') return { kind: 'station', id: s.slice(1) };
  if (s[0] === 'p') return { kind: 'stop', id: s.slice(1) };
  const m = /^@(-?[\d.]+),(-?[\d.]+)$/.exec(s);
  return m ? { kind: 'point', lon: +m[1], lat: +m[2] } : null;
}

export type Day = 'habil' | 'sabado' | 'festivo';

/** Plan en la URL: `de~a~HHMM~día` (hora vacía = ahora; día vacío = hoy). */
export function encodePlan(from: End | null, to: End | null, time: string | null, day: Day | null = null): string {
  return [encodeEnd(from), encodeEnd(to), time?.replace(':', '') ?? '', day ?? ''].join('~').replace(/~+$/, '');
}
export function decodePlan(id: string): { from: End | null; to: End | null; time: string | null; day: Day | null } {
  const [a = '', b = '', t = '', d = ''] = id.split('~');
  return {
    from: decodeEnd(a), to: decodeEnd(b),
    time: /^\d{4}$/.test(t) ? `${t.slice(0, 2)}:${t.slice(2)}` : null,
    day: d === 'habil' || d === 'sabado' || d === 'festivo' ? d : null,
  };
}

export function endName(net: Network, e: End | null): string {
  if (!e) return '';
  if (e.kind === 'here') return 'Mi ubicación';
  if (e.kind === 'point') return 'Punto en el mapa';
  if (e.kind === 'station') return net.stations.get(e.id)?.short ?? 'Estación';
  return net.streetStops.get(e.id)?.name ?? 'Paradero';
}

/** Para el planificador: ids y coordenadas. `here` necesita la ubicación ya resuelta. */
export function toPlace(net: Network, e: End, here: [number, number] | null): Place | null {
  if (e.kind === 'here') return here ? { kind: 'point', lon: here[0], lat: here[1] } : null;
  if (e.kind === 'point') return { kind: 'point', lon: e.lon, lat: e.lat };
  if (e.kind === 'station') {
    const s = net.stations.get(e.id);
    return s ? { kind: 'stop', ids: [s.id, ...s.platforms.map((p) => p.id)], lon: s.lon, lat: s.lat } : null;
  }
  const s = net.streetStops.get(e.id);
  return s ? { kind: 'stop', ids: [s.id], lon: s.lon, lat: s.lat } : null;
}

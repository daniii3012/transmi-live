export type SystemKey = 'troncal' | 'dual' | 'alimentador' | 'zonal' | 'cable';

export interface SystemInfo { key: SystemKey; name: string; color: string }

export interface Route {
  id: string;
  code: string;
  name: string;
  dest: string;
  origin: string | null;
  loop?: boolean;
  sys: SystemKey;
  sub?: 'urbano' | 'complementario' | 'especial';
  zone?: string;
  color: string;
  len: number;
  stops: number;
  pair?: string[];
  /** Códigos que lleva el bus si no son el del catálogo («A153», «C153» en la CA153); ver legs.ts. */
  codes?: string[];
  /** Dónde cambia el código a lo largo del recorrido (solo si cambia). */
  legs?: RouteLeg[];
}

/** Tramo de una ruta con su código: `i` índice de su primera parada en el patrón, `s` su abscisa,
 * `b` la de la parada anterior (m). */
export interface RouteLeg { c: string; d: string; i: number; s: number; b: number }

export interface Platform { id: string; name: string; code: string; lon: number; lat: number; routes: string[] }

export interface Station {
  id: string;
  name: string;
  short: string;
  kind: 'station' | 'portal' | 'cable';
  lon: number;
  lat: number;
  routes: string[];
  closed?: boolean;
  /** Provisional: en un tramo en obra (data/curated/obras.json); no se modela, solo la marca. */
  prov?: string;
  /** Huella (anillos lon, lat): de OSM o estimada entre los carriles (F7.7). */
  fp?: [number, number][][];
  fpk?: 'platform' | 'island' | 'building' | 'est' | 'roof' | 'traced';
  /** Cubiertas de OSM (building=roof), si las hay; si no, se dibujan sobre los andenes. */
  roof?: [number, number][][];
  platforms: Platform[];
}

export interface StreetStop { id: string; code: string; name: string; lon: number; lat: number; routes: string[] }

export interface Pattern {
  stops: string[];
  s: number[];
  t: (number[] | null)[];
  trips: number;
}

export interface DayService { h: number[]; first: number | null; last: number | null }
export type RouteService = Partial<Record<'habil' | 'sabado' | 'festivo', DayService>>;

export const SYSTEM_ORDER: SystemKey[] = ['troncal', 'dual', 'alimentador', 'zonal', 'cable'];

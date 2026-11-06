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
}

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
  fpk?: 'platform' | 'island' | 'building' | 'est';
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

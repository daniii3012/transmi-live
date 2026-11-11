import type { Map as MLMap, SkySpecification } from 'maplibre-gl';
import type { Theme } from '../app/theme';

/**
 * Luz según la hora (R10.10, opcional y apagada por defecto): en la vista 3D, el cielo, la luz de los
 * edificios del mapa base y el tono de las estructuras de la troncal siguen la hora de Bogotá. Cerca del
 * ecuador el sol sale hacia las 5:40 y se pone hacia las 17:50 casi todo el año, por el oriente y el
 * occidente, y al mediodía va casi encima: no hace falta calcular su posición exacta.
 *
 * El tema (claro u oscuro) se respeta: en el oscuro el día es un azul apagado, no un cielo brillante.
 */

type RGB = [number, number, number];
interface Phase { at: number; sky: RGB; horizon: RGB; light: RGB; intensity: number; tint: RGB }

const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const css = (c: RGB) => `rgb(${c.map((v) => Math.round(v)).join(',')})`;
const lerp = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

// Horas en minutos del día. La noche, el alba, el día, el atardecer y otra vez la noche.
// Luces neutras: un tono azul o morado en la luz tiñe los edificios (se probó: quedaban morados).
const PHASES: Record<Theme, Phase[]> = {
  dark: [
    { at: 0, sky: hex('#04060b'), horizon: hex('#10172a'), light: hex('#d9dde6'), intensity: 0.16, tint: [0.66, 0.68, 0.74] },
    { at: 5 * 60 + 10, sky: hex('#0a0f1c'), horizon: hex('#1f2740'), light: hex('#d9dde6'), intensity: 0.2, tint: [0.7, 0.72, 0.78] },
    { at: 5 * 60 + 50, sky: hex('#1d2238'), horizon: hex('#a65a3c'), light: hex('#ffd9b8'), intensity: 0.42, tint: [0.96, 0.88, 0.8] },
    { at: 7 * 60, sky: hex('#24324a'), horizon: hex('#46607e'), light: hex('#ffffff'), intensity: 0.62, tint: [1.08, 1.08, 1.08] },
    { at: 16 * 60 + 50, sky: hex('#24324a'), horizon: hex('#46607e'), light: hex('#ffffff'), intensity: 0.62, tint: [1.08, 1.08, 1.08] },
    { at: 17 * 60 + 55, sky: hex('#2a2238'), horizon: hex('#b4603a'), light: hex('#ffd2ad'), intensity: 0.42, tint: [0.98, 0.86, 0.76] },
    { at: 18 * 60 + 40, sky: hex('#0a0f1c'), horizon: hex('#1f2740'), light: hex('#d9dde6'), intensity: 0.2, tint: [0.7, 0.72, 0.78] },
    { at: 24 * 60, sky: hex('#04060b'), horizon: hex('#10172a'), light: hex('#d9dde6'), intensity: 0.16, tint: [0.66, 0.68, 0.74] },
  ],
  light: [
    { at: 0, sky: hex('#1b2333'), horizon: hex('#3a465c'), light: hex('#e2e6ee'), intensity: 0.16, tint: [0.78, 0.8, 0.86] },
    { at: 5 * 60 + 10, sky: hex('#2c3650'), horizon: hex('#55607a'), light: hex('#e2e6ee'), intensity: 0.18, tint: [0.8, 0.82, 0.88] },
    { at: 5 * 60 + 50, sky: hex('#6f6c8c'), horizon: hex('#f0a46a'), light: hex('#ffdcbf'), intensity: 0.26, tint: [1, 0.92, 0.84] },
    { at: 7 * 60, sky: hex('#a9c6e6'), horizon: hex('#e8f0f8'), light: hex('#ffffff'), intensity: 0.32, tint: [1, 1, 1] },
    { at: 16 * 60 + 50, sky: hex('#a9c6e6'), horizon: hex('#e8f0f8'), light: hex('#ffffff'), intensity: 0.32, tint: [1, 1, 1] },
    { at: 17 * 60 + 55, sky: hex('#76678c'), horizon: hex('#f29a62'), light: hex('#ffd6b4'), intensity: 0.26, tint: [1, 0.9, 0.8] },
    { at: 18 * 60 + 40, sky: hex('#2c3650'), horizon: hex('#55607a'), light: hex('#e2e6ee'), intensity: 0.18, tint: [0.8, 0.82, 0.88] },
    { at: 24 * 60, sky: hex('#1b2333'), horizon: hex('#3a465c'), light: hex('#e2e6ee'), intensity: 0.16, tint: [0.78, 0.8, 0.86] },
  ],
};

/** Minutos del día en Bogotá (UTC−5). */
export function bogotaMinutes(now = Date.now()): number {
  return (((Math.floor(now / 60_000) - 5 * 60) % 1440) + 1440) % 1440;
}

export interface Daylight { sky: string; horizon: string; light: string; intensity: number; tint: RGB; azimuth: number; polar: number }

/** Cielo, luz y tinte para una hora (interpolados entre las fases). */
export function daylightAt(minutes: number, theme: Theme): Daylight {
  const ph = PHASES[theme];
  let i = 1;
  while (i < ph.length - 1 && ph[i].at <= minutes) i++;
  const a = ph[i - 1], b = ph[i];
  const k = b.at > a.at ? Math.min(1, Math.max(0, (minutes - a.at) / (b.at - a.at))) : 0;
  // El sol: del oriente (90°) al occidente (270°) entre las 6 y las 18, alto al mediodía. De noche, la
  // luz viene de arriba (la ciudad), tenue.
  const day = Math.min(1, Math.max(0, (minutes - 6 * 60) / (12 * 60)));
  const up = minutes >= 5 * 60 + 40 && minutes <= 17 * 60 + 50;
  const azimuth = up ? 90 + 180 * day : 200;
  const polar = up ? 20 + 60 * Math.abs(day - 0.5) * 2 : 30;
  return { sky: css(lerp(a.sky, b.sky, k)), horizon: css(lerp(a.horizon, b.horizon, k)), light: css(lerp(a.light, b.light, k)), intensity: a.intensity + (b.intensity - a.intensity) * k, tint: lerp(a.tint, b.tint, k), azimuth, polar };
}

/** Aplica la luz de la hora (o la de siempre si `on` es falso). `restore` vuelve a la luz del tema. */
export function applyDaylight(map: MLMap, theme: Theme, on: boolean, setTint: (t: RGB) => void, restore: () => void, now = Date.now()) {
  if (!on) {
    map.setSky(undefined as unknown as SkySpecification);
    setTint([1, 1, 1]);
    restore();
    return;
  }
  const d = daylightAt(bogotaMinutes(now), theme);
  map.setSky({ 'sky-color': d.sky, 'horizon-color': d.horizon, 'fog-color': d.horizon, 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.8, 'fog-ground-blend': 1, 'atmosphere-blend': 0 });
  map.setLight({ anchor: 'map', color: d.light, position: [1.15, d.azimuth, d.polar], intensity: d.intensity });
  setTint(d.tint);
}

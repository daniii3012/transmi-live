/** Hora de Bogotá (UTC−5, sin horario de verano) y formatos de la interfaz (es-CO). */
const TZ = 'America/Bogota';
const hms = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const hm = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const num = new Intl.NumberFormat('es-CO');

export const fmtHMS = (ms: number) => hms.format(ms);
export const fmtHM = (ms: number) => hm.format(ms);
export const fmtNum = (n: number) => num.format(n);

/** Segundos desde la medianoche de Bogotá. */
export function bogotaSeconds(ms = Date.now()): number {
  const s = Math.floor(ms / 1000) - 5 * 3600;
  return ((s % 86400) + 86400) % 86400;
}

/** «HH:MM» para segundos desde medianoche (admite > 24 h del horario GTFS). */
export function clock(sec: number): string {
  const h = Math.floor(sec / 3600) % 24, m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Día de Bogotá (días desde 1970, UTC−5 fijo). */
const bogotaDay = (ms: number) => Math.floor((ms - 5 * 3600 * 1000) / 86_400_000);

/** ¿`ms` cae en otro día de Bogotá que `now`? (más de 24 h atrás siempre lo es). */
export const otherDay = (ms: number, now = Date.now()) => bogotaDay(ms) !== bogotaDay(now);

const dm = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
/** Fecha corta: «5 nov»; de otro año, «5 nov 2025». */
export function fmtDay(ms: number, now = Date.now()): string {
  const p = Object.fromEntries(dm.formatToParts(ms).map((x) => [x.type, x.value]));
  const d = `${p.day} ${p.month.replace('.', '')}`;
  return p.year === dm.formatToParts(now).find((x) => x.type === 'year')?.value ? d : `${d} ${p.year}`;
}

/** Antigüedad legible: «ahora», «12 s», «3 min», «1 h», «2 días». */
export function ago(sec: number): string {
  if (sec < 5) return 'ahora';
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86400) return `${Math.min(23, Math.round(sec / 3600))} h`;
  const d = Math.floor(sec / 86400);
  return d === 1 ? '1 día' : `${d} días`;
}

/** Distancia legible: «350 m», «2,4 km». */
export function meters(m: number): string {
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toLocaleString('es-CO', { maximumFractionDigits: 1 })} km`;
}

export type DayKind = 'habil' | 'sabado' | 'festivo';

/** Días que no siguen su día de la semana (festivos), del `calendar_dates.txt` del GTFS: «2026-11-16»
 * → «festivo». Los pone la red al cargar (`meta.days`). */
let dayExceptions: Record<string, DayKind> = {};
export function setDayExceptions(days: Record<string, DayKind> | undefined) { dayExceptions = days ?? {}; }

/** Fecha de Bogotá «AAAA-MM-DD». */
export function bogotaDate(ms = Date.now()): string {
  return new Date(ms - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Tipo de día para el horario: hábil, sábado o festivo (domingo y los festivos del calendario).
 * La madrugada (antes de las 4) pertenece al día de servicio anterior. */
export function dayType(ms = Date.now()): DayKind {
  const local = ms - 5 * 3600 * 1000;
  const service = new Date(local).getUTCHours() < 4 ? local - 86_400_000 : local;
  const date = new Date(service).toISOString().slice(0, 10);
  const ex = dayExceptions[date];
  if (ex) return ex;
  const d = new Date(service).getUTCDay();
  return d === 0 ? 'festivo' : d === 6 ? 'sabado' : 'habil';
}

/** Contraste: texto blanco o casi negro sobre un color (luminancia relativa WCAG). */
export function textOn(hex: string): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return L > 0.36 ? '#07090b' : '#ffffff';
}

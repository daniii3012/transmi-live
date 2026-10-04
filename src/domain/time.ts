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

/** Antigüedad legible: «ahora», «12 s», «3 min», «1 h». */
export function ago(sec: number): string {
  if (sec < 5) return 'ahora';
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}

/** Distancia legible: «350 m», «2,4 km». */
export function meters(m: number): string {
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toLocaleString('es-CO', { maximumFractionDigits: 1 })} km`;
}

/** Tipo de día para el horario: hábil, sábado o festivo (domingo). Los festivos de calendario
 * no se distinguen aquí: el horario de domingo es la mejor aproximación sin calendar_dates. */
export function dayType(ms = Date.now()): 'habil' | 'sabado' | 'festivo' {
  const d = new Date(ms - 5 * 3600 * 1000).getUTCDay();
  return d === 0 ? 'festivo' : d === 6 ? 'sabado' : 'habil';
}

/** Contraste: texto blanco o casi negro sobre un color (luminancia relativa WCAG). */
export function textOn(hex: string): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return L > 0.36 ? '#07090b' : '#ffffff';
}

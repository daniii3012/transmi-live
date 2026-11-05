#!/usr/bin/env node
// Validación del estimador de llegadas contra lecturas reales (hito 4, F4.8).
//
//   node tools/validate_eta.mjs rt_detalle_AAAAMMDD.csv.gz [--every 6]
//
// Para cada bus: ubica sus lecturas sobre el recorrido, deduce a qué hora pasó por cada parada
// (interpolando entre lecturas) y compara con lo que el estimador habría dicho minutos antes.
// Usa el mismo código de la página (src/domain), con los datos compilados en public/data.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { MetricPath, decodeShape, KX, KY } from '../src/domain/geo.ts';
import { undeltaPatterns } from '../src/domain/patterns.ts';
import { etas, bandIndex, bandTimes, pace, setPaceSpan, setSchedScale, setSchedFar } from '../src/domain/eta.ts';
if (process.env.SCHED_SCALE) setSchedScale(Number(process.env.SCHED_SCALE));
if (process.env.PACE_SPAN) setPaceSpan(Number(process.env.PACE_SPAN));
if (process.env.SCHED_T1) setSchedFar(Number(process.env.SCHED_T1), Number(process.env.SCHED_FAR ?? 1));

const [src, ...rest] = process.argv.slice(2);
const every = Number(rest[rest.indexOf('--every') + 1] || 6);
const data = (f) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url)));
const net = data('network.json');
const shapes = data('shapes-core.json');
const patterns = undeltaPatterns(data('patterns.json'));
const routes = new Map(net.routes.map((r) => [r.id, r]));
const paths = new Map(Object.entries(shapes.shapes).map(([id, enc]) => [id, new MetricPath(decodeShape(enc, shapes.scale))]));

// Lecturas por bus, en orden.
const lines = gunzipSync(readFileSync(src)).toString('utf8').split('\n');
const head = lines[0].split(',');
const ix = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
const tracks = new Map();
for (let i = 1; i < lines.length; i++) {
  const c = lines[i].split(',');
  if (c.length < head.length) continue;
  const rid = c[ix.ruta];
  if (!paths.has(rid) || !patterns[rid]) continue;
  const key = `${c[ix.bus]}|${rid}`;
  let t = tracks.get(key);
  if (!t) tracks.set(key, (t = []));
  t.push({ at: Number(c[ix.build]) * 1000, lon: +c[ix.lon], lat: +c[ix.lat] });
}

const bogotaSec = (ms) => (((Math.floor(ms / 1000) - 5 * 3600) % 86400) + 86400) % 86400;
const H = [[0, 5], [5, 10], [10, 20], [20, 30]];
const err = { pace: H.map(() => []), plain: H.map(() => []) };
let nPred = 0, nBus = 0;

for (const [key, pts] of tracks) {
  const rid = key.split('|')[1];
  const path = paths.get(rid), p = patterns[rid];
  pts.sort((a, b) => a.at - b.at);
  // Ubicar sobre el recorrido, sin retroceder (mismas reglas que la flota: 60 m, 30 m).
  const fixes = [];
  let hint;
  for (const q of pts) {
    const hit = path.nearest(q.lon * KX, q.lat * KY, hint, 250, 3500, 60);
    if (!hit || hit.d > 60) continue;
    let s = hit.s;
    const last = fixes.at(-1);
    if (last && s < last.s) { if (last.s - s <= 30) s = last.s; else { fixes.length = 0; } }
    if (last && q.at - last.at > 10 * 60_000) fixes.length = 0; // otro viaje
    fixes.push({ at: q.at, s });
    hint = s;
  }
  if (fixes.length < 10) continue;
  nBus++;
  // Hora observada de paso por cada parada: primera lectura con s ≥ s_k, interpolada.
  const passed = new Map();
  for (let k = 0; k < p.s.length; k++) {
    for (let j = 1; j < fixes.length; j++) {
      if (fixes[j].s >= p.s[k] && fixes[j - 1].s < p.s[k]) {
        const a = fixes[j - 1], b = fixes[j];
        if (b.at - a.at > 5 * 60_000) break;
        passed.set(k, a.at + ((p.s[k] - a.s) / (b.s - a.s)) * (b.at - a.at));
        break;
      }
    }
  }
  for (let j = 10; j < fixes.length; j += every) {
    const f = fixes[j];
    const band = bandIndex(bogotaSec(f.at));
    const t = bandTimes(p, band);
    if (!t) continue;
    const hist = fixes.slice(0, j + 1).filter((x) => f.at - x.at <= 8 * 60_000);
    const k = pace(p, t, hist);
    for (const [kind, kk] of [['pace', k], ['plain', 1]]) {
      for (const e of etas(p, band, f.s, 0, kk, 60)) {
        const obs = passed.get(e.index);
        if (obs === undefined || obs < f.at) continue;
        const real = (obs - f.at) / 1000;
        const h = H.findIndex(([a, b]) => real / 60 >= a && real / 60 < b);
        if (h < 0) continue;
        err[kind][h].push(e.seconds - real);
        if (kind === 'pace') nPred++;
      }
    }
  }
}

const q = (a, x) => { const s = [...a].sort((m, n) => m - n); return s[Math.min(s.length - 1, Math.floor(x * s.length))]; };
console.log(`${nBus} viajes troncales, ${nPred} predicciones (cada ${every} lecturas)\n`);
console.log('horizonte   n        |error| p50   p90    sesgo p50   (sin ritmo: |error| p50  p90)');
H.forEach(([a, b], i) => {
  const e = err.pace[i], e0 = err.plain[i];
  if (!e.length) return;
  const abs = e.map(Math.abs), abs0 = e0.map(Math.abs);
  console.log(`${String(a).padStart(2)}–${String(b).padEnd(2)} min  ${String(e.length).padEnd(8)} ${(q(abs, 0.5) / 60).toFixed(1).padStart(6)}  ${(q(abs, 0.9) / 60).toFixed(1).padStart(5)}  ${(q(e, 0.5) / 60).toFixed(1).padStart(9)}      ${(q(abs0, 0.5) / 60).toFixed(1).padStart(16)} ${(q(abs0, 0.9) / 60).toFixed(1).padStart(5)}`);
});

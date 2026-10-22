#!/usr/bin/env python3
"""Compila los datos estáticos de la página a partir de un paquete GTFS.

    python3 tools/build_data.py RUTA/AL/GTFS.zip [--out public/data]

Solo biblioteca estándar: corre igual en local y en CI. Lee el paquete sin descomprimirlo y escribe
archivos compactos, que no se versionan (son un producto de compilación):

    meta.json      huella del paquete, fecha, conteos
    network.json   sistemas, rutas, estaciones con vagones
    shapes-*.json  recorridos simplificados (1,5 m), en enteros de 1e-6 grados por diferencias;
                   «core» troncal, dual y cable; «zonal» alimentador y zonal
    stops.json     paraderos (fuera de estaciones) con las rutas que paran
    patterns.json  por ruta: paradas en orden, abscisa de cada una y tiempos por franja
    service.json   por ruta: salidas por hora y tipo de día, primera y última

Medidas en metros con una proyección local equirectangular centrada en Bogotá; el cliente usa la
misma (src/domain/geo.ts), así que abscisas y longitudes coinciden.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import re
import sys
import time
import zipfile
from array import array
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LAT0 = 4.65
KX = 111_320.0 * math.cos(math.radians(LAT0))
KY = 110_574.0
SIMPLIFY_M = 1.5
E6 = 1_000_000

SYSTEM_BY_AGENCY = {
    '1': ('troncal', None), '6': ('dual', None), '2': ('alimentador', None),
    '3': ('zonal', 'urbano'), '4': ('zonal', 'complementario'), '5': ('zonal', 'especial'),
    '7': ('cable', None),
}
# Franjas para los tiempos de recorrido (hora de salida del viaje).
BANDS = [(0, 6, 'madrugada'), (6, 9, 'pico_am'), (9, 16, 'valle'), (16, 20, 'pico_pm'), (20, 30, 'noche')]
# service_id → tipo de día (calendar.txt del paquete: 1 L–V, 2 sábado, 4 domingo y festivo).
DAY_TYPE = {'1': 'habil', '2': 'sabado', '4': 'festivo'}


def log(*a):
    print('·', *a, file=sys.stderr, flush=True)


def rows(z: zipfile.ZipFile, name: str):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, 'utf-8-sig'))


def xy(lon: float, lat: float) -> tuple[float, float]:
    return lon * KX, lat * KY


def secs(t: str) -> int:
    h, m, s = t.split(':')
    return int(h) * 3600 + int(m) * 60 + int(s)


def clean(s: str) -> str:
    return re.sub(r'\s+', ' ', s or '').strip()


def simplify(pts: list[tuple[float, float]], tol: float) -> list[int]:
    """Douglas–Peucker iterativo; devuelve los índices que se conservan."""
    n = len(pts)
    if n < 3:
        return list(range(n))
    keep = bytearray(n)
    keep[0] = keep[-1] = 1
    stack = [(0, n - 1)]
    tol2 = tol * tol
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if l2 == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                f = ((px - ax) * dx + (py - ay) * dy) / l2
                f = 0 if f < 0 else 1 if f > 1 else f
                qx, qy = ax + f * dx, ay + f * dy
                d2 = (px - qx) ** 2 + (py - qy) ** 2
            if d2 > best:
                best, bi = d2, i
        if best > tol2:
            keep[bi] = 1
            stack.append((a, bi))
            stack.append((bi, b))
    return [i for i in range(n) if keep[i]]


def cumulative(pts):
    c = [0.0]
    for i in range(1, len(pts)):
        c.append(c[-1] + math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    return c


def project_forward(pts, cum, p, start_seg: int, window_m: float):
    """Proyección de `p` sobre el recorrido desde el segmento `start_seg` hacia adelante, hasta
    `window_m` metros más allá; devuelve (abscisa, distancia, segmento)."""
    best = None
    limit = cum[start_seg] + window_m
    for i in range(max(1, start_seg), len(pts)):
        if cum[i - 1] > limit:
            break
        ax, ay = pts[i - 1]
        bx, by = pts[i]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        f = 0.0 if l2 == 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2))
        qx, qy = ax + f * dx, ay + f * dy
        d = math.hypot(p[0] - qx, p[1] - qy)
        if best is None or d < best[1] - 1e-9:
            best = (cum[i - 1] + f * math.sqrt(l2), d, i)
    return best


def band_of(start_s: int) -> int:
    h = start_s / 3600
    for k, (a, b, _) in enumerate(BANDS):
        if a <= h < b:
            return k
    return len(BANDS) - 1


SMALL = {'de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'a', 'en'}


# Abreviaturas de la nomenclatura de Bogotá que aparecen en los destinos.
ABBR = [
    (r'\bA[Kk]\b\.?', 'Av. Carrera'), (r'\bA[Cc]\b\.?', 'Av. Calle'),
    (r'\b(?:KR|Kr|CRA|Cra|KRA|Kra)\b\.?', 'Carrera'), (r'\b(?:CLL|Cll|CL|Cl)\b\.?', 'Calle'),
    (r'\b(?:DG|Dg)\b\.?', 'Diagonal'), (r'\b(?:TV|Tv)\b\.?', 'Transversal'), (r'\b(?:AV|Av)\b\.?(?!\.)', 'Av.'),
]
KEEP_UPPER = {'CAD', 'CDS', 'UAN', 'JFK', 'SENA', 'ETB', 'UPN', 'II', 'III', 'IV', 'CC', 'CL', 'NQS'}


def nice(s: str) -> str:
    """Nombre legible: sin mayúsculas sostenidas, «P.» → «Portal», nomenclatura desplegada
    («KR 7 CLL 107A» → «Carrera 7 Calle 107A»)."""
    s = clean(s)
    s = re.sub(r'^P\.\s*', 'Portal ', s)
    s = re.sub(r'^P\s+(?=[A-ZÁÉÍÓÚ])', 'Portal ', s)
    s = re.sub(r'^PElDorado$', 'Portal El Dorado', s)
    s = s.replace('ElDorado', 'El Dorado')
    words = s.split(' ')
    out = []
    for k, w in enumerate(words):
        letters = [c for c in w if c.isalpha()]
        if letters and all(c.isupper() for c in letters) and w not in KEEP_UPPER and (len(letters) >= 4 or not any(c.isdigit() for c in w)):
            lw = w.lower()
            w = lw if (k and lw in SMALL) else lw[:1].upper() + lw[1:]
        out.append(w)
    s = ' '.join(out)
    s = re.sub(r'\b(?:CLL|CL|Cl)(?=\d)', 'Calle ', s)
    s = re.sub(r'\b(?:KR|Kr|CRA)(?=\d)', 'Carrera ', s)
    for pat, rep in ABBR:
        s = re.sub(pat, rep, s)
    s = re.sub(r'\b20 de julio\b', '20 de Julio', s)
    # Destinos son nombres propios: palabras en minúscula de 4 letras o más, con mayúscula inicial.
    s = re.sub(r'(?<=\s)([a-záéíóúñ])(?=[a-záéíóúñ]{3,}\b)', lambda m: m.group(1).upper(), s)
    s = re.sub(r'\b(\d+)([a-z])\b', lambda m: m.group(1) + m.group(2).upper(), s)
    return s.replace('Av.. ', 'Av. ')


def short(name: str) -> str:
    """Nombre corto de estación, sin el patrocinador: «Portal Sur - JFK Coop. Financiera» → «Portal Sur»."""
    return re.split(r'\s+[-–]\s+', name, maxsplit=1)[0].strip()


def strip_code(part: str, codes: set[str]) -> str:
    """«H710 El Progreso» → «El Progreso» cuando H710 es un código de ruta."""
    m = re.match(r'^([A-Z]{0,3}\d+[A-Z]?|[A-Z]\d+-?[A-Z]?\d*)\s+(.*)$', part.strip())
    if m and (m.group(1) in codes or re.match(r'^[A-Z]{1,3}\d', m.group(1))):
        return m.group(2)
    return part


def zone_letter(code: str) -> str | None:
    m = re.match(r'[A-Z]', code or '')
    return m.group() if m else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('gtfs')
    ap.add_argument('--out', default=str(ROOT / 'public' / 'data'))
    args = ap.parse_args()
    t0 = time.time()
    src = Path(args.gtfs)
    digest = hashlib.sha256(src.read_bytes()).hexdigest()[:16]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    palette = json.loads((ROOT / 'data' / 'curated' / 'palette.json').read_text())
    z = zipfile.ZipFile(src)

    # ── Rutas ────────────────────────────────────────────────────────────────────────────────
    routes = list(rows(z, 'routes.txt'))
    route_ix = {r['route_id']: i for i, r in enumerate(routes)}
    log('rutas', len(routes))

    # ── Paradas ──────────────────────────────────────────────────────────────────────────────
    stops = list(rows(z, 'stops.txt'))
    stop_ix = {s['stop_id']: i for i, s in enumerate(stops)}
    stop_xy = [xy(float(s['stop_lon']), float(s['stop_lat'])) for s in stops]
    parent = {s['stop_id']: s['parent_station'] for s in stops if s.get('parent_station')}
    log('paradas', len(stops), 'estaciones', sum(1 for s in stops if s['location_type'] == '1'))

    # ── Viajes ───────────────────────────────────────────────────────────────────────────────
    trip_route: dict[str, int] = {}
    trip_service: dict[str, str] = {}
    shape_of_route: dict[str, str] = {}
    for t in rows(z, 'trips.txt'):
        trip_route[t['trip_id']] = route_ix[t['route_id']]
        trip_service[t['trip_id']] = t['service_id']
        shape_of_route.setdefault(t['route_id'], t['shape_id'])
    log('viajes', len(trip_route))

    # ── Recorridos ───────────────────────────────────────────────────────────────────────────
    raw = defaultdict(list)
    for r in rows(z, 'shapes.txt'):
        raw[r['shape_id']].append((int(r['shape_pt_sequence']), float(r['shape_pt_lon']), float(r['shape_pt_lat'])))
    shapes = {}
    npts_raw = npts = 0
    for sid, pts in raw.items():
        pts.sort()
        ll = [(lo, la) for _, lo, la in pts]
        # Puntos repetidos seguidos no aportan y rompen la proyección.
        ll = [p for k, p in enumerate(ll) if k == 0 or p != ll[k - 1]]
        m = [xy(lo, la) for lo, la in ll]
        keep = simplify(m, SIMPLIFY_M)
        ll = [ll[i] for i in keep]
        m = [m[i] for i in keep]
        shapes[sid] = (ll, m, cumulative(m))
        npts_raw += len(pts)
        npts += len(ll)
    del raw
    log(f'recorridos {len(shapes)}: {npts_raw} → {npts} puntos')

    # ── Horarios: viajes completos en memoria compacta ───────────────────────────────────────
    t_seq: dict[str, array] = {}
    t_stop: dict[str, array] = {}
    t_arr: dict[str, array] = {}
    n = 0
    for r in rows(z, 'stop_times.txt'):
        tid = r['trip_id']
        a = t_seq.get(tid)
        if a is None:
            a = t_seq[tid] = array('i')
            t_stop[tid] = array('i')
            t_arr[tid] = array('i')
        a.append(int(r['stop_sequence']))
        t_stop[tid].append(stop_ix[r['stop_id']])
        t_arr[tid].append(secs(r['arrival_time'] or r['departure_time']))
        n += 1
        if n % 1_000_000 == 0:
            log(f'  stop_times {n:,}')
    log(f'stop_times {n:,} en {time.time() - t0:.0f} s')

    # Patrón por ruta: la secuencia de paradas más frecuente; tiempos por franja a lo largo de ella.
    pat_count: dict[int, Counter] = defaultdict(Counter)
    pat_times: dict[tuple, list] = {}
    departures: dict[int, dict] = defaultdict(lambda: {k: [0] * 30 for k in DAY_TYPE.values()})
    first_last: dict[int, dict] = defaultdict(dict)
    for tid, seq in t_seq.items():
        order = sorted(range(len(seq)), key=seq.__getitem__)
        st = tuple(t_stop[tid][i] for i in order)
        ar = [t_arr[tid][i] for i in order]
        ri = trip_route[tid]
        pat_count[ri][st] += 1
        start = ar[0]
        b = band_of(start)
        key = (ri, st)
        acc = pat_times.get(key)
        if acc is None:
            acc = pat_times[key] = [[None, 0] for _ in BANDS]
        rel = [x - start for x in ar]
        if acc[b][0] is None:
            acc[b][0] = rel
        else:
            acc[b][0] = [p + q for p, q in zip(acc[b][0], rel)]
        acc[b][1] += 1
        day = DAY_TYPE.get(trip_service[tid])
        if day:
            h = min(29, start // 3600)
            departures[ri][day][h] += 1
            fl = first_last[ri].setdefault(day, [start, start])
            fl[0] = min(fl[0], start)
            fl[1] = max(fl[1], start)
    del t_seq, t_stop, t_arr

    # ── Salidas por ruta ─────────────────────────────────────────────────────────────────────
    all_codes = {clean(r['route_short_name']) for r in routes}

    def place_of(si: int) -> str:
        """Nombre del lugar de una parada: la estación si es un vagón, si no el paradero."""
        s = stops[si]
        p = parent.get(s['stop_id'])
        return short(nice(stops[stop_ix[p]]['stop_name'])) if p else nice(s['stop_name'])

    patterns_out = {}
    service_out = {}
    stop_routes: dict[int, set] = defaultdict(set)
    route_info = []
    shapes_out = {}
    max_off = []
    for ri, r in enumerate(routes):
        rid = r['route_id']
        sys_key, sub = SYSTEM_BY_AGENCY.get(r['agency_id'], ('zonal', None))
        code = clean(r['route_short_name'])
        zl = zone_letter(code) if sys_key in ('troncal', 'dual') else None
        if sys_key in ('troncal', 'dual'):
            color = palette['zones'][zl]['color'] if zl in palette['zones'] else palette['numbered']
        else:
            color = palette['systems'][sys_key]['color']
        sid = shape_of_route.get(rid)
        shp = shapes.get(sid)
        length = round(shp[2][-1]) if shp else 0
        # Patrón dominante y abscisa de cada parada sobre el recorrido.
        pat = None
        stops_s: list[int] = []
        if pat_count.get(ri):
            pat, cnt = pat_count[ri].most_common(1)[0]
            if shp:
                ll, m, cum = shp
                seg = 1
                for k, si in enumerate(pat):
                    hit = project_forward(m, cum, stop_xy[si], seg, 4000)
                    if hit is None or hit[1] > 80:
                        # Fuera de la ventana: búsqueda en todo lo que falta.
                        hit2 = project_forward(m, cum, stop_xy[si], seg, 1e9)
                        hit = hit2 if hit is None or (hit2 and hit2[1] < hit[1]) else hit
                    stops_s.append(round(hit[0]))
                    max_off.append(hit[1])
                    seg = hit[2]
            for si in pat:
                stop_routes[si].add(ri)
                if stops[si]['stop_id'] in parent:
                    stop_routes[stop_ix[parent[stops[si]['stop_id']]]].add(ri)
            acc = pat_times[(ri, pat)]
            times = []
            for b, (tot, c) in enumerate(acc):
                times.append([round(x / c) for x in tot] if c else None)
            patterns_out[rid] = {
                'stops': [stops[si]['stop_id'] for si in pat],
                's': stops_s,
                't': times,
                'trips': cnt,
            }
        dep = departures.get(ri)
        if dep:
            service_out[rid] = {
                day: {'h': counts, 'first': first_last[ri].get(day, [None, None])[0], 'last': first_last[ri].get(day, [None, None])[1]}
                for day, counts in dep.items() if any(counts)
            }
        long_name = clean(r['route_long_name'])
        loop = '||' in long_name
        if loop:
            parts = [nice(strip_code(x, all_codes)) for x in long_name.split('||')]
            dest, origin = parts[0], parts[-1]
        else:
            dest = nice(strip_code(long_name, all_codes))
            origin = place_of(pat[0]) if pat else None
        route_info.append({
            'id': rid, 'code': code, 'name': long_name, 'dest': dest, 'origin': origin, **({'loop': True} if loop else {}),
            'sys': sys_key, **({'sub': sub} if sub else {}), **({'zone': zl} if zl else {}),
            'color': color, 'len': length, 'stops': len(pat) if pat else 0,
        })
        if shp:
            ll = shp[0]
            enc = []
            px = py = 0
            for lo, la in ll:
                x, y = round(lo * E6), round(la * E6)
                enc.extend((x - px, y - py))
                px, py = x, y
            shapes_out[rid] = enc

    # Sentido contrario: mismo código y sistema, otro route_id.
    by_code = defaultdict(list)
    for r in route_info:
        by_code[(r['sys'], r['code'])].append(r['id'])
    for r in route_info:
        others = [x for x in by_code[(r['sys'], r['code'])] if x != r['id']]
        if others:
            r['pair'] = others

    # ── Estaciones con vagones ───────────────────────────────────────────────────────────────
    kids = defaultdict(list)
    for s in stops:
        if s.get('parent_station'):
            kids[s['parent_station']].append(s)
    def norm(n: str) -> str:
        import unicodedata
        n = unicodedata.normalize('NFD', n.lower())
        return re.sub(r'[^a-z0-9]', '', ''.join(c for c in n if not unicodedata.combining(c)))

    parents = [s for s in stops if s['location_type'] == '1']
    shells = set()
    for s in parents:
        if kids.get(s['stop_id']):
            continue
        for o in parents:
            if o is s or not kids.get(o['stop_id']):
                continue
            d = math.hypot(*(a - b for a, b in zip(stop_xy[stop_ix[s['stop_id']]], stop_xy[stop_ix[o['stop_id']]])))
            if d < 500 and (norm(o['stop_name']).startswith(norm(s['stop_name'])[:8]) or norm(s['stop_name']).startswith(norm(o['stop_name'])[:8])):
                shells.add(s['stop_id'])
                break
    stations = []
    for s in stops:
        if s['location_type'] != '1' or s['stop_id'] in shells:
            continue
        name = nice(s['stop_name'])
        kind = 'cable' if s['stop_id'].startswith('cable') else 'portal' if re.match(r'(?i)portal|terminal', name) else 'station'
        rs = sorted({routes[ri]['route_id'] for ri in stop_routes.get(stop_ix[s['stop_id']], ())})
        stations.append({
            'id': s['stop_id'], 'name': name, 'short': short(name), 'kind': kind,
            'lon': round(float(s['stop_lon']), 6), 'lat': round(float(s['stop_lat']), 6),
            'routes': rs, **({} if rs else {'closed': True}),
            'platforms': [
                {'id': k['stop_id'], 'name': clean(k['stop_name']), 'code': k['stop_code'],
                 'routes': sorted(routes[ri]['route_id'] for ri in stop_routes.get(stop_ix[k['stop_id']], ())),
                 'lon': round(float(k['stop_lon']), 6), 'lat': round(float(k['stop_lat']), 6)}
                for k in sorted(kids.get(s['stop_id'], []), key=lambda k: k['stop_name'])
            ],
        })

    # Paraderos: todo lo que no es estación ni vagón y tiene al menos una ruta.
    street = []
    for i, s in enumerate(stops):
        if s['location_type'] == '1' or s.get('parent_station'):
            continue
        rs = stop_routes.get(i)
        if not rs:
            continue
        street.append([s['stop_id'], s['stop_code'], clean(s['stop_name']),
                       round(float(s['stop_lon']), 6), round(float(s['stop_lat']), 6),
                       sorted(routes[ri]['route_id'] for ri in rs)])

    # ── Escritura ────────────────────────────────────────────────────────────────────────────
    systems = [{'key': k, **v} for k, v in palette['systems'].items()]
    feed = next(rows(z, 'feed_info.txt'), {})
    meta = {
        'v': 1, 'hash': digest, 'built': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'feed': {'start': feed.get('feed_start_date'), 'end': feed.get('feed_end_date')},
        'bands': [{'from': a, 'to': b, 'key': k} for a, b, k in BANDS],
        'projection': {'lat0': LAT0, 'kx': KX, 'ky': KY},
        'counts': {
            'routes': len(route_info), 'stations': len(stations), 'stations_closed': sum(1 for s in stations if s.get('closed')),
            'stations_merged': len(shells), 'stops': len(street),
            'shape_points': npts, 'by_system': Counter(r['sys'] for r in route_info),
        },
    }

    def write(name, obj):
        p = out / name
        p.write_text(json.dumps(obj, ensure_ascii=False, separators=(',', ':')))
        log(f'{name}: {p.stat().st_size / 1024:.0f} kB')

    write('network.json', {'v': 1, 'hash': digest, 'systems': systems, 'routes': route_info, 'stations': stations})
    core = {r['id'] for r in route_info if r['sys'] in ('troncal', 'dual', 'cable')}
    write('shapes-core.json', {'v': 1, 'hash': digest, 'scale': E6, 'shapes': {k: v for k, v in shapes_out.items() if k in core}})
    write('shapes-zonal.json', {'v': 1, 'hash': digest, 'scale': E6, 'shapes': {k: v for k, v in shapes_out.items() if k not in core}})
    write('stops.json', {'v': 1, 'hash': digest, 'cols': ['id', 'code', 'name', 'lon', 'lat', 'routes'], 'stops': street})
    write('patterns.json', {'v': 1, 'hash': digest, 'bands': [k for _, _, k in BANDS], 'patterns': patterns_out})
    write('service.json', {'v': 1, 'hash': digest, 'service': service_out})
    write('meta.json', meta)
    off = sorted(max_off)
    if off:
        log(f'paradas sobre el recorrido: p50 {off[len(off)//2]:.1f} m · p99 {off[int(len(off)*.99)]:.1f} m · máx {off[-1]:.0f} m')
    log(f'listo en {time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()

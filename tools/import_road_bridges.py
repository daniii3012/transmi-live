#!/usr/bin/env python3
"""Puentes de las vías de carros junto a la troncal, para el 3D (H7).

    python3 tools/import_road_bridges.py RUTA/transmi-sim/app/dist/context.json

Toma del contexto del simulador (OSM a 120 m de la troncal, en metros de su proyección azimutal) las
vías marcadas como puente, y de OSM (Overpass) sus etiquetas `highway`, `lanes` y `layer`: el
contexto no trae el número de carriles, y el ancho del tablero sale de ahí. Escribe
`data/curated/road_bridges.json` (versionado: pequeño y curado).

`tools/build_data.py` decide cuáles van con la troncal: un puente vial que corre al lado del tablero
de TransMilenio, en su sentido y a pocos metros, es la misma estructura (la Calle 80, la NQS, la
Calle 6…), y se dibuja entero.

Cada puente lleva también sus accesos (`approach`): la vía que lo continúa en cada extremo (por el nodo
compartido, en su sentido y con preferencia por el mismo nombre), hasta 170 m. Por ahí baja la rampa
del puente vial cuando la de la troncal se aparta (Av. Américas con Boyacá, Cra 30 con Calle 13).
"""
import datetime as dt
import json
import math
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LON0, LAT0 = -74.136, 4.63027
A, E2 = 6_378_137.0, 0.00669437999014
s = math.sin(math.radians(LAT0))
M = A * (1 - E2) / (1 - E2 * s * s) ** 1.5
N = A / math.sqrt(1 - E2 * s * s)
M_PER_DEG_LAT = M * math.pi / 180
M_PER_DEG_LON = N * math.cos(math.radians(LAT0)) * math.pi / 180
ROADS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'}
DEFAULT_LANES = {'motorway': 3, 'trunk': 3, 'primary': 2, 'secondary': 2, 'tertiary': 2}
OVERPASS = 'https://overpass-api.de/api/interpreter'
APPROACH_M = 170  # largo de acceso guardado en cada extremo (la rampa más larga, de 2 niveles, ~235 m: basta con uno)


def ll(x, y):
    return [round(LON0 + x / M_PER_DEG_LON, 7), round(LAT0 + y / M_PER_DEG_LAT, 7)]


def overpass_tags(ids):
    # Con curl: el Python de Xcode trae un TLS que Overpass rechaza.
    q = f'[out:json][timeout:90];way(id:{",".join(map(str, ids))});out tags;'
    r = subprocess.run(['curl', '-sS', '--max-time', '120', '-A', 'transmi-live-tools/1.0', '--data-urlencode', f'data={q}', OVERPASS],
                       capture_output=True, text=True, check=True)
    return {e['id']: e.get('tags', {}) for e in json.loads(r.stdout)['elements']}


def approaches(roads):
    """Para cada vía, la que la continúa en cada extremo: desde el nodo del extremo (vértice compartido),
    la que sigue en el sentido más parecido (coseno ≥ 0,6; a igualdad, la del mismo nombre), y así hasta
    `APPROACH_M`. Devuelve {id: {'start': [(x, y)…], 'end': [(x, y)…]}} (cada lista empieza en el extremo)."""
    key = lambda p: (round(p[0] * 2), round(p[1] * 2))  # medio metro
    at = {}
    for wi, f in enumerate(roads):
        for vi, p in enumerate(f['points']):
            at.setdefault(key(p), []).append((wi, vi))

    def follow(p, h, name, skip):
        out, total, seen = [p], 0.0, set(skip)
        while total < APPROACH_M:
            best = None
            for wi, vi in at.get(key(p), ()):
                if wi in seen:
                    continue
                pts = roads[wi]['points']
                for step in (1, -1):
                    j = vi + step
                    if not 0 <= j < len(pts):
                        continue
                    dx, dy = pts[j][0] - p[0], pts[j][1] - p[1]
                    l = math.hypot(dx, dy)
                    if l < 0.01:
                        continue
                    c = (dx * h[0] + dy * h[1]) / l
                    score = c + (0.05 if name and roads[wi].get('name') == name else 0)
                    if c >= 0.6 and (best is None or score > best[0]):
                        best = (score, wi, vi, step)
            if best is None:
                break
            _, wi, vi, step = best
            seen.add(wi)
            pts = roads[wi]['points']
            j = vi
            while 0 <= j + step < len(pts) and total < APPROACH_M:
                a, b = pts[j], pts[j + step]
                l = math.hypot(b[0] - a[0], b[1] - a[1])
                if l > 0.01:
                    h = ((b[0] - a[0]) / l, (b[1] - a[1]) / l)
                    out.append(b)
                    total += l
                j += step
            p = pts[j]
            if not (j == 0 or j == len(pts) - 1):
                break  # la vía sigue, pero ya basta
        return out

    res = {}
    for wi, f in enumerate(roads):
        if not f.get('bridge'):
            continue
        P = f['points']
        if len(P) < 2:
            continue
        unit = lambda a, b: ((b[0] - a[0]) / (math.hypot(b[0] - a[0], b[1] - a[1]) or 1), (b[1] - a[1]) / (math.hypot(b[0] - a[0], b[1] - a[1]) or 1))
        res[f['id']] = {'start': follow(P[0], unit(P[1], P[0]), f.get('name'), {wi}),
                        'end': follow(P[-1], unit(P[-2], P[-1]), f.get('name'), {wi})}
    return res


def main():
    ctx = json.loads(Path(sys.argv[1]).read_text())
    roads = [f for f in ctx['features'] if f.get('kind') == 'road' and not f.get('tunnel') and len(f.get('points') or []) >= 2]
    access = approaches(roads)
    feats = [f for f in ctx['features'] if f.get('kind') == 'road' and f.get('bridge') and not f.get('tunnel')]
    tags = overpass_tags(sorted({f['id'] for f in feats}))
    ways = []
    for f in feats:
        t = tags.get(f['id'], {})
        hw = t.get('highway', '')
        if hw not in ROADS:
            continue
        try:
            lanes = max(1, int(str(t.get('lanes', '')).split(';')[0]))
        except ValueError:
            lanes = DEFAULT_LANES.get(hw.replace('_link', ''), 1 if hw.endswith('_link') else 2)
        ways.append({'id': f['id'], 'name': t.get('name') or f.get('name'), 'highway': hw, 'lanes': lanes,
                     'layer': t.get('layer') or f.get('layer'), 'points': [ll(x, y) for x, y in f['points']],
                     'approach': {k: [ll(x, y) for x, y in v[1:]] for k, v in access.get(f['id'], {'start': [], 'end': []}).items()}})
    out = {
        'source': 'OpenStreetMap (contexto del simulador transmi-sim y etiquetas vía Overpass)',
        'license': 'ODbL 1.0 — © colaboradores de OpenStreetMap',
        'retrieved_at': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'ways': ways,
    }
    p = ROOT / 'data' / 'curated' / 'road_bridges.json'
    p.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    n = sum(1 for w in ways for v in w['approach'].values() if v)
    print(f'{p.name}: {len(ways)} puentes viales ({len(feats)} en el contexto), {n} accesos de {2 * len(ways)}, {p.stat().st_size // 1024} kB')


if __name__ == '__main__':
    main()

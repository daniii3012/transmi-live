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


def ll(x, y):
    return [round(LON0 + x / M_PER_DEG_LON, 7), round(LAT0 + y / M_PER_DEG_LAT, 7)]


def overpass_tags(ids):
    # Con curl: el Python de Xcode trae un TLS que Overpass rechaza.
    q = f'[out:json][timeout:90];way(id:{",".join(map(str, ids))});out tags;'
    r = subprocess.run(['curl', '-sS', '--max-time', '120', '-A', 'transmi-live-tools/1.0', '--data-urlencode', f'data={q}', OVERPASS],
                       capture_output=True, text=True, check=True)
    return {e['id']: e.get('tags', {}) for e in json.loads(r.stdout)['elements']}


def main():
    ctx = json.loads(Path(sys.argv[1]).read_text())
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
                     'layer': t.get('layer') or f.get('layer'), 'points': [ll(x, y) for x, y in f['points']]})
    out = {
        'source': 'OpenStreetMap (contexto del simulador transmi-sim y etiquetas vía Overpass)',
        'license': 'ODbL 1.0 — © colaboradores de OpenStreetMap',
        'retrieved_at': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'ways': ways,
    }
    p = ROOT / 'data' / 'curated' / 'road_bridges.json'
    p.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    print(f'{p.name}: {len(ways)} puentes viales ({len(feats)} en el contexto), {p.stat().st_size // 1024} kB')


if __name__ == '__main__':
    main()

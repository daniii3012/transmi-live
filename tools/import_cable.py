#!/usr/bin/env python3
"""TransMiCable para el 3D (H7), desde OSM (Overpass).

    python3 tools/import_cable.py

Trae de OSM, en Ciudad Bolívar: la línea de la góndola (`aerialway=gondola`), sus torres
(`aerialway=pylon`) y los contornos de sus estaciones (`aerialway=station`, con `height` si lo tienen).
Escribe `data/curated/transmicable.json` (lon/lat). Las alturas de torres y cable no están en OSM: las
estima la página (src/map/structuresLayer.ts, `buildCable`).
"""
import datetime as dt
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OVERPASS = 'https://overpass-api.de/api/interpreter'
BBOX = '4.53,-74.18,4.58,-74.12'


def main():
    q = (f'[out:json][timeout:90];(way[aerialway=gondola]({BBOX});node[aerialway=pylon]({BBOX});'
         f'way[aerialway=station]({BBOX}););out geom tags;')
    r = subprocess.run(['curl', '-sS', '--max-time', '120', '-A', 'transmi-live-tools/1.0', '--data-urlencode', f'data={q}', OVERPASS],
                       capture_output=True, text=True, check=True)
    els = json.loads(r.stdout)['elements']
    pt = lambda g: [round(g['lon'], 7), round(g['lat'], 7)]
    lines = [{'id': e['id'], 'name': e.get('tags', {}).get('name'), 'points': [pt(g) for g in e['geometry']]}
             for e in els if e['type'] == 'way' and e.get('tags', {}).get('aerialway') == 'gondola']
    pylons = [pt(e) for e in els if e['type'] == 'node' and e.get('tags', {}).get('aerialway') == 'pylon']
    stations = []
    for e in els:
        t = e.get('tags', {})
        if e['type'] == 'way' and t.get('aerialway') == 'station':
            try:
                h = float(str(t.get('height', '')).split()[0])
            except (ValueError, IndexError):
                h = None
            stations.append({'id': e['id'], 'name': t.get('name'), 'height': h, 'outline': [pt(g) for g in e['geometry']]})
    out = {'source': 'OpenStreetMap (Overpass)', 'license': 'ODbL 1.0 — © colaboradores de OpenStreetMap',
           'retrieved_at': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
           'lines': lines, 'pylons': pylons, 'stations': stations}
    p = ROOT / 'data' / 'curated' / 'transmicable.json'
    p.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    print(f'{p.name}: {len(lines)} líneas, {len(pylons)} torres, {len(stations)} estaciones')


if __name__ == '__main__':
    main()

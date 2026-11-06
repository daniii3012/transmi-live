#!/usr/bin/env python3
"""Troncales en obra (modo de obras, H7), desde los datos curados del simulador.

    python3 tools/import_obras.py RUTA/transmi-sim/data/curated/obras.json

Av. 68, Séptima, Soacha (fases II y III) y la intersección de Puente Aranda en la Calle 13: trazado de
OSM (vías de TransMilenio en construcción o propuestas), si ya está construido cada tramo, su nivel
(puente +1/+2, deprimido −1) y su carril, con el estado, el avance y la fuente de cada obra. Las
geometrías vienen en metros de la proyección azimutal del simulador y se pasan a lon/lat (como en
import_metro.py). Escribe `data/curated/troncales_obra.json` (no confundir con `obras.json`, que marca
los tramos en obra de la red que opera).
"""
import json
import math
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


def ll(p):
    return [round(LON0 + p[0] / M_PER_DEG_LON, 7), round(LAT0 + p[1] / M_PER_DEG_LAT, 7)]


def main():
    src = json.loads(Path(sys.argv[1]).read_text())
    works = []
    for w in src['works']:
        works.append({
            'id': w['id'], 'name': w['name'], 'status': w.get('status'), 'progress_pct': w.get('progress_pct'),
            'opening': w.get('opening'), 'notes': w.get('notes'), 'source': w.get('source'),
            'groups': w.get('groups') or [], 'stations_planned': w.get('stations_planned') or [],
            'ways': [{k: v for k, v in {'built': bool(x.get('built')), 'level': x.get('level'), 'lanes': x.get('lanes'),
                                        'points': [ll(p) for p in x['points']]}.items() if v is not None} for x in w['ways']],
            'areas': [{'name': a.get('name'), 'points': [ll(p) for p in a['points']]} for a in w.get('areas') or []],
        })
    out = {
        'source': {'geometry': 'OpenStreetMap, ODbL 1.0 (vía el simulador transmi-sim)', 'snapshot': src['source'].get('snapshot')},
        'note': 'Obras que no operan: ninguna ruta las usa. Estado, avance y fechas según la fuente de cada obra.',
        'works': works,
    }
    p = ROOT / 'data' / 'curated' / 'troncales_obra.json'
    p.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    print(f'{p.name}: {p.stat().st_size // 1024} kB, ' + ', '.join(f"{w['id']} {len(w['ways'])} vías" for w in works))


if __name__ == '__main__':
    main()

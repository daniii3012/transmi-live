#!/usr/bin/env python3
"""Puentes peatonales junto a la troncal (H7), desde los datos curados del simulador.

    python3 tools/import_footbridges.py RUTA/transmi-sim/data/curated/cross_streets.json

El simulador los toma de OSM (a 70 m de la calzada de TransMilenio) y les calcula la altura por vértice:
5,5 m por nivel donde cruzan una calle o la troncal, y desde cada extremo libre bajan al 10 % (60 % en
una escalera). Aquí solo se pasan sus metros (proyección azimutal del simulador) a lon/lat, como en
import_metro.py. Escribe `data/curated/footbridges.json`; `tools/build_data.py` los lleva a
`structures.json`.
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


def main():
    src = json.loads(Path(sys.argv[1]).read_text())
    out = []
    for f in src.get('footbridges', []):
        pts = [[round(LON0 + x / M_PER_DEG_LON, 7), round(LAT0 + y / M_PER_DEG_LAT, 7), round(z, 2)] for x, y, z in f['points']]
        if len(pts) >= 2:
            out.append({'id': f['id'], 'kind': f.get('kind', 'deck'), 'name': f.get('name'), 'points': pts})
    doc = {'source': 'OpenStreetMap (vía el simulador transmi-sim; alturas calculadas allí)', 'license': 'ODbL 1.0 — © colaboradores de OpenStreetMap',
           'snapshot': (src.get('source') or {}).get('snapshot'), 'footbridges': out}
    p = ROOT / 'data' / 'curated' / 'footbridges.json'
    p.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')))
    print(f'{p.name}: {len(out)} piezas, {p.stat().st_size // 1024} kB')


if __name__ == '__main__':
    main()

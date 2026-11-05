#!/usr/bin/env python3
"""Importa la Línea 1 del metro desde los datos curados del simulador (vista previa, hito 7).

    python3 tools/import_metro.py RUTA/transmi-sim/data/curated/metro_l1.json

El simulador guarda la geometría en metros, en una proyección azimutal equidistante centrada en
(-74.136, 4.63027). A la escala de la ciudad se invierte con los radios del elipsoide en ese punto:
el error es de centímetros. Escribe `data/curated/metro_l1.geojson` (versionado: es pequeño y curado).

Además del trazado y las estaciones, arma el tablero del viaducto como franjas de 9 m de ancho para
la vista 3D (tablero a 11–13 m; la altura publicada del viaducto es 13 m).
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LON0, LAT0 = -74.136, 4.63027
A, E2 = 6_378_137.0, 0.00669437999014
s = math.sin(math.radians(LAT0))
M = A * (1 - E2) / (1 - E2 * s * s) ** 1.5      # radio meridiano
N = A / math.sqrt(1 - E2 * s * s)               # radio del primer vertical
M_PER_DEG_LAT = M * math.pi / 180
M_PER_DEG_LON = N * math.cos(math.radians(LAT0)) * math.pi / 180


def ll(x, y):
    return [round(LON0 + x / M_PER_DEG_LON, 7), round(LAT0 + y / M_PER_DEG_LAT, 7)]


def simplify(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy or 1e-9
        best, bi = 0.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            f = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
            d = math.hypot(px - ax - f * dx, py - ay - f * dy)
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def deck(pts, half=4.5, step=40.0):
    """Tablero del viaducto: cuadriláteros a lo largo del trazado (sin autointersecciones)."""
    out = []
    # Remuestreo cada `step` m para que las franjas sigan las curvas.
    dense = [pts[0]]
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        l = math.hypot(bx - ax, by - ay)
        n = max(1, int(l // step))
        for k in range(1, n + 1):
            dense.append((ax + (bx - ax) * k / n, ay + (by - ay) * k / n))
    for (ax, ay), (bx, by) in zip(dense, dense[1:]):
        l = math.hypot(bx - ax, by - ay)
        if l < 0.5:
            continue
        nx, ny = -(by - ay) / l * half, (bx - ax) / l * half
        ring = [(ax + nx, ay + ny), (bx + nx, by + ny), (bx - nx, by - ny), (ax - nx, ay - ny), (ax + nx, ay + ny)]
        out.append([ll(x, y) for x, y in ring])
    return out


def main():
    src = json.loads(Path(sys.argv[1]).read_text())
    align = simplify([tuple(p) for p in src['alignment']], 1.0)
    features = [{
        'type': 'Feature',
        'properties': {'kind': 'alignment', 'name': 'Metro de Bogotá · Línea 1', 'status': src['status'], 'length_m': round(src['length_m'])},
        'geometry': {'type': 'LineString', 'coordinates': [ll(x, y) for x, y in align]},
    }]
    for poly in deck(align):
        features.append({'type': 'Feature', 'properties': {'kind': 'deck', 'base': 11, 'top': 13}, 'geometry': {'type': 'Polygon', 'coordinates': [poly]}})
    for st in src['stations']:
        features.append({'type': 'Feature', 'properties': {'kind': 'station', 'number': st['number'], 'name': st['name'], 'reference': st.get('reference')},
                         'geometry': {'type': 'Point', 'coordinates': ll(*st['xy'])}})
        if st.get('outline'):
            features.append({'type': 'Feature', 'properties': {'kind': 'station-body', 'name': st['name'], 'base': 9, 'top': 21},
                             'geometry': {'type': 'Polygon', 'coordinates': [[ll(x, y) for x, y in st['outline']]]}})
    dep = src.get('depot')
    if dep and dep.get('outline'):
        features.append({'type': 'Feature', 'properties': {'kind': 'depot', 'name': dep['name']},
                         'geometry': {'type': 'Polygon', 'coordinates': [[ll(x, y) for x, y in dep['outline']]]}})
    out = {
        'type': 'FeatureCollection',
        'properties': {
            'source': src['source'].get('dataset'), 'license': src['source'].get('license'),
            'status': src['status'], 'stations': len(src['stations']), 'length_m': round(src['length_m']),
        },
        'features': features,
    }
    p = ROOT / 'data' / 'curated' / 'metro_l1.geojson'
    p.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    print(f'{p.name}: {p.stat().st_size // 1024} kB, {len(align)} puntos, {len(src["stations"])} estaciones')


if __name__ == '__main__':
    main()

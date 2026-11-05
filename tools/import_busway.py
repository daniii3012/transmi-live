#!/usr/bin/env python3
"""Importa la geometría física de la troncal desde los datos curados del simulador (hito 7).

    python3 tools/import_busway.py RUTA/transmi-sim/data/curated

Lee tres archivos del simulador, todos derivados de OpenStreetMap (ODbL):

    busway_lanes.json       ejes de la calzada exclusiva, por sentido (929 vías)
    station_layouts.json    huellas de estación (building=bus_station) y plataformas
    busway_structures.json  puentes y deprimidos de la calzada, con su nivel

y escribe `data/curated/busway.json` (versionado: es curado y pequeño) en longitud y latitud.

El simulador guarda metros en una proyección azimutal equidistante elipsoidal centrada en
(-74.136, 4.63027). Una inversa aproximada (radios en el origen) se desvía hasta 2 m en los bordes de
la ciudad, más de medio carril; aquí se invierte la proyección exacta: la directa es la geodésica desde
el origen (Vincenty: distancia y azimut), y se resuelve por Newton. Se comprueba contra los pares
(lon, lat) ↔ (x, y) de las estaciones del propio simulador.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LON0, LAT0 = -74.136, 4.63027
A = 6_378_137.0
F = 1 / 298.257223563
B = A * (1 - F)


def geodesic(lat1: float, lon1: float, lat2: float, lon2: float) -> tuple[float, float]:
    """Distancia (m) y azimut inicial (rad) entre dos puntos del elipsoide WGS84 (Vincenty)."""
    L = math.radians(lon2 - lon1)
    U1 = math.atan((1 - F) * math.tan(math.radians(lat1)))
    U2 = math.atan((1 - F) * math.tan(math.radians(lat2)))
    sU1, cU1, sU2, cU2 = math.sin(U1), math.cos(U1), math.sin(U2), math.cos(U2)
    lam = L
    for _ in range(100):
        sl, cl = math.sin(lam), math.cos(lam)
        ss = math.hypot(cU2 * sl, cU1 * sU2 - sU1 * cU2 * cl)
        if ss == 0:
            return 0.0, 0.0
        cs = sU1 * sU2 + cU1 * cU2 * cl
        sig = math.atan2(ss, cs)
        sa = cU1 * cU2 * sl / ss
        c2a = 1 - sa * sa
        c2sm = cs - 2 * sU1 * sU2 / c2a if c2a else 0.0
        C = F / 16 * c2a * (4 + F * (4 - 3 * c2a))
        prev = lam
        lam = L + (1 - C) * F * sa * (sig + C * ss * (c2sm + C * cs * (-1 + 2 * c2sm * c2sm)))
        if abs(lam - prev) < 1e-13:
            break
    u2 = c2a * (A * A - B * B) / (B * B)
    AA = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)))
    BB = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)))
    ds = BB * ss * (c2sm + BB / 4 * (cs * (-1 + 2 * c2sm * c2sm) - BB / 6 * c2sm * (-3 + 4 * ss * ss) * (-3 + 4 * c2sm * c2sm)))
    s = B * AA * (sig - ds)
    az = math.atan2(cU2 * math.sin(lam), cU1 * sU2 - sU1 * cU2 * math.cos(lam))
    return s, az


def forward(lon: float, lat: float) -> tuple[float, float]:
    s, az = geodesic(LAT0, LON0, lat, lon)
    return s * math.sin(az), s * math.cos(az)


KX0 = 111_320.0 * math.cos(math.radians(LAT0))
KY0 = 110_574.0


def inverse(x: float, y: float) -> tuple[float, float]:
    lon, lat = LON0 + x / KX0, LAT0 + y / KY0
    h = 1e-6
    for _ in range(6):
        fx, fy = forward(lon, lat)
        ex, ey = x - fx, y - fy
        if abs(ex) + abs(ey) < 1e-4:
            break
        ax, ay = forward(lon + h, lat)
        bx, by = forward(lon, lat + h)
        j11, j21 = (ax - fx) / h, (ay - fy) / h
        j12, j22 = (bx - fx) / h, (by - fy) / h
        det = j11 * j22 - j12 * j21
        lon += (ex * j22 - ey * j12) / det
        lat += (ey * j11 - ex * j21) / det
    return lon, lat


def ll(p) -> list[float]:
    lon, lat = inverse(p[0], p[1])
    return [round(lon, 7), round(lat, 7)]


def area(pts) -> float:
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]))) / 2


def main():
    src = Path(sys.argv[1])
    lanes = json.loads((src / 'busway_lanes.json').read_text())
    layouts = json.loads((src / 'station_layouts.json').read_text())
    structures = json.loads((src / 'busway_structures.json').read_text())

    # Comprobación de la inversa con los pares del simulador.
    errs = []
    for st in layouts['stations']:
        lon, lat = inverse(*st['xy'])
        lo, la = st['lon_lat']
        errs.append(math.hypot((lon - lo) * KX0, (lat - la) * KY0))
    errs.sort()
    print(f'inversa: error p50 {errs[len(errs) // 2]:.3f} m, máx. {errs[-1]:.3f} m')
    if errs[-1] > 0.25:
        sys.exit('la inversa no coincide con el simulador')

    out_lanes = []
    for w in lanes['ways']:
        if len(w['points']) < 2:
            continue
        out_lanes.append({
            'id': w['osm_way_id'],
            'oneway': w.get('oneway') == 'yes',
            'lanes': int(w['lanes']) if str(w.get('lanes') or '').isdigit() else None,
            'building': w.get('highway') == 'construction',
            'c': [ll(p) for p in w['points']],
        })

    # Huella de cada estación: el edificio (building=bus_station) más grande con proporción de
    # estación (ancho 3–20 m, ≥ 250 m²); si no hay, las plataformas cerradas. Los recortes de pocos
    # metros cuadrados (casetas, accesos) se descartan.
    out_st = []
    for st in layouts['stations']:
        best = None
        for ar in st.get('areas') or []:
            pts = ar['points']
            if not ar.get('closed') or len(pts) < 4:
                continue
            a = area(pts)
            w = ar.get('width_m') or 0
            if a >= 250 and 3 <= w <= 20 and (best is None or a > best[0]):
                best = (a, ar)
        polys = []
        kind = None
        if best:
            polys = [best[1]['points']]
            kind = 'building'
        else:
            for p in st.get('platforms') or []:
                if p.get('closed') and len(p['points']) >= 4 and area(p['points']) >= 60 and p['role'] == 'platform_trunk':
                    polys.append(p['points'])
            kind = 'platform' if polys else None
        if not polys:
            continue
        out_st.append({
            'id': st['station_id'],
            'kind': kind,
            'polys': [[ll(p) for p in poly] for poly in polys],
            'src': best[1]['source'] if best else None,
        })

    out_str = []
    for s in structures['structures']:
        out_str.append({'id': s['osm_way_id'], 'kind': s['kind'], 'level': s['level'], 'grade': s.get('grade'), 'c': [ll(p) for p in s['points']]})

    out = {
        'v': 1,
        'source': 'OpenStreetMap (ODbL), vía los datos curados del simulador',
        'snapshot': lanes['source'].get('snapshot'),
        'license': 'ODbL 1.0 — © colaboradores de OpenStreetMap',
        'lanes': out_lanes,
        'stations': out_st,
        'structures': out_str,
    }
    p = ROOT / 'data' / 'curated' / 'busway.json'
    p.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    print(f'{p.name}: {p.stat().st_size // 1024} kB · {len(out_lanes)} vías · {len(out_st)} estaciones con huella · {len(out_str)} estructuras')


if __name__ == '__main__':
    main()

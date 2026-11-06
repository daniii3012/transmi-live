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
import os
import re
import sys
import time
import zipfile
from array import array
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import busway as bw  # noqa: E402
import diff_network  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
LAT0 = 4.65
KX = 111_320.0 * math.cos(math.radians(LAT0))
KY = 110_574.0
SIMPLIFY_M = 1.5
# Largo de una ruta troncal lejos de los ejes de corredor curados a partir del cual se avisa.
OFF_AXES_M = 1500
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


def densify(pts, step: float):
    """Puntos cada `step` m (o menos) sobre una polilínea en metros."""
    out = [pts[0]]
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        n = max(1, int(math.hypot(bx - ax, by - ay) // step))
        out.extend((ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(1, n + 1))
    return out


def street_level_guide(segs, lanes, cover_m: float = 35.0):
    """Guía de troncal a nivel de calle. Los ejes del catálogo son de trazo grueso (vértices cada ~90 m):
    en glorietas y giros se apartan de la vía hasta 20–30 m. Donde OSM tiene la calzada exclusiva, esa
    geometría es la fiel: los tramos del eje cubiertos por un carril de OSM a menos de `cover_m` se marcan
    `osm` (la página los desvanece al acercarse) y cada carril sale con la zona (color) del eje más cercano."""
    G = 50.0
    lane_grid = defaultdict(list)
    lanes_m = []
    for w in lanes:
        m = [xy(lo, la) for lo, la in w['c']]
        lanes_m.append(m)
        for x, y in densify(m, 5.0):
            lane_grid[(int(x // G), int(y // G))].append((x, y))

    def covered(x, y):
        gx, gy = int(x // G), int(y // G)
        r2 = cover_m * cover_m
        return any((x - a) ** 2 + (y - b) ** 2 <= r2 for i in (-1, 0, 1) for j in (-1, 0, 1) for a, b in lane_grid.get((gx + i, gy + j), ()))

    axis_grid = defaultdict(list)
    out_segs = []
    for s in segs:
        pts = densify([xy(lo, la) for lo, la in s['c']], 10.0)
        for x, y in pts:
            axis_grid[(int(x // G), int(y // G))].append((x, y, s.get('z')))
        flags = [not s.get('street') and covered(x, y) for x, y in pts]
        # Huecos y salientes cortos (< 40 m) no parten el tramo.
        runs = []
        for f in flags:
            if runs and runs[-1][0] == f:
                runs[-1][1] += 1
            else:
                runs.append([f, 1])
        for k in range(1, len(runs) - 1):
            if runs[k][1] < 4:
                runs[k][0] = runs[k - 1][0]
        i = 0
        merged = []
        for f, n in runs:
            if merged and merged[-1][0] == f:
                merged[-1][2] = i + n
            else:
                merged.append([f, i, i + n])
            i += n
        for f, a, b in merged:
            part = pts[max(0, a - 1):b]  # comparten el vértice de unión
            if len(part) < 2:
                continue
            keep = simplify(part, 0.5)
            out_segs.append({**s, **({'osm': True} if f else {}), 'c': [[round(part[k][0] / KX, 6), round(part[k][1] / KY, 6)] for k in keep]})

    def zone_of(m):
        x, y = m[len(m) // 2]
        gx, gy = int(x // G), int(y // G)
        best = None
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                for a, b, z in axis_grid.get((gx + i, gy + j), ()):
                    d = (x - a) ** 2 + (y - b) ** 2
                    if d < 60 * 60 and (best is None or d < best[0]):
                        best = (d, z)
        return best[1] if best else None

    out_lanes = []
    for w, m in zip(lanes, lanes_m):
        if len(m) < 2:
            continue
        keep = simplify(m, 0.3)
        enc, px, py = [], 0, 0  # mismo formato que los recorridos: enteros ×1e6 por diferencias
        for k in keep:
            x, y = round(m[k][0] / KX * E6), round(m[k][1] / KY * E6)
            enc.extend((x - px, y - py))
            px, py = x, y
        out_lanes.append({'z': zone_of(m), 'd': enc})
    cov = sum(1 for s in out_segs if s.get('osm'))
    log(f'guía a nivel de calle: {len(out_lanes)} carriles de OSM; {cov} de {len(out_segs)} tramos del eje cubiertos')
    return out_segs, out_lanes


LEVEL_M = 5.5  # altura de un nivel de puente (m), como en el simulador
DECK_M = 0.8  # grosor del tablero
SLOPE = 0.07  # pendiente de las rampas


def smooth01(u: float) -> float:
    u = max(0.0, min(1.0, u))
    return u * u * (3 - 2 * u)


def bridge_structures(busway, roads=None):
    """Puentes y deprimidos de la calzada exclusiva para el 3D, como piezas con su altura por vértice
    (ver `_elevate`), y los puentes viales que van con la troncal (`road_companions`). Los deprimidos
    llevan `k: 'tunel'` y, donde OSM dice que pasan bajo una calle, `cov`."""
    pieces = _elevate(busway, 1)
    tunnels = _elevate(busway, -1)
    for pc in tunnels:
        pc['k'] = 'tunel'
    if roads:
        pieces += road_companions(pieces, roads)
    pieces += tunnels
    out = []
    for pc in pieces:
        pts = pc['pts']
        # Solo se simplifica en planta un tramo de altura constante: en una rampa, cada vértice lleva su
        # cota (en un tramo recto, la simplificación dejaría solo los extremos y lo aplanaría).
        flat = max(pc['z']) - min(pc['z']) < 0.05
        keep = sorted(set(simplify(pts, 0.2)) | {0, len(pts) - 1}) if flat else list(range(len(pts)))
        enc, px, py = [], 0, 0
        for k in keep:
            X, Y = round(pts[k][0] / KX * E6), round(pts[k][1] / KY * E6)
            enc.extend((X - px, Y - py))
            px, py = X, Y
        o = {'w': round(pc['w'], 1), 'z': [round(pc['z'][k], 2) for k in keep], 'd': enc}
        if pc.get('k'):
            o['k'] = pc['k']
        if pc.get('cov'):
            o['cov'] = 1
        out.append(o)
    return out


def drop_zones(pieces, zones):
    """Quita las piezas (ya codificadas) de las zonas curadas sin 3D (`zonas_sin_3d` de
    structure_overrides.json): las que tienen un vértice en el círculo y, por sus empalmes en alto
    (extremos a ≤ 2 m con z > 0,3), el resto de la misma estructura (rampas que siguen fuera del
    círculo y quedarían colgando). Devuelve las piezas que quedan y cuántas se quitaron por zona."""
    def verts(pc):
        X = Y = 0
        out = []
        for k in range(0, len(pc['d']), 2):
            X += pc['d'][k]
            Y += pc['d'][k + 1]
            out.append((X / E6 * KX, Y / E6 * KY))
        return out
    V = [verts(pc) for pc in pieces]
    gone, count = set(), {}
    for zn in zones:
        cx, cy = xy(*zn['centro'])
        hit = {i for i, vs in enumerate(V) if any(math.hypot(x - cx, y - cy) <= zn['radio_m'] for x, y in vs)}
        todo = list(hit)
        while todo:
            i = todo.pop()
            ends_i = [(V[i][0], pieces[i]['z'][0]), (V[i][-1], pieces[i]['z'][-1])]
            for j, vs in enumerate(V):
                if j in hit:
                    continue
                for (p, zi) in ends_i:
                    for q, zj in ((vs[0], pieces[j]['z'][0]), (vs[-1], pieces[j]['z'][-1])):
                        if math.hypot(p[0] - q[0], p[1] - q[1]) <= 2 and max(zi, zj) > 0.3:
                            hit.add(j)
                            todo.append(j)
                            break
                    if j in hit:
                        break
        count[zn['lugar']] = len(hit - gone)
        gone |= hit
    return [pc for i, pc in enumerate(pieces) if i not in gone], count


def _elevate(busway, sign):
    """Tramos elevados (`sign` = 1) o deprimidos (−1) de la calzada exclusiva, con su altura por vértice.

    La regla del simulador (traffic.mjs, `elevate`), que ya había corregido este error: «antes [las
    rampas] iban siempre fuera y la de Comuneros empezaba 157 m antes, dentro de la estación».

    - Los tramos de puente del mismo nivel que comparten un extremo forman un conjunto (la glorieta de la
      Calle 6 con NQS son seis tramos y sus accesos); un carril sin puente de menos de 40 m entre dos
      tramos de puente se cierra a su altura (una curva que no casó con la vía de OSM).
    - Rampas dentro del puente cuando caben: si el conjunto alcanza el 75 % de su altura subiendo desde
      sus extremos libres, cada punto va a la altura de la rampa (pendiente máxima del 7 %, suavizada)
      según su distancia, por el conjunto, al extremo libre más cercano.
    - Si no caben (un puente corto sobre una calle), el puente va entero a su altura y las rampas bajan
      fuera, por el carril de OSM que sigue en el mismo sentido.

    5,5 m por nivel; ancho por los carriles (3,4 m por carril + 1 m)."""
    import heapq
    lanes = busway['lanes']
    lane_by_id = {l['id']: l for l in lanes}
    R_PER_M = 1.5 / SLOPE  # rampa suavizada (smoothstep) con pendiente máxima del 7 %: largo 1,5·H/0,07
    items = []
    for st in busway['structures']:
        if st['kind'] != ('bridge' if sign > 0 else 'tunnel') or (st.get('level') or 0) * sign <= 0 or len(st['c']) < 2:
            continue
        pts = [xy(lo, la) for lo, la in st['c']]
        if sum(math.hypot(bx - ax, by - ay) for (ax, ay), (bx, by) in zip(pts, pts[1:])) < 2:
            continue
        items.append({'id': st['id'], 'pts': pts, 'lv': st['level'], 'cov': st.get('grade') == 'underpass',
                      'w': 3.4 * ((lane_by_id.get(st['id']) or {}).get('lanes') or 1) + 1.0})
    key = lambda p: (round(p[0]), round(p[1]))
    bridge_ids = {it['id'] for it in items}
    ends_of = defaultdict(list)  # extremo → niveles de los tramos de puente que llegan
    for it in items:
        for p in (it['pts'][0], it['pts'][-1]):
            ends_of[key(p)].append(it['lv'])
    # Huecos: carriles sin puente de menos de 40 m que unen dos extremos de puente.
    filled = 0
    for l in lanes:
        if l['id'] in bridge_ids or len(l['c']) < 2:
            continue
        c = [xy(lo, la) for lo, la in l['c']]
        L = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(c, c[1:]))
        a, b = ends_of.get(key(c[0])), ends_of.get(key(c[-1]))
        if L < 40 and a and b:
            # El hueco va al nivel más cercano al suelo de los dos (el más bajo de dos puentes, el menos hondo
            # de dos deprimidos).
            lv = min(min(a), min(b)) if sign > 0 else max(max(a), max(b))
            items.append({'id': l['id'], 'pts': c, 'lv': lv, 'w': 3.4 * (l.get('lanes') or 1) + 1.0})
            filled += 1
    for it in items:
        it['H'] = LEVEL_M * it['lv']
        it['L'] = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(it['pts'], it['pts'][1:]))
    # Red de puentes: nodos por extremo; distancia de cada nodo al extremo libre más cercano.
    adj = defaultdict(list)
    for i, it in enumerate(items):
        it['a'], it['b'] = key(it['pts'][0]), key(it['pts'][-1])
        adj[it['a']].append((it['b'], it['L'], i))
        adj[it['b']].append((it['a'], it['L'], i))
    dist = {}
    heap = [(0.0, n) for n, e in adj.items() if len(e) == 1]
    while heap:
        d, n = heapq.heappop(heap)
        if n in dist:
            continue
        dist[n] = d
        for m, w, _ in adj[n]:
            if m not in dist:
                heapq.heappush(heap, (d + w, m))
    # Conjuntos conectados; ¿caben las rampas dentro? (el 75 % de su altura).
    comp = {}
    for start in adj:
        if start in comp:
            continue
        cid, stack = len(set(comp.values())), [start]
        comp[start] = cid
        while stack:
            n = stack.pop()
            for m, _, _ in adj[n]:
                if m not in comp:
                    comp[m] = cid
                    stack.append(m)
    top, reach = defaultdict(float), defaultdict(float)
    for it in items:
        cid = comp[it['a']]
        H, R = abs(it['H']), R_PER_M * abs(it['H'])
        d0, d1 = dist.get(it['a'], 1e6), dist.get(it['b'], 1e6)
        far = min(max(d0, d1), (d0 + d1 + it['L']) / 2)  # el punto del tramo más lejos de un extremo libre
        top[cid] = max(top[cid], H)
        reach[cid] = max(reach[cid], H * smooth01(far / R))
    good = {cid: reach[cid] >= 0.75 * top[cid] for cid in top}
    # Extremos de los carriles sin puente, para las rampas de fuera.
    ends = defaultdict(list)
    for l in lanes:
        if l['id'] in bridge_ids or len(l['c']) < 2:
            continue
        c = [xy(lo, la) for lo, la in l['c']]
        ends[key(c[0])].append(c)
        ends[key(c[-1])].append(c[::-1])

    def walk(start, R):
        cands = ends.get(key(start)) or []
        if not cands:
            return None
        c = max(cands, key=lambda q: len(q))
        out, acc = [c[0]], 0.0
        for a, b in zip(c, c[1:]):
            l = math.hypot(b[0] - a[0], b[1] - a[1])
            if acc + l >= R:
                f = (R - acc) / l
                out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
                return out
            out.append(b)
            acc += l
        return out

    # Uniones entre tramos de distinto nivel (un acceso de nivel 1 que llega a una glorieta de nivel 2, una
    # trinchera de 3 m que entra a un túnel de 5,5 m): la cota en la unión es la del más bajo, y el más alto
    # sube (o baja) desde ahí con la misma rampa. Sin esto, cada tramo iba a su propia altura y en la unión
    # quedaba un escalón (fondos y muros en cuña a la salida de Museo Nacional, revisión del 6 nov.).
    levels_at = defaultdict(set)
    for it in items:
        levels_at[it['a']].add(abs(it['H']))
        levels_at[it['b']].add(abs(it['H']))
    anchors = defaultdict(list)  # cota de la unión → nodos
    for n, hs in levels_at.items():
        if len(hs) > 1:
            anchors[min(hs)].append(n)
    dist_h = {}
    for h, nodes in anchors.items():
        dh, heap = {}, [(0.0, n) for n in nodes]
        while heap:
            d, n = heapq.heappop(heap)
            if n in dh:
                continue
            dh[n] = d
            for m, w, _ in adj[n]:
                if m not in dh:
                    heapq.heappush(heap, (d + w, m))
        dist_h[h] = dh

    def joints(it, s, L, za):
        """Cota (en valor absoluto) limitada por las uniones con tramos más bajos."""
        Ha = abs(it['H'])
        for h, dh in dist_h.items():
            if h >= Ha:
                continue
            d = min(dh.get(it['a'], 1e6) + s, dh.get(it['b'], 1e6) + L - s)
            za = min(za, h + (Ha - h) * smooth01(d / (R_PER_M * (Ha - h))))
        return za

    pieces = []
    inside = outside = 0
    for it in items:
        H, R = it['H'], R_PER_M * abs(it['H'])
        sg = 1 if H > 0 else -1
        dense = densify(it['pts'], 4.0)
        cum = [0.0]
        for (ax, ay), (bx, by) in zip(dense, dense[1:]):
            cum.append(cum[-1] + math.hypot(bx - ax, by - ay))
        L = cum[-1]
        d0, d1 = dist.get(it['a'], 1e6), dist.get(it['b'], 1e6)
        if good[comp[it['a']]]:
            inside += 1
            z = [sg * joints(it, s, L, abs(H) * smooth01(min(d0 + s, d1 + L - s) / R)) for s in cum]
            pieces.append({'pts': dense, 'z': z, 'w': it['w'], 'cov': it.get('cov', False)})
            continue
        outside += 1
        pieces.append({'pts': dense, 'z': [sg * joints(it, s, L, abs(H)) for s in cum], 'w': it['w'], 'cov': it.get('cov', False)})
        for end, dd in ((0, d0), (-1, d1)):
            if dd > 0.5:
                continue  # sigue otro tramo del conjunto
            ramp = walk(it['pts'][end], R)
            if ramp and len(ramp) >= 2:
                rd = densify(ramp, 4.0)
                rc = [0.0]
                for (ax, ay), (bx, by) in zip(rd, rd[1:]):
                    rc.append(rc[-1] + math.hypot(bx - ax, by - ay))
                pieces.append({'pts': rd, 'z': [H * smooth01(1 - s / R) for s in rc], 'w': it['w']})
    log(f"{'puentes' if sign > 0 else 'deprimidos'}: {len(items)} tramos ({filled} huecos cerrados); rampas dentro en {inside}, fuera en {outside}")
    return pieces


ROAD_LANE_M = 3.4  # ancho de un carril de la vía de carros
ROAD_EDGE_M = 1.0  # bordes y barrera
COMPANION_GAP_M = 6.0  # a lo sumo, entre el borde del tablero de la troncal y el de la vía


def road_companions(pieces, roads):
    """Puentes de la vía de carros que son la misma estructura que el de la troncal (H7).

    En la Calle 80, la NQS, la Calle 6 o la Autopista Norte el carril de TransMilenio va en el mismo
    puente que los carriles mixtos: dibujar solo el de la troncal dejaba una franja angosta en el aire.
    Un puente vial de OSM (data/curated/road_bridges.json) va con la troncal si corre a su lado, en su
    sentido (|cos| ≥ 0,95) y con a lo sumo 6 m entre los bordes de los dos tableros, en al menos el 60 %
    de su largo. Entonces se dibuja entero:

    - a la altura del tablero de la troncal en cada punto (sube y baja con sus rampas);
    - de borde a borde: el interior contra el tablero de la troncal (el hueco entre los dos se cierra) y
      el exterior donde va la vía (ancho por carriles, 3,4 m cada uno, más 1 m de bordes);
    - el tramo continuo que acompaña al de la troncal y, más allá del puente de OSM (la vía sigue en
      terraplén), junto a las rampas de la troncal hasta el suelo; si no baja, un estribo.

    Las barandas de los dos tableros quedan juntas: la barrera entre el carril exclusivo y los mixtos.
    """
    G = 50
    grid = defaultdict(list)
    for pi, pc in enumerate(pieces):
        P, Z = pc['pts'], pc['z']
        for j in range(1, len(P)):
            if Z[j - 1] < 0.5 and Z[j] < 0.5:
                continue
            (ax, ay), (bx, by) = P[j - 1], P[j]
            for gx in range(int((min(ax, bx) - 30) // G), int((max(ax, bx) + 30) // G) + 1):
                for gy in range(int((min(ay, by) - 30) // G), int((max(ay, by) + 30) // G) + 1):
                    grid[(gx, gy)].append((pi, j))

    def near(p, h):
        best = None
        for pi, j in grid.get((int(p[0] // G), int(p[1] // G)), ()):
            P, Z = pieces[pi]['pts'], pieces[pi]['z']
            (ax, ay), (bx, by) = P[j - 1], P[j]
            dx, dy = bx - ax, by - ay
            l2 = dx * dx + dy * dy
            if l2 < 1e-6 or abs((dx * h[0] + dy * h[1]) / math.sqrt(l2)) < 0.95:
                continue
            f = max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2))
            qx, qy = ax + f * dx, ay + f * dy
            d = math.hypot(p[0] - qx, p[1] - qy)
            if d <= 30 and (best is None or d < best[0]):
                best = (d, (qx, qy), Z[j - 1] + (Z[j] - Z[j - 1]) * f, pieces[pi]['w'])
        return best

    # Un mismo puente viene en varios tramos de OSM (se parten en cada cambio de etiqueta): se unen los
    # que siguen uno tras otro con el mismo nombre y sentido, para que el tablero no tenga cortes (Cra 30
    # con Calle 13).
    def chains(ways):
        ways = [dict(w, points=list(w['points'])) for w in ways]
        key = lambda p: (round(p[0], 5), round(p[1], 5))
        merged = True
        while merged:
            merged = False
            starts = {}
            for i, w in enumerate(ways):
                starts.setdefault(key(w['points'][0]), []).append(i)
            for i, w in enumerate(ways):
                if w is None:
                    continue
                for j in starts.get(key(w['points'][-1]), []):
                    o = ways[j]
                    if j == i or o is None or o.get('name') != w.get('name'):
                        continue
                    (ax, ay), (bx, by) = xy(*w['points'][-2]), xy(*w['points'][-1])
                    (cx, cy), (dx, dy) = xy(*o['points'][0]), xy(*o['points'][1])
                    l1, l2 = math.hypot(bx - ax, by - ay) or 1, math.hypot(dx - cx, dy - cy) or 1
                    if ((bx - ax) * (dx - cx) + (by - ay) * (dy - cy)) / (l1 * l2) < 0.8:
                        continue
                    w['points'] += o['points'][1:]
                    w['lanes'] = max(w['lanes'], o['lanes'])
                    ways[j] = None
                    merged = True
                    break
            ways = [w for w in ways if w is not None]
        return ways

    out, names = [], Counter()
    for r in chains(roads):
        P = densify([xy(lo, la) for lo, la in r['points']], 4.0)
        if len(P) < 3:
            continue
        W = r['lanes'] * ROAD_LANE_M + ROAD_EDGE_M
        hits = []
        for k, p in enumerate(P):
            a, b = P[max(0, k - 1)], P[min(len(P) - 1, k + 1)]
            dx, dy = b[0] - a[0], b[1] - a[1]
            l = math.hypot(dx, dy) or 1
            x = near(p, (dx / l, dy / l))
            # Al lado (no encima: eso sería el mismo carril) y con poco hueco entre los bordes.
            ok = x and x[0] >= x[3] / 2 + 1.5 and x[0] - W / 2 - x[3] / 2 <= COMPANION_GAP_M
            hits.append(x if ok else None)
        if sum(1 for x in hits if x) < 0.6 * len(P):
            continue
        # El tramo continuo más largo que acompaña al de la troncal.
        best, cur = (0, 0), None
        for k, x in enumerate(hits + [None]):
            if x and cur is None:
                cur = k
            elif not x and cur is not None:
                if k - cur > best[1] - best[0]:
                    best = (cur, k)
                cur = None
        run = list(range(*best))
        if len(run) < 3:
            continue
        # Ancho: del borde del tablero de la troncal al borde exterior de la vía (mediana del tramo).
        wt = hits[run[0]][3]
        outer = sorted(hits[k][0] + W / 2 for k in run)[len(run) // 2]
        Wc = min(20.0, outer - wt / 2)
        if Wc < 3:
            continue
        off = wt / 2 + Wc / 2
        pts, zs = [], []
        for k in run:
            d, (qx, qy), z, _ = hits[k]
            ux, uy = (P[k][0] - qx) / d, (P[k][1] - qy) / d
            pts.append((qx + ux * off, qy + uy * off))
            zs.append(z)

        def extend(p, prev, d_end):
            # Más allá del puente de OSM la vía sigue en terraplén junto a la rampa de la troncal: se
            # prolonga en línea recta, al lado del tablero de la troncal y a su altura, hasta el suelo
            # (o 150 m como mucho).
            hx, hy = p[0] - prev[0], p[1] - prev[1]
            l = math.hypot(hx, hy) or 1
            hx, hy = hx / l, hy / l
            more, cur = [], p
            for _ in range(int(150 // 4)):
                cur = (cur[0] + hx * 4, cur[1] + hy * 4)
                x = near(cur, (hx, hy))
                # Se corta si la troncal se aparta de la recta (una rampa que entra a la estación): la vía
                # ya no va al lado y el tablero se torcía en cuña.
                if not x or x[2] < 0.3 or abs(x[0] - d_end) > 1.5:
                    break
                (qx, qy) = x[1]
                ux, uy = (cur[0] - qx) / x[0], (cur[1] - qy) / x[0]
                more.append(((qx + ux * off, qy + uy * off), x[2]))
            return more

        head = extend(P[run[0]], P[run[1]], hits[run[0]][0])[::-1]
        tail = extend(P[run[-1]], P[run[-2]], hits[run[-1]][0])
        pts = [q for q, _ in head] + pts + [q for q, _ in tail]
        zs = [z for _, z in head] + zs + [z for _, z in tail]
        out.append({'pts': pts, 'z': zs, 'w': Wc, 'k': 'via'})
        names[r.get('name') or str(r['id'])] += 1
    log(f'puentes viales con la troncal: {len(out)} ({", ".join(f"{n} {c}" for n, c in names.most_common())})')
    return out


def chaikin(pts, iterations: int = 3):
    """Suaviza una polilínea cortando esquinas (Chaikin); conserva los extremos."""
    for _ in range(iterations):
        if len(pts) < 3:
            return pts
        out = [pts[0]]
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            out.append((0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by))
            out.append((0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by))
        out.append(pts[-1])
        pts = out
    return pts


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
    s = re.sub(r'(?<=\s)(De|Del|Y)(?=\s)', lambda m: m.group(1).lower(), s)
    s = re.sub(r'\b(\d+)([a-z])\b', lambda m: m.group(1) + m.group(2).upper(), s)
    return s.replace('Av.. ', 'Av. ')


def short(name: str) -> str:
    """Nombre corto de estación, sin el patrocinador: «Portal Sur - JFK Coop. Financiera» → «Portal Sur»."""
    return re.split(r'\s+[-–]\s+', name, maxsplit=1)[0].strip()


def strip_code(part: str, codes: set[str]) -> str:
    """«H710 El Progreso» → «El Progreso» cuando H710 es un código de ruta."""
    m = re.match(r'^([A-Z]{0,3}\d+[A-Z]?|[A-Z]\d+-?[A-Z]?\d*)\s+(.*)$', part.strip())
    # Solo códigos con letra: «7 de Agosto» es un destino, no la ruta 7.
    if m and re.search(r'[A-Z]', m.group(1)) and (m.group(1) in codes or re.match(r'^[A-Z]{1,3}\d', m.group(1))):
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
    # Lo que había en la carpeta (en CI, lo publicado) se guarda para comparar al final.
    import shutil
    import tempfile
    prev = Path(tempfile.mkdtemp(prefix='red-anterior-'))
    for f in ('network.json', 'patterns.json', 'stops.json', 'changes.json', 'meta.json'):
        if (out / f).exists():
            shutil.copy(out / f, prev / f)
    # Revisión de lo curado: lo que no se actualiza solo con el paquete del día.
    review: list[str] = []
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

    # ── Calzada exclusiva (OSM): recorridos troncales y duales sobre su carril (F7.6) ──────────
    bw_path = ROOT / 'data' / 'curated' / 'busway.json'
    lane_idx = None
    busway = None
    if bw_path.exists():
        busway = json.loads(bw_path.read_text())
        lane_idx = bw.LaneIndex(busway['lanes'], xy)
        on_busway = {shape_of_route[r['route_id']] for r in routes
                     if r['agency_id'] in ('1', '6') and r['route_id'] in shape_of_route}
        tot_len = snapped_len = 0.0
        for sid in on_busway:
            if sid not in shapes:
                continue
            ll, m, cum = shapes[sid]
            pts, frac = bw.snap_path(m, lane_idx)
            keep = simplify(pts, 1.0)
            m2 = [pts[i] for i in keep]
            shapes[sid] = ([(x / KX, y / KY) for x, y in m2], m2, cumulative(m2))
            tot_len += cum[-1]
            snapped_len += cum[-1] * frac
        log(f'calzada exclusiva: {len(on_busway)} recorridos, {snapped_len / max(tot_len, 1) * 100:.0f} % de su largo sobre el carril de OSM')
        if tot_len and snapped_len / tot_len < 0.8:
            review.append(f'Solo {snapped_len / tot_len * 100:.0f} % del largo troncal y dual va sobre la calzada de OSM (era 88 %): actualizar `busway.json` con `tools/import_busway.py`.')

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

    # ── Corredores ───────────────────────────────────────────────────────────────────────────
    # Los vagones troncales llevan la letra de su corredor en el código («B096» → Autonorte). Una
    # estación de cruce tiene varias; el tramo entre dos estaciones toma la letra que comparten.
    letters_of: dict[str, set] = defaultdict(set)
    for s in stops:
        par = s.get('parent_station')
        m = re.match(r'^([A-HJ-MS])\d{2,4}T?$', s.get('stop_code') or '')
        if par and m:
            letters_of[par].add(m.group(1))

    # Estaciones cuyos vagones no traen letra (casi toda la Caracas central): la letra de su troncal
    # desde la lista curada (data/curated/station_corridors.json).
    curated_letters = json.loads((ROOT / 'data' / 'curated' / 'station_corridors.json').read_text())['stations']
    for st_id, z_ in curated_letters.items():
        if not letters_of.get(st_id):
            letters_of[st_id] = {z_}

    unknown_letters = {zz for ls in letters_of.values() for zz in ls if zz not in palette['zones']}
    if unknown_letters:
        review.append(f"Letras de troncal sin color en la paleta: {', '.join(sorted(unknown_letters))} (`data/curated/palette.json`).")

    def letters(si: int) -> set:
        sid = stops[si]['stop_id']
        return letters_of.get(parent.get(sid, sid), set())

    corridor_segments: dict[tuple, dict] = {}

    def route_letters(pat) -> list:
        """Letra de corredor de cada tramo del patrón. Primero la que comparten las dos estaciones (o la
        única que tiene una si la otra no tiene ninguna); luego los tramos sin letra la toman de sus
        vecinos sobre la misma ruta, si coinciden o si solo uno la tiene."""
        out = []
        for k in range(len(pat) - 1):
            a, b = letters(pat[k]), letters(pat[k + 1])
            common = a & b
            if len(common) == 1:
                out.append(next(iter(common)))
            elif not common and len(a) == 1 and not b:
                out.append(next(iter(a)))
            elif not common and len(b) == 1 and not a:
                out.append(next(iter(b)))
            else:
                out.append(None)
        for _ in range(3):
            for k, z in enumerate(out):
                if z:
                    continue
                left = next((out[j] for j in range(k - 1, -1, -1) if out[j]), None)
                right = next((out[j] for j in range(k + 1, len(out)) if out[j]), None)
                if left and right and left == right:
                    out[k] = left
                elif left and not right:
                    out[k] = left
                elif right and not left:
                    out[k] = right
        return out

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
        if sys_key == 'troncal' and not zl and pat_count.get(ri):
            # Servicios numerados: el color de la troncal de su destino (no blanco: se confundía
            # con las estaciones). Si la estación de destino es de cruce, la del último tramo conocido.
            seq = route_letters(pat_count[ri].most_common(1)[0][0])
            zl_dest = next((z for z in reversed(seq) if z), None)
            color = palette['zones'][zl_dest]['color'] if zl_dest in palette['zones'] else palette['numbered']
        elif sys_key in ('troncal', 'dual'):
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
            if sys_key == 'troncal' and shp and len(stops_s) == len(pat):
                seq = route_letters(pat)
                for k in range(len(pat) - 1):
                    letter = seq[k]
                    pa = parent.get(stops[pat[k]]['stop_id'], stops[pat[k]]['stop_id'])
                    pb = parent.get(stops[pat[k + 1]]['stop_id'], stops[pat[k + 1]]['stop_id'])
                    key = tuple(sorted((pa, pb)))
                    if key in corridor_segments or pa == pb:
                        continue
                    s0, s1 = stops_s[k], stops_s[k + 1]
                    if s1 - s0 < 5 or s1 - s0 > 6000:
                        continue
                    ll, m, cum = shp
                    seg = [p for p, c in zip(ll, cum) if s0 <= c <= s1]
                    if len(seg) < 2:
                        continue
                    corridor_segments[key] = {'z': letter, 'c': [[round(x, 6), round(y, 6)] for x, y in seg]}
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
    # Huellas de estación (F7.7): el edificio o las plataformas de OSM; si no hay, una estimada entre
    # los carriles de los dos sentidos con el largo de sus vagones.
    fp_osm = {s['id']: s for s in (busway or {}).get('stations', [])}
    # Andenes trazados a mano (data/curated/station_overrides.json): mandan sobre OSM y la estimación.
    ov_p = ROOT / 'data' / 'curated' / 'station_overrides.json'
    fp_traced = json.loads(ov_p.read_text())['stations'] if ov_p.exists() else {}
    n_fp = Counter()
    # Tramos en obra (data/curated/obras.json): sus estaciones son provisionales y no se modelan.
    obras_p = ROOT / 'data' / 'curated' / 'obras.json'
    obras = [(z, [xy(lo, la) for lo, la in z['line']]) for z in (json.loads(obras_p.read_text())['zones'] if obras_p.exists() else [])]
    # Las definitivas que ya operan dentro del tramo (Calle 26 - Atrio, Calle 72 - Areandina) se modelan.
    definitive = {d['id'] for z, _ in obras for d in z.get('definitivas', [])}

    def in_works(lon, lat, sid=None):
        if sid in definitive:
            return None
        p = xy(lon, lat)
        for z, line in obras:
            for (ax, ay), (bx, by) in zip(line, line[1:]):
                dx, dy = bx - ax, by - ay
                f = max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy)))
                if math.hypot(p[0] - ax - f * dx, p[1] - ay - f * dy) <= z['buffer_m']:
                    return z['id']
        return None
    provisional = []

    # Calzada exclusiva con su ancho (3,4 m por carril alrededor del eje de la vía de OSM): un andén no
    # puede pisarla. Rejilla de tramos para medir y corregir.
    LANE_W = 3.4
    carriage = defaultdict(list)
    if busway:
        for w in busway['lanes']:
            hw = LANE_W * (w.get('lanes') or 1) / 2
            pts = [xy(lo, la) for lo, la in w['c']]
            for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                for gx in range(int(min(ax, bx) // 40) - 1, int(max(ax, bx) // 40) + 2):
                    for gy in range(int(min(ay, by) // 40) - 1, int(max(ay, by) // 40) + 2):
                        carriage[(gx, gy)].append((ax, ay, bx, by, hw))

    def seg_d(px, py, ax, ay, bx, by):
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy or 1e-9
        f = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
        return math.hypot(px - ax - f * dx, py - ay - f * dy)

    def on_carriage(px, py) -> bool:
        return any(seg_d(px, py, *s[:4]) < s[4] - 0.5 for s in carriage.get((int(px // 40), int(py // 40)), ()))

    def pip(x, y, q):
        c = False
        for i in range(len(q)):
            (xi, yi), (xj, yj) = q[i], q[i - 1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                c = not c
        return c

    def over_fraction(poly) -> float:
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        n = k = 0
        x = min(xs)
        while x <= max(xs):
            y = min(ys)
            while y <= max(ys):
                if pip(x, y, poly):
                    n += 1
                    k += on_carriage(x, y)
                y += 1.0
            x += 1.0
        return k / n if n else 1.0

    def frame(poly):
        """Centro, eje (unitario), normal, largo y ancho de un andén (por su lado más largo)."""
        pts = poly[:-1] if poly[0] == poly[-1] else poly
        cx, cy = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
        best = max(zip(pts, pts[1:] + pts[:1]), key=lambda e: math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1]))
        ux, uy = best[1][0] - best[0][0], best[1][1] - best[0][1]
        l = math.hypot(ux, uy) or 1.0
        ux, uy = ux / l, uy / l
        nx, ny = -uy, ux
        a = [(p[0] - cx) * ux + (p[1] - cy) * uy for p in pts]
        b = [(p[0] - cx) * nx + (p[1] - cy) * ny for p in pts]
        return (cx, cy), (ux, uy), (nx, ny), max(a) - min(a), max(b) - min(b)

    def fit_lateral(poly):
        """Corrimiento de lado (m, sobre la normal) para que el andén quede fuera de la calzada: entre
        dos calzadas, centrado; junto a una, con su borde a 0,3 m. Como fitIslandNow del simulador."""
        (cx, cy), (ux, uy), (nx, ny), L, W = frame(poly)
        shifts = []
        t = -L / 2 + 4
        while t <= L / 2 - 4 + 1e-6:
            px, py = cx + ux * t, cy + uy * t
            left, right = math.inf, -math.inf
            for ax, ay, bx, by, hw in carriage.get((int(px // 40), int(py // 40)), ()):
                dx, dy = bx - ax, by - ay
                l = math.hypot(dx, dy)
                if l < 1e-6 or abs((dx * ux + dy * uy) / l) < 0.9:
                    continue
                f = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (l * l)))
                qx, qy = ax + f * dx, ay + f * dy
                if abs((qx - px) * ux + (qy - py) * uy) > 3:
                    continue
                d = (qx - px) * nx + (qy - py) * ny
                if abs(d) > 15:
                    continue
                if d > 0:
                    left = min(left, d - hw)
                else:
                    right = max(right, d + hw)
            if left < math.inf and right > -math.inf:
                shifts.append((left + right) / 2)
            elif left < math.inf:
                shifts.append(min(0.0, left - W / 2 - 0.3))
            elif right > -math.inf:
                shifts.append(max(0.0, right + W / 2 + 0.3))
            t += max(4.0, (L - 8) / 6)
        if not shifts:
            return None
        shifts.sort()
        sh = shifts[len(shifts) // 2]
        return sh if abs(sh) <= 6 else None

    def place_platforms(polys_m):
        """Andenes que no pisan la calzada (≤ 10 % de su superficie); los que la pisan, corridos de lado si
        así quedan bien; si no, fuera. Devuelve (aceptados, corridos)."""
        ok, moved = [], 0
        for poly in polys_m:
            if over_fraction(poly) <= 0.10:
                ok.append(poly)
                continue
            sh = fit_lateral(poly)
            if sh is None:
                continue
            (_, _), _, (nx, ny), _, _ = frame(poly)
            q = [(x + nx * sh, y + ny * sh) for x, y in poly]
            if over_fraction(q) <= 0.10:
                ok.append(q)
                moved += 1
        return ok, moved

    def modules(ring, wagons):
        """La huella estimada (un rectángulo entre los carriles) partida en vagones: las paradas del GTFS
        a lo largo del eje se agrupan (más de 60 m entre grupos: en la Calle 80 los vagones a 40–50 m van
        bajo una cubierta continua) y cada grupo es un módulo."""
        (cx, cy), (ux, uy), _, L, _ = frame(ring)
        proj = sorted((wx - cx) * ux + (wy - cy) * uy for wx, wy in wagons)
        groups = []
        for v in proj:
            if groups and v - groups[-1][1] <= 60:
                groups[-1][1] = v
            else:
                groups.append([v, v])
        if len(groups) < 2:
            return [ring]
        pts = ring[:-1]
        a = [(p[0] - cx) * ux + (p[1] - cy) * uy for p in pts]
        a0, a1 = min(a), max(a)
        out = []
        for g0, g1 in groups:
            s0, s1 = max(a0, g0 - 16), min(a1, g1 + 16)
            if s1 - s0 < 12:
                continue
            q = []
            for p in pts:
                along = (p[0] - cx) * ux + (p[1] - cy) * uy
                t = s0 if along < (a0 + a1) / 2 else s1
                q.append((p[0] + ux * (t - along), p[1] + uy * (t - along)))
            out.append(q + [q[0]])
        return out or [ring]

    def footprint(s, kind: str) -> dict:
        """Andenes y cubiertas de la estación. De OSM (andenes o islas, vía el simulador), validados
        contra la calzada; la huella se acepta solo si su centro queda a ≤ 120 m de los vagones (o del
        punto de la estación si no tiene). Si no hay, una estimada entre los carriles, por vagones."""
        sid = s['stop_id']
        wagons = [stop_xy[stop_ix[k['stop_id']]] for k in kids.get(sid, [])]
        ref = (sum(p[0] for p in wagons) / len(wagons), sum(p[1] for p in wagons) / len(wagons)) if wagons else stop_xy[stop_ix[sid]]

        def near(rings_m) -> bool:
            pts = [p for r in rings_m for p in r[:-1]]
            cx, cy = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
            return math.hypot(cx - ref[0], cy - ref[1]) <= (300 if kind == 'portal' else 120)  # un portal ocupa una manzana

        def out(rings_m, roofs_m, fpk):
            r = lambda ring: [[round(x / KX, 6), round(y / KY, 6)] for x, y in ring]
            return {'fp': [r(q) for q in rings_m], **({'roof': [r(q) for q in roofs_m]} if roofs_m else {}), 'fpk': fpk}

        if sid in fp_traced:
            rings = [[xy(lo, la) for lo, la in poly] for poly in fp_traced[sid]['platforms']]
            rings = [q + [q[0]] if q[0] != q[-1] else q for q in rings]
            roofs = [[xy(lo, la) for lo, la in poly] for poly in (fp_osm.get(sid) or {}).get('roofs') or []]
            roofs = [q + [q[0]] if q[0] != q[-1] else q for q in roofs]
            if kind != 'portal':
                over = max(over_fraction(q) for q in rings)
                if over > 0.10:
                    review.append(f"Andén trazado de {s['stop_name']} pisa la calzada ({over * 100:.0f} %): revisar station_overrides.json.")
            n_fp['trazadas'] += 1
            return out(rings, roofs, 'traced')
        if sid in fp_osm:
            src = fp_osm[sid]
            rings = [[xy(lo, la) for lo, la in poly] for poly in src['polys']]
            rings = [q + [q[0]] if q[0] != q[-1] else q for q in rings]
            if kind == 'portal':
                placed, moved = rings, 0
            else:
                placed, moved = place_platforms(rings)
            roofs = [[xy(lo, la) for lo, la in poly] for poly in src.get('roofs') or []]
            roofs = [q + [q[0]] if q[0] != q[-1] else q for q in roofs]
            if placed and near(placed):
                n_fp['osm'] += 1
                n_fp['corridos'] += moved
                n_fp['descartados'] += len(rings) - len(placed)
                # Islas: la cubierta es la isla misma (un poco más ancha al dibujar).
                return out(placed, roofs, src['kind'])
            if kind == 'portal' and roofs and near(roofs):
                # Portal sin andenes en OSM pero con su cubierta (Portal Norte): solo la cubierta.
                n_fp['solo_cubierta'] += 1
                return out([], roofs, 'roof')
            n_fp['osm_lejos'] += 1
        if lane_idx is None or kind == 'portal':
            n_fp['none'] += 1
            return {}
        # Estimada por grupos de vagones: una estación partida (Calle 161, Calle 85: dos mitades a
        # ~300 m) se estima por cada mitad, y cada grupo se centra en sus vagones (el punto del GTFS a
        # veces queda lejos: Granja, ~300 m). Grupos: vagones a menos de 120 m entre sí.
        groups = []
        for w in wagons:
            near_g = [g for g in groups if any(math.hypot(w[0] - v[0], w[1] - v[1]) < 120 for v in g)]
            merged = [w]
            for g in near_g:
                merged += g
                groups.remove(g)
            groups.append(merged)
        if not groups:
            groups = [[stop_xy[stop_ix[sid]]]]
        rings = []
        for g in groups:
            cx, cy = sum(p[0] for p in g) / len(g), sum(p[1] for p in g) / len(g)
            for ring in bw.estimate_footprints((cx, cy), g, lane_idx):
                rings += modules(ring, g)
        if not rings or not near(rings):
            n_fp['none'] += 1
            return {}
        n_fp['est'] += 1
        return out(rings, [], 'est')

    stations = []
    shifts: list[tuple[float, str]] = []
    for s in stops:
        if s['location_type'] != '1' or s['stop_id'] in shells:
            continue
        name = nice(s['stop_name'])
        kind = 'cable' if s['stop_id'].startswith('cable') else 'portal' if re.match(r'(?i)portal|terminal', name) else 'station'
        rs = sorted({routes[ri]['route_id'] for ri in stop_routes.get(stop_ix[s['stop_id']], ())})
        lon, lat = float(s['stop_lon']), float(s['stop_lat'])
        # Provisionales (tramo en obra) y cerradas: sin huella ni cuerpo; solo la marca.
        works = in_works(lon, lat, s['stop_id']) if kind != 'cable' else None
        if works:
            provisional.append(name)
        fp = footprint(s, kind) if kind != 'cable' and not works and rs else {}
        if fp:
            # El punto del GTFS a veces queda lejos de la plataforma (Calle 57: ~250 m al sur); la huella
            # sale de los vagones y de la calzada, así que el nombre y el punto van a su centro.
            rings_ll = fp['fp'] or fp.get('roof') or []
            pts = [p for ring in rings_ll for p in ring[:-1]]
            clon, clat = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
            # Una estación partida (Calle 85: dos mitades; Ricaurte: NQS y Calle 13) tiene el centro en la
            # manzana: el nombre va al punto de andén más cercano a ese centro.
            cx, cy = xy(clon, clat)
            rings_m = [[xy(lo, la) for lo, la in r] for r in rings_ll]
            def in_ring(q, r):
                c = False
                for i in range(len(r)):
                    (xi, yi), (xj, yj) = r[i], r[i - 1]
                    if (yi > q[1]) != (yj > q[1]) and q[0] < (xj - xi) * (q[1] - yi) / (yj - yi) + xi:
                        c = not c
                return c
            if not any(in_ring((cx, cy), r) for r in rings_m):
                best = None
                for r in rings_m:
                    for (ax, ay), (bx, by) in zip(r, r[1:]):
                        dx, dy = bx - ax, by - ay
                        f = max(0.0, min(1.0, ((cx - ax) * dx + (cy - ay) * dy) / (dx * dx + dy * dy or 1e-9)))
                        q = (ax + f * dx, ay + f * dy)
                        d = math.hypot(q[0] - cx, q[1] - cy)
                        if best is None or d < best[0]:
                            best = (d, q)
                if best and best[0] > 15:
                    clon, clat = best[1][0] / KX, best[1][1] / KY
            shifts.append((math.hypot((clon - lon) * KX, (clat - lat) * KY), name))
            lon, lat = clon, clat
        stations.append({
            'id': s['stop_id'], 'name': name, 'short': short(name), 'kind': kind,
            'lon': round(lon, 6), 'lat': round(lat, 6),
            'routes': rs, **({} if rs else {'closed': True}), **({'prov': works} if works else {}),
            **fp,
            'platforms': [
                {'id': k['stop_id'], 'name': clean(k['stop_name']), 'code': k['stop_code'],
                 'routes': sorted(routes[ri]['route_id'] for ri in stop_routes.get(stop_ix[k['stop_id']], ())),
                 'lon': round(float(k['stop_lon']), 6), 'lat': round(float(k['stop_lat']), 6)}
                for k in sorted(kids.get(s['stop_id'], []), key=lambda k: k['stop_name'])
            ],
        })

    # Tramos sin letra: casi todos son de expresos que saltan estaciones y van por encima de tramos
    # locales ya coloreados. Si ≥ 80 % de su largo coincide (a ≤ 12 m) con tramos con letra, se descartan
    # por duplicados; si no, toman la letra más frecuente de lo que tienen a ≤ 25 m.
    n_before = sum(1 for v in corridor_segments.values() if not v['z'])
    grid_z: dict[tuple, list] = defaultdict(list)
    GZ = 25.0
    for v in corridor_segments.values():
        if not v['z']:
            continue
        pts = [xy(lo, la) for lo, la in v['c']]
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            n = max(1, int(math.hypot(bx - ax, by - ay) // 10))
            for k in range(n + 1):
                x, y = ax + (bx - ax) * k / n, ay + (by - ay) * k / n
                grid_z[(int(x // GZ), int(y // GZ))].append((x, y, v['z']))
    dropped = 0
    for key in list(corridor_segments):
        v = corridor_segments[key]
        if v['z']:
            continue
        pts = [xy(lo, la) for lo, la in v['c']]
        samples = []
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            n = max(1, int(math.hypot(bx - ax, by - ay) // 10))
            samples += [(ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n)]
        covered = 0
        votes = Counter()
        for x, y in samples:
            best = None
            for gx in (int(x // GZ) - 1, int(x // GZ), int(x // GZ) + 1):
                for gy in (int(y // GZ) - 1, int(y // GZ), int(y // GZ) + 1):
                    for px, py, zz in grid_z.get((gx, gy), ()):
                        d = math.hypot(px - x, py - y)
                        if best is None or d < best[0]:
                            best = (d, zz)
            if best and best[0] <= 12:
                covered += 1
            if best and best[0] <= 25:
                votes[best[1]] += 1
        if samples and covered / len(samples) >= 0.8:
            del corridor_segments[key]
            dropped += 1
        elif votes:
            v['z'] = votes.most_common(1)[0][0]
    log(f'tramos de corredor: {len(corridor_segments)}; sin letra {n_before} → {sum(1 for v in corridor_segments.values() if not v["z"])} '
        f'({dropped} expresos duplicados descartados)')
    log(f'huellas de estación: {n_fp["osm"]} de OSM ({n_fp["corridos"]} andenes corridos fuera de la calzada, {n_fp["descartados"]} descartados; {n_fp["osm_lejos"]} estaciones lejanas), {n_fp["trazadas"]} trazadas a mano, {n_fp["est"]} estimadas, {n_fp["solo_cubierta"]} solo con cubierta, {n_fp["none"]} sin huella')
    if provisional:
        log(f'provisionales (tramo en obra, sin modelar): {len(provisional)}: ' + ', '.join(provisional))
    shifts.sort(reverse=True)
    if shifts:
        log(f'punto de estación al centro de la huella: mediana {shifts[len(shifts) // 2][0]:.0f} m; mayores: '
            + ', '.join(f'{n} {d:.0f} m' for d, n in shifts[:6]))

    # Paraderos: todo lo que no es estación ni vagón y tiene al menos una ruta.
    street = []
    for i, s in enumerate(stops):
        if s['location_type'] == '1' or s.get('parent_station'):
            continue
        rs = stop_routes.get(i)
        if not rs:
            continue
        # El sufijo «_TM» de los códigos de paradero es interno del paquete: se muestra sin él.
        street.append([s['stop_id'], re.sub(r'_TM$', '', s['stop_code'] or ''), clean(s['stop_name']),
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
    # Guía de troncal: los ejes curados (una línea por corredor, sobre el separador) si están; si no,
    # los tramos derivados de los recorridos (uno por sentido).
    cur = ROOT / 'data' / 'curated' / 'corridors.json'
    if cur.exists():
        segs = json.loads(cur.read_text())['segments']
        # Los ejes vienen con vértices cada ~90 m: a nivel de calle las curvas (glorietas, giros) se
        # veían como cuerdas. Chaikin (3 pasadas) las redondea; la simplificación a 0,5 m quita los
        # puntos que sobran en las rectas.
        for seg in segs:
            pts = [xy(lo, la) for lo, la in seg['c']]
            sm = chaikin(pts, 3)
            keep = simplify(sm, 0.5)
            seg['c'] = [[round(sm[i][0] / KX, 6), round(sm[i][1] / KY, 6)] for i in keep]
        log(f'guía de troncal: {len(segs)} ejes curados, {sum(len(s["c"]) for s in segs)} puntos tras suavizar')
    else:
        segs = list(corridor_segments.values())
    lanes_out = []
    if busway:
        segs, lanes_out = street_level_guide(segs, busway['lanes'])
    write('corridors.json', {'v': 1, 'hash': digest, 'segments': segs})
    if lanes_out:
        # A nivel de calle (z ≥ 15,5) la guía es la calzada exclusiva de OSM: la página la carga solo al
        # acercarse.
        write('lanes.json', {'v': 1, 'hash': digest, 'scale': E6, 'license': busway.get('license'), 'lanes': lanes_out})
    if busway:
        # Puentes de la troncal para el 3D (estructura y altura de los buses): solo con la vista 3D.
        rb_p = ROOT / 'data' / 'curated' / 'road_bridges.json'
        roads = json.loads(rb_p.read_text())['ways'] if rb_p.exists() else []
        # Excepciones: puentes viales que van aparte aunque corran junto al de la troncal.
        so_p = ROOT / 'data' / 'curated' / 'structure_overrides.json'
        so = json.loads(so_p.read_text()) if so_p.exists() else {}
        apart = {i for e in so.get('puentes_viales_aparte', []) for i in e['osm']}
        if apart:
            log(f'puentes viales aparte (curado): {len(apart)}')
        roads = [r for r in roads if r['id'] not in apart]
        pieces = bridge_structures(busway, roads)
        # Zonas sin 3D (curado): ni puentes ni deprimidos de la troncal; los buses van a nivel.
        if so.get('zonas_sin_3d'):
            pieces, dropped = drop_zones(pieces, so['zonas_sin_3d'])
            log('zonas sin 3D (curado): ' + ', '.join(f'{k} ({n} piezas)' for k, n in dropped.items()))
        # Un tramo elevado no pasa sobre un andén (el error de la Calle 6 que el simulador ya había
        # corregido): se mide y, si pasa, va a la revisión.
        over = Counter()
        fps = []
        for s in stations:
            for ring in s.get('fp') or []:
                q = [xy(lo, la) for lo, la in ring]
                xs, ys = [p[0] for p in q], [p[1] for p in q]
                fps.append((s['name'], q, (min(xs) - 3, min(ys) - 3, max(xs) + 3, max(ys) + 3)))
        for pc in pieces:
            X = Y = 0
            for k in range(0, len(pc['d']), 2):
                X += pc['d'][k]; Y += pc['d'][k + 1]
                if pc['z'][k // 2] <= 2.5:
                    continue
                x, y = X / E6 * KX, Y / E6 * KY
                for name, q, (x0, y0, x1, y1) in fps:
                    if x0 <= x <= x1 and y0 <= y <= y1:
                        inside = False
                        for i in range(len(q)):
                            (xi, yi), (xj, yj) = q[i], q[i - 1]
                            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                                inside = not inside
                        if inside:
                            over[name] += 1
        if over:
            log('puentes sobre andenes: ' + ', '.join(f'{n} ({c})' for n, c in over.most_common()))
            review.append('Tramos elevados sobre andenes de estación: ' + ', '.join(n for n, _ in over.most_common()) + ' (revisar los niveles del puente en OSM).')
        else:
            log('puentes sobre andenes: ninguno')
        # Puentes peatonales (tools/import_footbridges.py): donde la rampa llega a un andén, termina a la
        # altura del andén (0,9 m) y no en el suelo, para entrar a la estación sin escalón.
        foot = []
        fb_p = ROOT / 'data' / 'curated' / 'footbridges.json'
        plat_rings = [[xy(lo, la) for lo, la in ring] for s_ in stations for ring in (s_.get('fp') or [])]

        def near_platform(x, y):
            for q in plat_rings:
                inside_q = False
                for i in range(len(q)):
                    (xi, yi), (xj, yj) = q[i], q[i - 1]
                    if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                        inside_q = not inside_q
                if inside_q:
                    return True
                for (ax, ay), (bx, by) in zip(q, q[1:]):
                    dx, dy = bx - ax, by - ay
                    l2 = dx * dx + dy * dy or 1e-9
                    f = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / l2))
                    if math.hypot(x - ax - f * dx, y - ay - f * dy) <= 2.0:
                        return True
            return False

        # Rampas que bajan frente a la punta de un andén (2–20 m: el andén modelado es más corto que el real
        # o la rampa de OSM termina en la plazoleta de acceso): un tramo más, de la rampa al borde del andén
        # en su punta, que sube a su altura. Solo frente a la punta (no al costado, que es la pared del vagón).
        frames = []
        for q in plat_rings:
            n_ = len(q) - 1 if q[0] == q[-1] else len(q)
            cxq = sum(p_[0] for p_ in q[:n_]) / n_
            cyq = sum(p_[1] for p_ in q[:n_]) / n_
            best_l, ux, uy = 0.0, 1.0, 0.0
            for (ax, ay), (bx, by) in zip(q, q[1:]):
                l_ = math.hypot(bx - ax, by - ay)
                if l_ > best_l:
                    best_l, ux, uy = l_, (bx - ax) / l_, (by - ay) / l_
            al = [(p_[0] - cxq) * ux + (p_[1] - cyq) * uy for p_ in q]
            bl = [-(p_[0] - cxq) * uy + (p_[1] - cyq) * ux for p_ in q]
            frames.append((q, cxq, cyq, ux, uy, min(al), max(al), min(bl), max(bl)))

        def landing(x, y):
            """Punto en la punta del andén más cercano frente a (x, y), si está a 2–20 m."""
            best = None
            for q, cxq, cyq, ux, uy, a0, a1, b0, b1 in frames:
                a = (x - cxq) * ux + (y - cyq) * uy
                b = -(x - cxq) * uy + (y - cyq) * ux
                if b < b0 - 4 or b > b1 + 4:
                    continue  # al costado: no
                if a > a1:
                    d, ea = a - a1, a1
                elif a < a0:
                    d, ea = a0 - a, a0
                else:
                    continue
                if 2 <= d <= 20 and (best is None or d < best[0]):
                    bb = min(max(b, b0 + 1), b1 - 1)
                    best = (d, (cxq + ux * ea - uy * bb, cyq + uy * ea + ux * bb))
            return best[1] if best else None

        landed = linked = 0
        if fb_p.exists():
            for f in json.loads(fb_p.read_text())['footbridges']:
                pts3 = [list(p_) for p_ in f['points']]
                for end in (0, -1):
                    lo, la, z = pts3[end]
                    if z > 1.5:
                        continue
                    q = landing(*xy(lo, la))
                    if q:
                        new = [q[0] / KX, q[1] / KY, 0.9]
                        pts3 = [new] + pts3 if end == 0 else pts3 + [new]
                        linked += 1
                enc, zs, px, py = [], [], 0, 0
                for lo, la, z in pts3:
                    x, y = xy(lo, la)
                    if z < 0.9 and near_platform(x, y):
                        z, landed = 0.9, landed + 1
                    X, Y = round(lo * E6), round(la * E6)
                    enc.extend((X - px, Y - py))
                    px, py = X, Y
                    zs.append(round(z, 2))
                foot.append({'k': f['kind'], 'z': zs, 'd': enc})
            log(f'puentes peatonales: {len(foot)} piezas ({landed} puntos de rampa llevados a la altura del andén, {linked} empalmados con la punta de un andén)')
        write('structures.json', {'v': 2, 'hash': digest, 'scale': E6, 'level_m': LEVEL_M, 'deck_m': DECK_M, 'license': busway.get('license'), 'pieces': pieces, 'foot': foot})
        log(f'puentes de la troncal: {len(pieces)} piezas (tramos elevados y rampas)')
    write('stops.json', {'v': 1, 'hash': digest, 'cols': ['id', 'code', 'name', 'lon', 'lat', 'routes'], 'stops': street})
    # v2: abscisas y tiempos por diferencias (36 % menos con gzip); el cliente reconstruye los acumulados
    # (src/domain/patterns.ts).
    def delta(a):
        return [x - (a[i - 1] if i else 0) for i, x in enumerate(a)]
    patterns_v2 = {rid: {**p, 's': delta(p['s']), 't': [delta(x) if x else None for x in p['t']]} for rid, p in patterns_out.items()}
    write('patterns.json', {'v': 2, 'hash': digest, 'bands': [k for _, _, k in BANDS], 'patterns': patterns_v2})
    write('service.json', {'v': 1, 'hash': digest, 'service': service_out})
    write('meta.json', meta)

    # ── Cambios frente a lo anterior y revisión de lo curado (decisión 011) ─────────────────────
    prev_meta = diff_network.read(prev, 'meta.json')
    if prev_meta and prev_meta.get('counts', {}).get('routes'):
        # Un paquete roto (la mitad de las rutas, sin estaciones) no reemplaza lo publicado: la
        # compilación falla y la publicación de ayer sigue en línea.
        before, after = prev_meta['counts']['routes'], len(route_info)
        if after < 0.7 * before or len(stations) < 0.9 * prev_meta['counts'].get('stations', 0):
            for f in prev.iterdir():
                shutil.copy(f, out / f.name)
            raise SystemExit(f'paquete sospechoso: {after} rutas (antes {before}), {len(stations)} estaciones; se conserva lo anterior')
    summary = ROOT / '.cache' / 'cambios.md'
    summary.parent.mkdir(exist_ok=True)
    changes = diff_network.run(prev, out, summary=summary)
    today = [e for e in changes['entries'] if e['date'] == changes['updated']]
    log(f"cambios en la red: {len(today)} hoy, {len(changes['entries'])} en 60 días, {len(changes['aliases'])} alias de ids")
    new_st = {e['station'] for e in today if e['kind'] == 'station-new'}
    for s in stations:
        if s['id'] not in new_st or s['kind'] == 'cable' or s.get('prov') or s.get('closed'):
            continue  # las provisionales y las cerradas no se modelan
        if not s.get('fp'):
            review.append(f"Estación nueva sin huella: {s['name']} (revisar en OSM y `tools/import_busway.py`).")
        if not letters_of.get(s['id']) and s.get('routes'):
            review.append(f"Estación nueva sin letra de troncal: {s['name']} (`data/curated/station_corridors.json`).")
    # Rutas troncales fuera de los ejes curados: un corredor nuevo o ejes desactualizados.
    if cur.exists():
        G = 50.0
        grid = set()
        for seg in segs:
            pts = [xy(lo, la) for lo, la in seg['c']]
            for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                n = max(1, int(math.hypot(bx - ax, by - ay) // 20))
                for k in range(n + 1):
                    grid.add((int((ax + (bx - ax) * k / n) // G), int((ay + (by - ay) * k / n) // G)))
        far = []
        for r in route_info:
            if r['sys'] != 'troncal' or r['id'] not in shapes_out:
                continue
            shp = shapes.get(shape_of_route.get(r['id']))
            if not shp:
                continue
            m_ = shp[1]
            off_m = 0.0
            for (ax, ay), (bx, by) in zip(m_, m_[1:]):
                l = math.hypot(bx - ax, by - ay)
                n = max(1, int(l // 20))
                for k in range(n):
                    x, y = ax + (bx - ax) * k / n, ay + (by - ay) * k / n
                    gx, gy = int(x // G), int(y // G)
                    if not any((gx + i, gy + j) in grid for i in (-1, 0, 1) for j in (-1, 0, 1)):
                        off_m += l / n
            if off_m > OFF_AXES_M:
                far.append((off_m, r['code']))
        if far:
            far.sort(reverse=True)
            review.append(f"{len(far)} rutas troncales recorren más de {OFF_AXES_M / 1000:.1f} km lejos de los ejes curados (¿corredor nuevo?): "
                          + ', '.join(f'{c} {d / 1000:.1f} km' for d, c in far[:8]) + ' — volver a correr la curaduría de ejes.')
    text = summary.read_text()
    text += '\n## Revisión de lo curado\n\n' + ('\n'.join(f'- {x}' for x in review) if review else 'Nada que revisar.') + '\n'
    summary.write_text(text)
    (ROOT / '.cache' / 'revision.txt').write_text('\n'.join(review))
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as fh:
            fh.write(text)
    for x in review:
        log('revisar: ' + x)
    shutil.rmtree(prev, ignore_errors=True)
    off = sorted(max_off)
    if off:
        log(f'paradas sobre el recorrido: p50 {off[len(off)//2]:.1f} m · p99 {off[int(len(off)*.99)]:.1f} m · máx {off[-1]:.0f} m')
    log(f'listo en {time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()

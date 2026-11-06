#!/usr/bin/env python3
"""Revisión automática del 3D, estación por estación (después de `tools/build_data.py`).

    python3 tools/review_3d.py [public/data]

Lee lo compilado (network.json, lanes.json, structures.json) y señala, por estación:

- andén sobre la calzada exclusiva (más del 15 % de sus puntos a menos de 1,7 m de un eje de carril);
- andenes encimados (dos huellas de la misma estación que se cubren más de un 30 %);
- nombre lejos de su huella (el punto de la estación a más de 40 m de todos sus andenes);
- un puente (> 2,5 m) o un deprimido (< −0,5 m) que pasa por encima o por debajo de un andén, salvo las
  estaciones bajo tierra (todo el andén en el deprimido);
- un puente peatonal que atraviesa un vagón (pasa sobre el andén entre 0,9 y 4,5 m: chocaría con la
  cubierta);
- sin puente peatonal a menos de 60 m (dato: muchas estaciones se acceden por uno).

No cambia nada: imprime el informe para revisarlo con las capturas.
"""
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

DIR = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / 'public' / 'data')
KX = 111_320.0 * math.cos(math.radians(4.65))
KY = 110_574.0


def xy(lo, la):
    return lo * KX, la * KY


def decode(d, scale):
    out, x, y = [], 0, 0
    for i in range(0, len(d), 2):
        x += d[i]
        y += d[i + 1]
        out.append(xy(x / scale, y / scale))
    return out


def inside(p, ring):
    c = False
    for i in range(len(ring)):
        (xi, yi), (xj, yj) = ring[i], ring[i - 1]
        if (yi > p[1]) != (yj > p[1]) and p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi:
            c = not c
    return c


def seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy or 1e-9
    f = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    return math.hypot(p[0] - a[0] - f * dx, p[1] - a[1] - f * dy)


def samples(ring, step=2.0):
    """Puntos dentro del anillo en una rejilla (para medir solapes y cruces)."""
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    out = []
    y = min(ys) + step / 2
    while y < max(ys):
        x = min(xs) + step / 2
        while x < max(xs):
            if inside((x, y), ring):
                out.append((x, y))
            x += step
        y += step
    return out


class Grid:
    def __init__(self, size=50):
        self.g, self.s = defaultdict(list), size

    def add(self, a, b, item):
        for gx in range(int(min(a[0], b[0]) // self.s) - 1, int(max(a[0], b[0]) // self.s) + 2):
            for gy in range(int(min(a[1], b[1]) // self.s) - 1, int(max(a[1], b[1]) // self.s) + 2):
                self.g[(gx, gy)].append(item)

    def near(self, p):
        return self.g.get((int(p[0] // self.s), int(p[1] // self.s)), [])


def main():
    net = json.loads((DIR / 'network.json').read_text())
    lanes = json.loads((DIR / 'lanes.json').read_text())
    st = json.loads((DIR / 'structures.json').read_text())
    lane_grid = Grid()
    for l in lanes['lanes']:
        c = decode(l['d'], lanes['scale'])
        for a, b in zip(c, c[1:]):
            lane_grid.add(a, b, (a, b))
    piece_grid = Grid()
    for pc in st['pieces']:
        if pc.get('k') == 'via':
            continue
        c = decode(pc['d'], st['scale'])
        for i in range(1, len(c)):
            piece_grid.add(c[i - 1], c[i], (c[i - 1], c[i], pc['z'][i - 1], pc['z'][i], pc['w'], pc.get('k')))
    foot_grid = Grid()
    for f in st.get('foot', []):
        c = decode(f['d'], st['scale'])
        for i in range(1, len(c)):
            foot_grid.add(c[i - 1], c[i], (c[i - 1], c[i], f['z'][i - 1], f['z'][i]))

    issues = defaultdict(list)
    no_foot = []
    for s in net['stations']:
        if s.get('prov') or s.get('closed') or s['kind'] == 'cable' or not s.get('fp'):
            continue
        name = f"{s['id']} {s['name']}"
        rings = [[xy(lo, la) for lo, la in r] for r in s['fp']]
        pts_all = []
        for ri, r in enumerate(rings):
            pts = samples(r)
            pts_all.append(pts)
            if not pts:
                continue
            if s['kind'] != 'portal':
                over = sum(1 for p in pts if any(seg_dist(p, a, b) < 1.7 for a, b in lane_grid.near(p))) / len(pts)
                if over > 0.15:
                    issues[name].append(f'andén {ri + 1} sobre la calzada ({over * 100:.0f} %)')
            zs = []
            for p in pts:
                best = None
                for a, b, za, zb, w, k in piece_grid.near(p):
                    d = seg_dist(p, a, b)
                    if d <= w / 2:
                        dx, dy = b[0] - a[0], b[1] - a[1]
                        f = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy or 1e-9)))
                        z = za + (zb - za) * f
                        if best is None or abs(z) > abs(best):
                            best = z
                if best is not None:
                    zs.append(best)
            up = sum(1 for z in zs if z > 2.5)
            down = sum(1 for z in zs if z < -0.5)
            if up:
                issues[name].append(f'puente sobre el andén {ri + 1} ({up} puntos)')
            if down and down < 0.8 * len(pts):
                issues[name].append(f'deprimido bajo parte del andén {ri + 1} ({down} de {len(pts)} puntos)')
            hits = 0
            for p in pts:
                for a, b, za, zb in foot_grid.near(p):
                    if seg_dist(p, a, b) <= 1.5:
                        dx, dy = b[0] - a[0], b[1] - a[1]
                        f = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy or 1e-9)))
                        z = za + (zb - za) * f
                        if 0.95 < z < 4.5:
                            hits += 1
                            break
            if hits:
                issues[name].append(f'puente peatonal atraviesa el andén {ri + 1} ({hits} puntos)')
        for i in range(len(rings)):
            for j in range(i + 1, len(rings)):
                if not pts_all[i] or not pts_all[j]:
                    continue
                a_in_b = sum(1 for p in pts_all[i] if inside(p, rings[j])) / len(pts_all[i])
                b_in_a = sum(1 for p in pts_all[j] if inside(p, rings[i])) / len(pts_all[j])
                if max(a_in_b, b_in_a) > 0.3:
                    issues[name].append(f'andenes {i + 1} y {j + 1} encimados ({max(a_in_b, b_in_a) * 100:.0f} %)')
        c = xy(s['lon'], s['lat'])
        dmin = min(min(seg_dist(c, r[k - 1], r[k]) for k in range(1, len(r))) if not inside(c, r) else 0 for r in rings)
        if dmin > 40:
            issues[name].append(f'nombre a {dmin:.0f} m de los andenes')
        near_foot = any(seg_dist(p, a, b) < 60 for r in rings for p in r for a, b, *_ in foot_grid.near(p))
        if not near_foot:
            no_foot.append(name)
    print(f'Estaciones con observaciones: {len(issues)}')
    for k in sorted(issues):
        print(f'- {k}: ' + '; '.join(issues[k]))
    print(f'\nSin puente peatonal a menos de 60 m ({len(no_foot)}): ' + ', '.join(no_foot))


if __name__ == '__main__':
    main()

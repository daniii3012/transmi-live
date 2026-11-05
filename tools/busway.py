"""Geometría física de la troncal para `build_data.py` (hito 7, F7.6 y F7.7).

Entrada: `data/curated/busway.json` (ejes de la calzada exclusiva por sentido, huellas de estación;
OpenStreetMap, ver `tools/import_busway.py`). Si no está, la compilación sigue sin estas mejoras.

- `snap_path`: lleva un recorrido troncal o dual al eje del carril exclusivo de su sentido cuando
  pasa a menos de `R` metros. Medido el 5 nov.: el 81 % de los puntos de los recorridos del GTFS ya
  está a menos de 4 m del eje y el 88 % a menos de 8 m; el resto son tramos dual por calle, portales y
  calzadas sin trazar en OSM, que se dejan como vienen. Las transiciones se suavizan (sin quiebres) y
  los huecos cortos (cruces donde la vía de OSM se corta) se rellenan.
- `estimate_footprint`: huella de una estación sin edificio en OSM, entre los carriles de los dos
  sentidos, a lo largo del eje y con el largo de sus vagones. Se marca como estimada.

Todo en la proyección local de la página (metros, equirectangular en 4,65° N).
"""
from __future__ import annotations

import math
from collections import defaultdict

G = 25.0          # celda de la rejilla, m
COS_MIN = 0.82    # ±35°: mismo sentido que el carril


class LaneIndex:
    def __init__(self, lanes, xy):
        self.segs: list[tuple[float, float, float, float, bool]] = []
        self.grid: dict[tuple[int, int], list[int]] = defaultdict(list)
        for w in lanes:
            m = [xy(lo, la) for lo, la in w['c']]
            for (ax, ay), (bx, by) in zip(m, m[1:]):
                if (ax - bx) ** 2 + (ay - by) ** 2 < 1e-4:
                    continue
                i = len(self.segs)
                self.segs.append((ax, ay, bx, by, w['oneway']))
                for gx in range(int(min(ax, bx) // G) - 1, int(max(ax, bx) // G) + 2):
                    for gy in range(int(min(ay, by) // G) - 1, int(max(ay, by) // G) + 2):
                        self.grid[(gx, gy)].append(i)

    def near(self, p, t, R: float):
        """Proyección sobre el carril más cercano a menos de `R` m con el sentido de `t` (unitario)."""
        best = None
        px, py = p
        for i in self.grid.get((int(px // G), int(py // G)), ()):
            ax, ay, bx, by, one = self.segs[i]
            dx, dy = bx - ax, by - ay
            l2 = dx * dx + dy * dy
            l = math.sqrt(l2)
            c = (t[0] * dx + t[1] * dy) / l
            if (c < COS_MIN) if one else (abs(c) < COS_MIN):
                continue
            f = ((px - ax) * dx + (py - ay) * dy) / l2
            f = 0.0 if f < 0 else 1.0 if f > 1 else f
            qx, qy = ax + f * dx, ay + f * dy
            d = math.hypot(px - qx, py - qy)
            if d <= R and (best is None or d < best[0]):
                best = (d, qx, qy, dx / l, dy / l)
        return best

    def around(self, p, R: float):
        """Segmentos a menos de `R` m de `p`: (distancia, proyección, dirección)."""
        out = []
        px, py = p
        seen = set()
        r = int(R // G) + 1
        cx, cy = int(px // G), int(py // G)
        for gx in range(cx - r, cx + r + 1):
            for gy in range(cy - r, cy + r + 1):
                for i in self.grid.get((gx, gy), ()):
                    if i in seen:
                        continue
                    seen.add(i)
                    ax, ay, bx, by, _ = self.segs[i]
                    dx, dy = bx - ax, by - ay
                    l2 = dx * dx + dy * dy
                    f = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
                    qx, qy = ax + f * dx, ay + f * dy
                    d = math.hypot(px - qx, py - qy)
                    if d <= R:
                        l = math.sqrt(l2)
                        out.append((d, (qx, qy), (dx / l, dy / l)))
        return out


def snap_path(m: list[tuple[float, float]], idx: LaneIndex, R: float = 8.0, step: float = 5.0):
    """Recorrido llevado a los carriles; devuelve (puntos, fracción ajustada)."""
    dense = [m[0]]
    for (ax, ay), (bx, by) in zip(m, m[1:]):
        l = math.hypot(bx - ax, by - ay)
        n = max(1, int(l // step))
        for k in range(1, n + 1):
            dense.append((ax + (bx - ax) * k / n, ay + (by - ay) * k / n))
    N = len(dense)
    if N < 3:
        return m, 0.0
    ox = [0.0] * N
    oy = [0.0] * N
    hit = [False] * N
    for k in range(N):
        a = dense[max(0, k - 2)]
        b = dense[min(N - 1, k + 2)]
        tx, ty = b[0] - a[0], b[1] - a[1]
        l = math.hypot(tx, ty)
        if l < 1e-6:
            continue
        r = idx.near(dense[k], (tx / l, ty / l), R)
        if r:
            hit[k] = True
            ox[k] = r[1] - dense[k][0]
            oy[k] = r[2] - dense[k][1]
    # Huecos cortos entre dos tramos ajustados (≤ 40 m): desfase interpolado.
    k = 0
    while k < N:
        if hit[k]:
            k += 1
            continue
        j = k
        while j < N and not hit[j]:
            j += 1
        if k > 0 and j < N and (j - k) * step <= 40:
            for i in range(k, j):
                f = (i - k + 1) / (j - k + 1)
                ox[i] = ox[k - 1] + (ox[j] - ox[k - 1]) * f
                oy[i] = oy[k - 1] + (oy[j] - oy[k - 1]) * f
                hit[i] = True
        k = j
    # Suavizado triangular de ±20 m: entra y sale del carril sin quiebres. Dentro de un tramo
    # ajustado los desfases son parecidos y el promedio casi no los mueve.
    W = 4
    sx = [0.0] * N
    sy = [0.0] * N
    for k in range(N):
        tw = wx = wy = 0.0
        for i in range(max(0, k - W), min(N, k + W + 1)):
            w = W + 1 - abs(i - k)
            tw += w
            wx += w * ox[i]
            wy += w * oy[i]
        sx[k], sy[k] = wx / tw, wy / tw
    # Donde el punto mismo está ajustado, manda su desfase (el suavizado solo arregla los bordes).
    out = []
    for k in range(N):
        inner = hit[k] and all(hit[i] for i in range(max(0, k - W), min(N, k + W + 1)))
        dx, dy = (ox[k], oy[k]) if inner else (sx[k], sy[k])
        out.append((dense[k][0] + dx, dense[k][1] + dy))
    return out, sum(hit) / N


def estimate_footprint(center, wagons, idx: LaneIndex):
    """Rectángulo de plataforma entre los carriles de los dos sentidos; None si no hay con qué."""
    near = idx.around(center, 30.0)
    if not near:
        return None
    # Eje: dirección del carril más cercano (sin sentido).
    d0, _, (ux, uy) = min(near, key=lambda s: s[0])
    nx, ny = -uy, ux
    # Desfase lateral de cada carril paralelo respecto al centro de la estación.
    offs = []
    for d, (qx, qy), (dx, dy) in near:
        if abs(dx * ux + dy * uy) < 0.9:
            continue
        offs.append((qx - center[0]) * nx + (qy - center[1]) * ny)
    left = [o for o in offs if o < -0.5]
    right = [o for o in offs if o > 0.5]
    if left and right:
        a, b = max(left), min(right)
        gap = b - a
        if gap < 7:
            return None
        width = max(3.0, min(6.0, gap - 7.0))
        mid = (a + b) / 2
    else:
        return None
    cx, cy = center[0] + nx * mid, center[1] + ny * mid
    # Largo: lo que abarcan los vagones a lo largo del eje, con 12 m a cada lado.
    proj = [(wx - cx) * ux + (wy - cy) * uy for wx, wy in wagons] or [0.0]
    s0, s1 = min(proj) - 12, max(proj) + 12
    if s1 - s0 < 40:
        c = (s0 + s1) / 2
        s0, s1 = c - 20, c + 20
    s1 = min(s1, s0 + 320)
    hw = width / 2
    ring = [
        (cx + ux * s0 + nx * hw, cy + uy * s0 + ny * hw),
        (cx + ux * s1 + nx * hw, cy + uy * s1 + ny * hw),
        (cx + ux * s1 - nx * hw, cy + uy * s1 - ny * hw),
        (cx + ux * s0 - nx * hw, cy + uy * s0 - ny * hw),
    ]
    ring.append(ring[0])
    return ring

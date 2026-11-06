#!/usr/bin/env python3
"""Pruebas de tools/busway.py (ajuste al carril y huellas estimadas). python3 tools/test_busway.py"""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import busway as bw  # noqa: E402

XY = lambda lon, lat: (lon, lat)  # coordenadas ya en metros para las pruebas


def lane(points, oneway=True):
    return {'c': points, 'oneway': oneway}


def dist_to_line_y(p, y):
    return abs(p[1] - y)


class SnapTests(unittest.TestCase):
    def test_lleva_el_recorrido_al_eje_de_su_sentido(self):
        # Carril hacia el este en y = 0 y otro hacia el oeste en y = 7: el recorrido va hacia el este en y = 3.
        idx = bw.LaneIndex([lane([[0, 0], [500, 0]]), lane([[500, 7], [0, 7]])], XY)
        pts, frac = bw.snap_path([(0, 3), (500, 3)], idx)
        self.assertGreater(frac, 0.95)
        mid = [p for p in pts if 100 < p[0] < 400]
        self.assertTrue(all(dist_to_line_y(p, 0) < 0.05 for p in mid))

    def test_sin_carril_cerca_se_deja_como_viene(self):
        idx = bw.LaneIndex([lane([[0, 0], [500, 0]])], XY)
        pts, frac = bw.snap_path([(0, 30), (500, 30)], idx)
        self.assertEqual(frac, 0.0)
        self.assertTrue(all(abs(p[1] - 30) < 1e-9 for p in pts))

    def test_sentido_contrario_no_se_usa(self):
        idx = bw.LaneIndex([lane([[500, 0], [0, 0]])], XY)
        _, frac = bw.snap_path([(0, 3), (500, 3)], idx)
        self.assertEqual(frac, 0.0)

    def test_transicion_suave_y_hueco_corto_relleno(self):
        # Carril con un corte de 30 m (cruce): el desfase se interpola, sin volver a y = 3.
        idx = bw.LaneIndex([lane([[0, 0], [235, 0]]), lane([[265, 0], [500, 0]])], XY)
        pts, _ = bw.snap_path([(0, 3), (500, 3)], idx)
        gap = [p for p in pts if 235 <= p[0] <= 265]
        self.assertTrue(gap and all(abs(p[1]) < 0.5 for p in gap))
        # Ningún salto lateral mayor a 1,5 m entre puntos seguidos.
        self.assertTrue(all(abs(b[1] - a[1]) <= 1.5 for a, b in zip(pts, pts[1:])))


class FootprintTests(unittest.TestCase):
    def test_huella_entre_los_dos_carriles(self):
        # Carriles a y = 0 (este) e y = 14 (oeste): plataforma centrada en y = 7, ancho 6 (tope).
        idx = bw.LaneIndex([lane([[0, 0], [400, 0]]), lane([[400, 14], [0, 14]])], XY)
        ring = bw.estimate_footprint((200, 7), [(170, 7), (230, 7)], idx)
        self.assertIsNotNone(ring)
        ys = [p[1] for p in ring]
        xs = [p[0] for p in ring]
        self.assertAlmostEqual((min(ys) + max(ys)) / 2, 7, places=3)
        self.assertAlmostEqual(max(ys) - min(ys), 6, places=3)
        self.assertAlmostEqual(min(xs), 158, places=3)  # vagones ± 12 m
        self.assertAlmostEqual(max(xs), 242, places=3)

    def test_un_solo_carril_no_estima(self):
        idx = bw.LaneIndex([lane([[0, 0], [400, 0]])], XY)
        self.assertIsNone(bw.estimate_footprint((200, 5), [(200, 5)], idx))

    def test_se_acorta_donde_los_carriles_se_juntan(self):
        # El carril de arriba baja a y = 3 desde x = 230: la punta derecha se recorta antes de invadirlo.
        idx = bw.LaneIndex([lane([[0, 0], [400, 0]]), lane([[400, 3], [230, 3], [220, 14], [0, 14]])], XY)
        ring = bw.estimate_footprint((150, 7), [(110, 7), (190, 7)], idx)
        self.assertIsNotNone(ring)
        self.assertLess(max(p[0] for p in ring), 225)

    def test_isla_ancha_una_fila_por_carril(self):
        # Carriles a 26 m (y = 0 e y = 26): dos filas de 5 m, cada una a 2 m de su carril; nada en el medio.
        idx = bw.LaneIndex([lane([[0, 0], [400, 0]]), lane([[400, 26], [0, 26]])], XY)
        rings = bw.estimate_footprints((200, 13), [(170, 13), (230, 13)], idx)
        self.assertEqual(len(rings), 2)
        spans = sorted((min(p[1] for p in r), max(p[1] for p in r)) for r in rings)
        self.assertAlmostEqual(spans[0][0], 2, places=3)
        self.assertAlmostEqual(spans[0][1], 7, places=3)
        self.assertAlmostEqual(spans[1][0], 19, places=3)
        self.assertAlmostEqual(spans[1][1], 24, places=3)
        # Con 14 m sigue siendo un solo andén centrado.
        idx = bw.LaneIndex([lane([[0, 0], [400, 0]]), lane([[400, 14], [0, 14]])], XY)
        self.assertEqual(len(bw.estimate_footprints((200, 7), [(200, 7)], idx)), 1)


if __name__ == '__main__':
    unittest.main(verbosity=1)

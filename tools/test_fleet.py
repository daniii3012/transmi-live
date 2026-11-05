#!/usr/bin/env python3
"""Pruebas de tools/check_fleet.py. python3 tools/test_fleet.py"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_fleet as cf  # noqa: E402


def vint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def ld(field, payload):
    return vint(field << 3 | 2) + vint(len(payload)) + payload


def feed(items):
    """FeedMessage mínimo: entidad → vehículo → (viaje con route_id, descriptor con etiqueta)."""
    out = b''
    for label, route in items:
        veh = ld(1, ld(5, route.encode())) + ld(8, ld(1, b'x') + ld(2, label.encode()))
        out += ld(2, ld(1, b'e') + ld(4, veh))
    return out


RANGES = {'K': {'biarticulated': [[1600, 1699]]}, 'BO': {'dual-articulated': [[900, 999]]}}


class FleetTests(unittest.TestCase):
    def test_lee_etiqueta_y_ruta(self):
        self.assertEqual(list(cf.vehicles(feed([('K10657', '12370'), ('Z70700', '12803')]))), [('K10657', '12370'), ('Z70700', '12803')])

    def test_cero_de_relleno_y_serie_desconocida(self):
        self.assertEqual(cf.classify('K10657', RANGES), ('K', 1657, 'biarticulated'))
        self.assertEqual(cf.classify('BO0905', RANGES), ('BO', 905, 'dual-articulated'))
        self.assertEqual(cf.classify('QX0123', RANGES), ('QX', 123, None))
        self.assertIsNone(cf.classify('sin-numero', RANGES))


if __name__ == '__main__':
    unittest.main(verbosity=1)

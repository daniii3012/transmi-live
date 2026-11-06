#!/usr/bin/env python3
"""Pruebas de tools/diff_network.py. python3 tools/test_diff.py"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import diff_network as dn  # noqa: E402


def build(d: Path, routes: dict, stations: dict, built: str, hash_: str):
    """routes: id → (código, destino, [estaciones]); stations: id → (nombre, cerrada)."""
    net = {
        'routes': [{'id': rid, 'code': c, 'dest': dest, 'origin': '', 'sys': 'troncal', 'color': '#000'} for rid, (c, dest, _) in routes.items()],
        'stations': [{'id': sid, 'name': n, 'short': n, 'kind': 'station', **({'closed': True} if cl else {}), 'platforms': []} for sid, (n, cl) in stations.items()],
    }
    pats = {'v': 1, 'patterns': {rid: {'stops': st, 's': list(range(0, 100 * len(st), 100)), 't': []} for rid, (_, _, st) in routes.items()}}
    d.mkdir(parents=True, exist_ok=True)
    (d / 'network.json').write_text(json.dumps(net))
    (d / 'patterns.json').write_text(json.dumps(pats))
    (d / 'meta.json').write_text(json.dumps({'hash': hash_, 'built': built + 'T05:00:00-0500', 'counts': {'routes': len(routes)}}))


ST = {'a': ('Alfa', False), 'b': ('Beta', False), 'c': ('Gama', False), 'd': ('Delta', False)}


class DiffTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def test_sin_red_anterior_no_hay_cambios(self):
        # Primera publicación: nada con qué comparar; antes salía la red entera como nueva.
        build(self.tmp / 'b', {'1': ('B74', 'Norte', ['a', 'b', 'c'])}, ST, '2026-11-06', 'h1')
        (self.tmp / 'a').mkdir()
        out = dn.run(self.tmp / 'a', self.tmp / 'b')
        self.assertEqual(out['entries'], [])

    def test_dia_sin_base_sale_del_historial(self):
        # Lo que ya quedó publicado así (toda la red nueva un día) se descarta en la siguiente compilación;
        # los días con cambios reales se conservan.
        build(self.tmp / 'a', {'1': ('B74', 'Norte', ['a', 'b', 'c'])}, ST, '2026-11-06', 'h1')
        bogus = [{'date': '2026-11-06', 'kind': 'station-new', 'station': str(i), 'text': f'Nueva estación {i}'} for i in range(30)]
        real = [{'date': '2026-11-05', 'kind': 'station-new', 'station': 'x', 'text': 'Nueva estación Calle 53'}]
        (self.tmp / 'a' / 'changes.json').write_text(json.dumps({'v': 1, 'updated': '2026-11-06', 'entries': bogus + real, 'aliases': {}}))
        build(self.tmp / 'b', {'1': ('B74', 'Norte', ['a', 'b', 'c'])}, ST, '2026-11-07', 'h1')
        out = dn.run(self.tmp / 'a', self.tmp / 'b')
        self.assertEqual([e['text'] for e in out['entries']], ['Nueva estación Calle 53'])

    def test_id_reemitido_sin_cambios_es_solo_alias(self):
        build(self.tmp / 'a', {'1': ('B74', 'Norte', ['a', 'b', 'c'])}, ST, '2026-11-01', 'h1')
        build(self.tmp / 'b', {'9': ('B74', 'Norte', ['a', 'b', 'c'])}, ST, '2026-11-02', 'h2')
        out = dn.run(self.tmp / 'a', self.tmp / 'b')
        self.assertEqual(out['entries'], [])
        self.assertEqual(out['aliases'], {'1': ['9', '2026-11-02']})

    def test_paradas_ruta_nueva_y_retirada(self):
        build(self.tmp / 'a', {'1': ('B74', 'Norte', ['a', 'b', 'c']), '2': ('K23', 'Dorado', ['a', 'd'])}, ST, '2026-11-01', 'h1')
        build(self.tmp / 'b', {'1': ('B74', 'Norte', ['a', 'c', 'd']), '3': ('105', 'Norte', ['a', 'b'])}, ST, '2026-11-02', 'h2')
        out = dn.run(self.tmp / 'a', self.tmp / 'b')
        kinds = {e['kind']: e for e in out['entries']}
        self.assertEqual(kinds['route-stops']['add'], ['Delta'])
        self.assertEqual(kinds['route-stops']['remove'], ['Beta'])
        self.assertIn('Nueva ruta 105', kinds['route-new']['text'])
        self.assertIn('Sale de servicio la ruta K23', kinds['route-gone']['text'])

    def test_estacion_cerrada_y_renombrada(self):
        build(self.tmp / 'a', {'1': ('B74', 'Norte', ['a'])}, ST, '2026-11-01', 'h1')
        st = dict(ST, b=('Beta', True), c=('Gamma', False))
        build(self.tmp / 'b', {'1': ('B74', 'Norte', ['a'])}, st, '2026-11-02', 'h2')
        texts = [e['text'] for e in dn.run(self.tmp / 'a', self.tmp / 'b')['entries']]
        self.assertIn('Cierra la estación Beta', texts)
        self.assertIn('La estación Gama ahora se llama Gamma', texts)

    def test_alias_encadenados_e_historial(self):
        build(self.tmp / 'a', {'1': ('B74', 'Norte', ['a', 'b'])}, ST, '2026-11-01', 'h1')
        build(self.tmp / 'b', {'2': ('B74', 'Norte', ['a', 'b']), '5': ('C15', 'Suba', ['c'])}, ST, '2026-11-02', 'h2')
        dn.run(self.tmp / 'a', self.tmp / 'b')
        build(self.tmp / 'c', {'3': ('B74', 'Norte', ['a', 'b']), '5': ('C15', 'Suba', ['c', 'd'])}, ST, '2026-11-03', 'h3')
        # La carpeta nueva no trae historial: se lee el de la anterior.
        out = dn.run(self.tmp / 'b', self.tmp / 'c')
        self.assertEqual(out['aliases']['1'][0], '3')
        self.assertEqual(out['aliases']['2'][0], '3')
        self.assertTrue(any(e['date'] == '2026-11-03' and e['kind'] == 'route-stops' for e in out['entries']))

    def test_mismo_paquete_conserva_historial(self):
        build(self.tmp / 'a', {'1': ('B74', 'Norte', ['a'])}, ST, '2026-11-01', 'h1')
        (self.tmp / 'a' / 'changes.json').write_text(json.dumps({'v': 1, 'entries': [{'date': '2026-10-30', 'kind': 'route-new', 'text': 'x'}], 'aliases': {}}))
        build(self.tmp / 'b', {'1': ('B74', 'Norte', ['a'])}, ST, '2026-11-02', 'h1')
        out = dn.run(self.tmp / 'a', self.tmp / 'b')
        self.assertEqual(len(out['entries']), 1)


if __name__ == '__main__':
    unittest.main(verbosity=1)

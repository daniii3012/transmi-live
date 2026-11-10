"""Pruebas del paquete de la app (`build_app_db.py`).

    python3 tools/test_app_db.py

La codificación se prueba siempre. Si existe la base del día (`.cache/red.sqlite`, la deja
`build_app_db.py`), también el contenido: tramos de una muestra, búsqueda y la validación completa.
"""
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_app_db as m  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
fails = 0


def check(cond, msg):
    global fails
    if not cond:
        fails += 1
        print('FALLA', msg)


# Codificación.
vals = [0, 1, -1, 63, -64, 300, -300, 2**31, -(2**31)]
check(m.unvarints(m.varints(vals)) == vals, 'varint ida y vuelta')
coords = [(-74.1, 4.65), (-74.09999, 4.65001), (-74.0, 4.7)]
back = m.decode_coords(m.encode_coords(coords))
check(all(abs(a[0] - b[0]) < 1e-5 and abs(a[1] - b[1]) < 1e-5 for a, b in zip(coords, back)), 'recorrido ida y vuelta')
check(len(m.decode_coords(m.encode_coords([(-74.1, 4.65), (-74.1, 4.65)]))) == 1, 'puntos repetidos fuera')
check(m.page_shape([-74100000, 4650000, 1000, -2000], 1_000_000) == [(-74.1, 4.65), (-74.099, 4.648)], 'recorrido de la página')
check(m.ink_on('#f2b705') == '#07090b' and m.ink_on('#4f6bed') == '#ffffff', 'texto sobre color')
check(m.fold('Suba La Gaitana Ciclovía') == 'suba la gaitana ciclovia', 'sin tildes')

db = ROOT / '.cache' / 'red.sqlite'
if db.exists():
    errors = m.validate(db)
    check(not errors, f'validación: {errors}')
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    q = lambda sql, *a: con.execute(sql, a).fetchall()

    def legs(code):
        rows = q('SELECT l.code, l.dest, l.from_idx, l.to_idx FROM route r JOIN route_leg l ON l.route = r.id '
                 'WHERE r.code = ? ORDER BY r.id, l.seq', code)
        return rows

    ca = legs('CA153')
    check(ca[:2] == [('A153', 'Centro', 0, ca[1][2]), ('C153', 'Suba La Gaitana', ca[1][2], ca[1][3])], f'CA153: {ca[:2]}')
    hk = legs('HK635')
    check([r[0] for r in hk[:2]] == ['K635', 'H635'], f'HK635: {hk[:2]}')
    check(legs('B10')[0][:2] == ('B10', 'Portal Norte'), 'B10 un tramo')
    check(legs('FZ63')[0][0] == 'F63/Z63', 'FZ63: códigos conocidos, sin el punto de cambio')
    # Cada tramo cubre el patrón sin huecos.
    gaps = q('SELECT a.route FROM route_leg a JOIN route_leg b ON b.route = a.route AND b.seq = a.seq + 1 '
             'WHERE b.from_idx != a.to_idx')
    check(not gaps, f'tramos con hueco: {gaps[:5]}')

    def first(term):
        r = q('SELECT kind, ref, code FROM search WHERE search MATCH ? ORDER BY rank LIMIT 1', term)
        return r[0] if r else None

    check(first('k635')[:1] == ('leg',) and first('k635')[2] == 'K635', f'k635 → {first("k635")}')
    check(first('a153')[2] == 'A153', f'a153 → {first("a153")}')
    check(first('080A01') == ('stop', '49841', '080A01') or first('080A01')[0] == 'stop', f'080A01 → {first("080A01")}')
    check(first('"calle 72"')[0] == 'station', f'calle 72 → {first("calle 72")}')
    check(q("SELECT COUNT(*) FROM search WHERE search MATCH 'gaitana'")[0][0] >= 3, 'gaitana')
    # Paradas cerca de la estación Calle 72 (R-tree) y rutas que paran en una estación.
    near = q('SELECT COUNT(*) FROM stop_rt WHERE lat0 <= 4.66 AND lat1 >= 4.65 AND lon0 <= -74.055 AND lon1 >= -74.065')[0][0]
    check(near > 5, f'cerca de Calle 72: {near}')
    st = q("SELECT COUNT(*) FROM stop_route WHERE stop = (SELECT id FROM stop WHERE kind = 'estacion' AND name LIKE 'Calle 72%')")[0][0]
    check(st > 3, f'rutas en Calle 72: {st}')
    # Servicio: 30 horas por fila.
    check(q('SELECT COUNT(*) FROM service WHERE length(hours) != 30')[0][0] == 0, 'servicio de 30 horas')
    meta = dict(q('SELECT key, value FROM meta'))
    check(int(meta['fare_cop']) > 0 and int(meta['transfer_s']) > 0, 'tarifa y transbordo')
    check(json.loads(meta['bands'])[0]['key'] == 'madrugada', 'franjas')
    con.close()
else:
    print('(sin .cache/red.sqlite: solo codificación)')

print('app-db:', 'ok' if not fails else f'{fails} fallas')
sys.exit(1 if fails else 0)

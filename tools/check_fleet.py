#!/usr/bin/env python3
"""Series de flota sin clasificar (F9.10).

Lee una instantánea de posiciones (del Worker desplegado, una petición, o de un archivo .pb) y busca
buses troncales y duales cuyo número no cae en ningún rango de `data/curated/fleet.json`: la serie es
nueva o el rango quedó corto. Lo que encuentre se agrega a `.cache/revision.txt` (el flujo diario lo
publica en el issue de revisión).

    python3 tools/check_fleet.py https://transmi-live.<subdominio>.workers.dev
    python3 tools/check_fleet.py captura.pb

Misma regla que `src/domain/fleetTypes.ts`: serie y número de la etiqueta («K10657» es el K1657 de la
calle: el alimentador escribe un cero de relleno), la serie Z es flota zonal.
"""
import json
import re
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIN_BUSES = 3  # por debajo, ruido (un bus prestado, una etiqueta mal escrita)


def varint(b, p):
    x = s = 0
    while True:
        c = b[p]
        p += 1
        x |= (c & 0x7F) << s
        s += 7
        if not c & 0x80:
            return x, p


def fields(b, s, e):
    """(campo, tipo, valor o (inicio, fin)) de un mensaje."""
    p = s
    while p < e:
        t, p = varint(b, p)
        f, w = t >> 3, t & 7
        if w == 0:
            v, p = varint(b, p)
            yield f, w, v
        elif w == 1:
            p += 8
        elif w == 5:
            p += 4
        elif w == 2:
            n, p = varint(b, p)
            yield f, w, (p, p + n)
            p += n
        else:
            raise ValueError(f'tipo de cable {w}')


def vehicles(b):
    """(etiqueta, route_id) de cada vehículo del FeedMessage."""
    for f, w, v in fields(b, 0, len(b)):
        if f != 2 or w != 2:
            continue
        for g, x, vv in fields(b, *v):
            if g != 4 or x != 2:
                continue
            label = route = ''
            for h, y, r in fields(b, *vv):
                if h == 1 and y == 2:  # trip
                    for k, z, q in fields(b, *r):
                        if k == 5 and z == 2:
                            route = b[q[0]:q[1]].decode()
                elif h == 8 and y == 2:  # vehicle descriptor
                    for k, z, q in fields(b, *r):
                        if k == 2 and z == 2:
                            label = b[q[0]:q[1]].decode()
            yield label, route


def classify(label, ranges):
    """(serie, número, tipo o None); None si la etiqueta no tiene forma de serie y número."""
    m = re.match(r'^([A-Z]+)0*(\d+)$', label.strip())
    if not m:
        return None
    series, digits = m.group(1), m.group(2)
    if len(digits) == 5 and digits.startswith('10'):
        digits = digits[0] + digits[2:]
    n = int(digits)
    for kind, rs in ranges.get(series, {}).items():
        if any(a <= n <= b for a, b in rs):
            return series, n, kind
    return series, n, None


def main():
    src = sys.argv[1]
    if src.startswith('http'):
        req = urllib.request.Request(src.rstrip('/') + '/v1/vehicles?format=pb', headers={'User-Agent': 'transmi-live-ci'})
        with urllib.request.urlopen(req, timeout=30) as r:
            buf = r.read()
    else:
        buf = Path(src).read_bytes()
    fleet = json.loads((ROOT / 'data' / 'curated' / 'fleet.json').read_text())
    net = json.loads((ROOT / 'public' / 'data' / 'network.json').read_text())
    sys_of = {r['id']: (r['sys'], r['code']) for r in net['routes']}

    total = Counter()
    unknown = defaultdict(Counter)  # (serie, centena) → códigos de ruta
    for label, route in vehicles(buf):
        s = sys_of.get(route)
        if not s or s[0] not in ('troncal', 'dual'):
            continue
        total[s[0]] += 1
        c = classify(label, fleet['ranges'])
        if c is None or c[0].startswith('Z'):
            continue
        series, n, kind = c
        if kind is None:
            unknown[(series, n // 100 * 100)][s[1]] += 1

    lines = []
    for (series, h), codes in sorted(unknown.items()):
        n = sum(codes.values())
        if n < MIN_BUSES:
            continue
        routes = ', '.join(f'{c} ({k})' for c, k in codes.most_common(6))
        lines.append(f'Serie de flota sin clasificar: {series}{h}–{series}{h + 99}, {n} buses en vivo en {routes}. '
                     'Revisar el tipo (placa, fotos) y agregar el rango a `data/curated/fleet.json`.')
    print(f'flota: {sum(total.values())} troncales y duales en vivo; {sum(sum(c.values()) for c in unknown.values())} sin clasificar por número')
    for l in lines:
        print('·', l)
    if lines:
        out = ROOT / '.cache' / 'revision.txt'
        out.parent.mkdir(exist_ok=True)
        prev = out.read_text().rstrip('\n') + '\n' if out.exists() and out.read_text().strip() else ''
        out.write_text(prev + '\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()

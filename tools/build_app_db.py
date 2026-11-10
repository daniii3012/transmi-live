"""Paquete de la red para la app de iPhone (contrato en transmi-app, docs/DATOS.md §1).

Toma lo que ya decidió `build_data.py` (rutas, tramos, estaciones con sus vagones, paraderos,
recorridos, patrones, servicio, corredores, cambios, alias, festivos) y escribe una base SQLite de
solo lectura, comprimida, con su manifiesto:

    python3 tools/build_app_db.py [--data public/data] [--gtfs GTFS.zip] [--out public/data/app/v1]

Salida: `red-<huella>.sqlite.gz` y `manifest.json`. La huella es la del contenido (sin la fecha de
compilación): con los mismos datos, el mismo nombre. Antes de escribir el manifiesto se valida la
base (`validate`); si falla, el programa termina con error y no toca lo publicado.
"""
from __future__ import annotations

import argparse
import csv
import datetime
import gzip
import hashlib
import io
import json
import sqlite3
import sys
import unicodedata
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = 1
MIN_APP = '0.1.0'
E5 = 100_000

SCHEMA_SQL = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
CREATE TABLE system(key TEXT PRIMARY KEY, name TEXT, color TEXT, ord INT) WITHOUT ROWID;
CREATE TABLE route(
  id TEXT PRIMARY KEY, code TEXT NOT NULL, codes TEXT NOT NULL, name TEXT NOT NULL,
  origin TEXT, dest TEXT NOT NULL, sys TEXT NOT NULL, sub TEXT, zone TEXT,
  color TEXT NOT NULL, ink TEXT NOT NULL, len INT NOT NULL, nstops INT NOT NULL,
  kind TEXT NOT NULL, pair TEXT, shape BLOB NOT NULL,
  lat0 REAL, lon0 REAL, lat1 REAL, lon1 REAL
) WITHOUT ROWID;
CREATE TABLE route_leg(
  route TEXT NOT NULL, seq INT NOT NULL, code TEXT NOT NULL, dest TEXT NOT NULL,
  from_idx INT NOT NULL, to_idx INT NOT NULL, from_s INT NOT NULL, board_s INT NOT NULL,
  PRIMARY KEY(route, seq)
) WITHOUT ROWID;
CREATE TABLE stop(
  n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, code TEXT, name TEXT NOT NULL, short TEXT,
  lat REAL NOT NULL, lon REAL NOT NULL, kind TEXT NOT NULL, parent TEXT,
  closed INT NOT NULL DEFAULT 0, note TEXT
);
CREATE INDEX stop_parent ON stop(parent);
CREATE VIRTUAL TABLE stop_rt USING rtree(n, lat0, lat1, lon0, lon1);
CREATE TABLE stop_route(stop TEXT NOT NULL, route TEXT NOT NULL, leg INT NOT NULL DEFAULT 0,
  PRIMARY KEY(stop, route, leg)) WITHOUT ROWID;
CREATE INDEX stop_route_route ON stop_route(route);
CREATE TABLE pattern(
  route TEXT PRIMARY KEY, stops TEXT NOT NULL, s BLOB NOT NULL,
  t0 BLOB, t1 BLOB, t2 BLOB, t3 BLOB, t4 BLOB, trips INT NOT NULL
) WITHOUT ROWID;
CREATE TABLE service(
  route TEXT NOT NULL, day TEXT NOT NULL, first INT, last INT, hours BLOB NOT NULL,
  PRIMARY KEY(route, day)
) WITHOUT ROWID;
CREATE TABLE calendar(date TEXT PRIMARY KEY, day TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE corridor(id INTEGER PRIMARY KEY, zone TEXT, color TEXT, shape BLOB NOT NULL);
CREATE TABLE change(date TEXT NOT NULL, kind TEXT NOT NULL, route TEXT, stop TEXT, text TEXT NOT NULL, detail TEXT);
CREATE INDEX change_route ON change(route);
CREATE TABLE alias(old TEXT PRIMARY KEY, new TEXT NOT NULL, date TEXT NOT NULL) WITHOUT ROWID;
CREATE VIRTUAL TABLE search USING fts5(
  kind UNINDEXED, ref UNINDEXED, code, title, extra,
  tokenize = "unicode61 remove_diacritics 2", prefix = "1 2 3"
);
"""

SYSTEM_ORDER = ['troncal', 'dual', 'alimentador', 'zonal', 'cable']
DAYS = ['habil', 'sabado', 'festivo']


def log(*a):
    print('[app-db]', *a, file=sys.stderr)


# ── Codificación ──────────────────────────────────────────────────────────────────────────────

def varints(values) -> bytes:
    """Enteros en zigzag + varint (el mismo decodificador sirve para todo)."""
    out = bytearray()
    for v in values:
        z = (v << 1) ^ (v >> 63)
        while True:
            b = z & 0x7F
            z >>= 7
            if z:
                out.append(b | 0x80)
            else:
                out.append(b)
                break
    return bytes(out)


def unvarints(blob: bytes) -> list[int]:
    out, z, shift = [], 0, 0
    for b in blob:
        z |= (b & 0x7F) << shift
        if b & 0x80:
            shift += 7
            continue
        out.append((z >> 1) ^ -(z & 1))
        z, shift = 0, 0
    return out


def encode_coords(coords: list[tuple[float, float]]) -> bytes:
    """(lon, lat) en grados → ×100.000, primero absoluto y luego diferencias."""
    flat, plon, plat = [], 0, 0
    for lon, lat in coords:
        a, b = round(lon * E5), round(lat * E5)
        if flat and a == plon and b == plat:
            continue
        flat += [a - plon, b - plat]
        plon, plat = a, b
    return varints(flat)


def decode_coords(blob: bytes) -> list[tuple[float, float]]:
    v = unvarints(blob)
    out, lon, lat = [], 0, 0
    for i in range(0, len(v), 2):
        lon += v[i]
        lat += v[i + 1]
        out.append((lon / E5, lat / E5))
    return out


def page_shape(flat: list[int], scale: int) -> list[tuple[float, float]]:
    """Recorrido de la página (diferencias a `scale`) → grados."""
    out, x, y = [], 0, 0
    for i in range(0, len(flat), 2):
        x += flat[i]
        y += flat[i + 1]
        out.append((x / scale, y / scale))
    return out


def ink_on(hex_color: str) -> str:
    """Texto legible sobre el color: el de mayor contraste WCAG entre blanco y casi negro."""
    def lum(h: str) -> float:
        def ch(c: float) -> float:
            return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
    L = lum(hex_color)
    white = 1.05 / (L + 0.05)
    dark = (L + 0.05) / (lum('#07090b') + 0.05)
    return '#07090b' if dark >= white else '#ffffff'


def fold(s: str) -> str:
    """Sin tildes ni mayúsculas (para `extra` de la búsqueda; FTS5 también quita tildes)."""
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn').lower()


# ── Entradas ─────────────────────────────────────────────────────────────────────────────────

def gtfs_fare(gtfs: Path | None) -> tuple[int, int, str | None]:
    """Tarifa y ventana de transbordo de `fare_attributes.txt`; fecha del feed de `feed_info.txt`."""
    fare, transfer, version = 3550, 7500, None
    if not gtfs or not gtfs.exists():
        log('sin GTFS: tarifa y transbordo por defecto (3550, 7500 s)')
        return fare, transfer, version
    with zipfile.ZipFile(gtfs) as z:
        names = set(z.namelist())
        if 'fare_attributes.txt' in names:
            rows = list(csv.DictReader(io.TextIOWrapper(z.open('fare_attributes.txt'), 'utf-8-sig')))
            if rows:
                fare = round(float(rows[0]['price']))
                if rows[0].get('transfer_duration'):
                    transfer = int(rows[0]['transfer_duration'])
        # Fecha del GTFS: la de sus archivos (el feed_version de TRANSMILENIO es «1»).
        if 'routes.txt' in names:
            y, mo, dd = z.getinfo('routes.txt').date_time[:3]
            version = f'{y:04d}-{mo:02d}-{dd:02d}'
    return fare, transfer, version


def load(data: Path) -> dict:
    j = lambda n: json.loads((data / n).read_text())
    d = {
        'network': j('network.json'), 'patterns': j('patterns.json'), 'service': j('service.json'),
        'stops': j('stops.json'), 'meta': j('meta.json'), 'corridors': j('corridors.json'),
        'changes': j('changes.json') if (data / 'changes.json').exists() else {'entries': [], 'aliases': {}},
    }
    shapes = {}
    for n in ('shapes-core.json', 'shapes-zonal.json'):
        s = j(n)
        for k, v in s['shapes'].items():
            shapes[k] = page_shape(v, s['scale'])
    d['shapes'] = shapes
    return d


# ── Construcción ─────────────────────────────────────────────────────────────────────────────

def undelta(a):
    out, acc = [], 0
    for v in a:
        acc += v
        out.append(acc)
    return out


def build(d: dict, db_path: Path, fare: int, transfer: int, gtfs_version: str | None) -> dict:
    """Escribe la base. Devuelve conteos y la huella de contenido."""
    if db_path.exists():
        db_path.unlink()
    con = sqlite3.connect(db_path)
    con.execute('PRAGMA journal_mode=OFF')
    con.execute('PRAGMA page_size=4096')
    con.executescript(SCHEMA_SQL)
    h = hashlib.sha256()

    def ins(table: str, row: tuple):
        con.execute(f'INSERT INTO {table} VALUES ({",".join("?" * len(row))})', row)
        h.update(table.encode())
        h.update(repr(row).encode())

    net, meta = d['network'], d['meta']

    for i, s in enumerate(sorted(net['systems'], key=lambda s: SYSTEM_ORDER.index(s['key']) if s['key'] in SYSTEM_ORDER else 99)):
        ins('system', (s['key'], s['name'], s['color'], i))

    routes = sorted(net['routes'], key=lambda r: r['id'])
    pats = d['patterns']['patterns']
    pat_stops: dict[str, list[str]] = {}
    pat_s: dict[str, list[int]] = {}
    legs_of: dict[str, list[tuple]] = {}
    no_shape = []
    for r in routes:
        rid = r['id']
        coords = d['shapes'].get(rid)
        if not coords:
            no_shape.append(r['code'])
            coords = []
        p = pats.get(rid)
        stops = p['stops'] if p else []
        s_abs = undelta(p['s']) if p else []
        pat_stops[rid], pat_s[rid] = stops, s_abs
        codes = r.get('codes') or [r['code']]
        if r.get('loop'):
            kind = 'circuito'
        elif len(codes) > 1:
            kind = 'par'
        else:
            kind = 'simple'
        lons = [c[0] for c in coords] or [0]
        lats = [c[1] for c in coords] or [0]
        ins('route', (
            rid, r['code'], ' '.join(codes), r['name'], r.get('origin'), r['dest'], r['sys'], r.get('sub'),
            r.get('zone'), r['color'], ink_on(r['color']), int(r['len']), len(stops) or int(r.get('stops', 0)),
            kind, json.dumps(r['pair']) if r.get('pair') else None, encode_coords(coords),
            min(lats), min(lons), max(lats), max(lons),
        ))
        # Tramos: los de la página (cambio de `stop_headsign`); si no, uno con los códigos conocidos.
        last = max(len(stops) - 1, 0)
        if r.get('legs'):
            lg = r['legs']
            rows = []
            for k, l in enumerate(lg):
                to = lg[k + 1]['i'] if k + 1 < len(lg) else last
                rows.append((rid, k, l['c'], l['d'], l['i'], to, int(l['s']), int(l['b'])))
        else:
            rows = [(rid, 0, '/'.join(codes), r['dest'], 0, last, 0, 0)]
        legs_of[rid] = rows
        for row in rows:
            ins('route_leg', row)
    if no_shape:
        log(f'{len(no_shape)} rutas sin recorrido: {", ".join(no_shape[:10])}')

    # Paradas: estaciones, sus vagones y los paraderos de la calle.
    n = 0
    stop_rows = []
    for st in sorted(net['stations'], key=lambda s: s['id']):
        n += 1
        kind = 'portal' if st['kind'] == 'portal' else 'estacion'
        note = 'provisional' if st.get('prov') else None
        stop_rows.append((n, st['id'], None, st['name'], st.get('short'), st['lat'], st['lon'], kind, None,
                          1 if st.get('closed') else 0, note))
        for pl in sorted(st.get('platforms', []), key=lambda p: p['id']):
            n += 1
            code = pl.get('code') if pl.get('code') and pl.get('code') != pl.get('name') else None
            stop_rows.append((n, pl['id'], code, pl['name'], None, pl['lat'], pl['lon'], 'vagon', st['id'],
                              1 if st.get('closed') else 0, None))
    cols = d['stops']['cols']
    ix = {c: i for i, c in enumerate(cols)}
    for row in sorted(d['stops']['stops'], key=lambda r: r[ix['id']]):
        n += 1
        stop_rows.append((n, row[ix['id']], row[ix['code']] or None, row[ix['name']], None, row[ix['lat']],
                          row[ix['lon']], 'paradero', None, 0, None))
    seen = set()
    for row in stop_rows:
        if row[1] in seen:
            continue
        seen.add(row[1])
        ins('stop', row)
        con.execute('INSERT INTO stop_rt VALUES (?,?,?,?,?)', (row[0], row[5], row[5], row[6], row[6]))

    # Rutas que paran en cada parada, con el tramo (índice en el patrón).
    sr = set()
    for rid, stops in pat_stops.items():
        rows = legs_of[rid]
        for i, sid in enumerate(stops):
            leg = 0
            for row in rows:
                if row[4] <= i:
                    leg = row[1]
            sr.add((sid, rid, leg))
    # Estaciones (las rutas paran en sus vagones; la estación las reúne).
    parent = {r[1]: r[8] for r in stop_rows if r[8]}
    for sid, rid, leg in list(sr):
        if sid in parent:
            sr.add((parent[sid], rid, leg))
    for row in sorted(sr):
        ins('stop_route', row)

    for rid in sorted(pats):
        p = pats[rid]
        ts = [varints(t) if t else None for t in (p['t'] + [None] * 5)[:5]]
        ins('pattern', (rid, ' '.join(p['stops']), varints(p['s']), *ts, int(p['trips'])))

    for rid in sorted(d['service']['service']):
        for day in DAYS:
            sv = d['service']['service'][rid].get(day)
            if not sv:
                continue
            hours = bytes(min(255, max(0, int(x))) for x in (sv['h'] + [0] * 30)[:30])
            ins('service', (rid, day, sv.get('first'), sv.get('last'), hours))

    for date, day in sorted((meta.get('days') or {}).items()):
        ins('calendar', (date, day))

    zone_color = {r['zone']: r['color'] for r in routes if r.get('zone')}
    for i, seg in enumerate(d['corridors']['segments']):
        ins('corridor', (i + 1, seg.get('z'), zone_color.get(seg.get('z')), encode_coords([tuple(c) for c in seg['c']])))

    for e in d['changes'].get('entries', []):
        detail = {k: v for k, v in e.items() if k not in ('date', 'kind', 'route', 'station', 'stop', 'text')}
        ins('change', (e['date'], e['kind'], e.get('route'), e.get('station') or e.get('stop'), e['text'],
                       json.dumps(detail, ensure_ascii=False) if detail else None))
    aliases = d['changes'].get('aliases') or {}
    for old, (new, date) in sorted(aliases.items()):
        ins('alias', (old, new, date))

    # Búsqueda: ruta, tramo, estación, paradero.
    for r in routes:
        codes = r.get('codes') or [r['code']]
        ins('search', ('route', r['id'], ' '.join(dict.fromkeys([r['code'], *codes])), r['name'],
                       fold(f"{r.get('origin') or ''} {r['dest']}")))
        rows = legs_of[r['id']]
        if len(rows) > 1:
            for row in rows:
                ins('search', ('leg', f"{r['id']}:{row[1]}", row[2], f'{row[2]} hacia {row[3]}', fold(r['name'])))
    for row in stop_rows:
        if row[7] == 'vagon':
            continue
        ins('search', ('station' if row[7] in ('estacion', 'portal') else 'stop', row[1], row[2] or '', row[3],
                       fold(row[4] or '')))

    counts = {
        'routes': len(routes),
        'stops': sum(1 for r in stop_rows if r[7] == 'paradero'),
        'stations': sum(1 for r in stop_rows if r[7] in ('estacion', 'portal')),
        'platforms': sum(1 for r in stop_rows if r[7] == 'vagon'),
        'legs': sum(len(v) for v in legs_of.values()),
    }
    # Tipos de bus por serie y número de flota (data/curated/fleet.json): la ficha del bus dice si es
    # articulado, biarticulado o dual. Entra en la huella.
    fleet_json = None
    fleet = ROOT / 'data' / 'curated' / 'fleet.json'
    if fleet.exists():
        f = json.loads(fleet.read_text())
        fleet_json = json.dumps({k: f[k] for k in ('types', 'ranges', 'routes') if k in f}, ensure_ascii=False, separators=(',', ':'))
        h.update(fleet_json.encode())
    content = h.hexdigest()[:16]
    feed = meta.get('feed') or {}
    m = {
        'schema': str(SCHEMA), 'hash': content, 'built': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'gtfs': gtfs_version or meta.get('built', '')[:10], 'feed_start': feed.get('start'), 'feed_end': feed.get('end'),
        'fare_cop': str(fare), 'transfer_s': str(transfer), 'bands': json.dumps(meta.get('bands')),
        'projection': json.dumps(meta.get('projection')), 'counts': json.dumps(counts), 'page_hash': meta.get('hash'),
    }
    if fleet_json:
        m['fleet'] = fleet_json
    for k, v in sorted(m.items()):
        con.execute('INSERT INTO meta VALUES (?,?)', (k, v))
    con.execute("INSERT INTO search(search) VALUES('optimize')")
    con.commit()
    con.execute('VACUUM')
    con.close()
    return {'hash': content, 'counts': counts, 'gtfs': m['gtfs'], 'built': m['built']}


# ── Validación ───────────────────────────────────────────────────────────────────────────────

def validate(db_path: Path, prev_counts: dict | None = None) -> list[str]:
    """Problemas de la base (lista vacía: sirve). La usan el flujo y `test_app_db.py`."""
    errors = []
    con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    q = lambda sql, *a: con.execute(sql, a).fetchall()
    if q('PRAGMA integrity_check')[0][0] != 'ok':
        errors.append('integrity_check')
    meta = dict(q('SELECT key, value FROM meta'))
    if meta.get('schema') != str(SCHEMA):
        errors.append(f'esquema {meta.get("schema")}')
    counts = json.loads(meta.get('counts', '{}'))
    if counts.get('routes', 0) < 500 or counts.get('stops', 0) < 3000 or counts.get('stations', 0) < 100:
        errors.append(f'conteos bajos: {counts}')
    if prev_counts:
        for k in ('routes', 'stops', 'stations'):
            a, b = prev_counts.get(k), counts.get(k)
            if a and b and abs(b - a) / a > 0.2:
                errors.append(f'{k}: {a} → {b} (más del 20 %)')
    # Una consulta de cada tipo.
    if not q("SELECT 1 FROM route WHERE code = 'B10'"):
        errors.append('ruta B10')
    if not q("SELECT 1 FROM route_leg WHERE code = 'C153'"):
        errors.append('tramo C153')
    if not q('SELECT n FROM stop_rt WHERE lat0 <= 4.66 AND lat1 >= 4.64 AND lon0 <= -74.05 AND lon1 >= -74.07'):
        errors.append('paradas cerca de la Calle 72')
    for term, kind in (('k635', 'leg'), ('gaitana', 'leg'), ('"calle 72"', 'station')):
        if not q('SELECT 1 FROM search WHERE search MATCH ? AND kind = ?', term, kind):
            errors.append(f'búsqueda {term}')
    bad = q('SELECT COUNT(*) FROM stop_route sr LEFT JOIN stop s ON s.id = sr.stop WHERE s.id IS NULL')[0][0]
    if bad:
        errors.append(f'{bad} paradas de rutas sin fila en stop')
    row = q("SELECT shape, len FROM route WHERE code = 'B10' LIMIT 1")
    if row:
        pts = decode_coords(row[0][0])
        if len(pts) < 10 or not (-74.3 < pts[0][0] < -73.9 and 4.4 < pts[0][1] < 4.9):
            errors.append('recorrido de B10 mal decodificado')
    con.close()
    return errors


# ── Principal ────────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=str(ROOT / 'public' / 'data'))
    ap.add_argument('--gtfs')
    ap.add_argument('--out', default=str(ROOT / 'public' / 'data' / 'app' / 'v1'))
    ap.add_argument('--prev', help='manifest.json anterior (para comparar conteos)')
    a = ap.parse_args()
    data, out = Path(a.data), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    fare, transfer, version = gtfs_fare(Path(a.gtfs) if a.gtfs else None)
    d = load(data)
    tmp = ROOT / '.cache' / 'red.sqlite'
    tmp.parent.mkdir(exist_ok=True)
    info = build(d, tmp, fare, transfer, version)
    prev = None
    if a.prev and Path(a.prev).exists():
        try:
            prev = json.loads(Path(a.prev).read_text()).get('counts')
        except ValueError:
            prev = None
    errors = validate(tmp, prev)
    if errors:
        for e in errors:
            log('ERROR', e)
        sys.exit(1)
    raw = tmp.read_bytes()
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb', compresslevel=9, mtime=0, filename='') as g:
        g.write(raw)
    gz = buf.getvalue()
    name = f"red-{info['hash']}.sqlite.gz"
    for old in out.glob('red-*.sqlite.gz'):
        if old.name != name:
            old.unlink()
    (out / name).write_bytes(gz)
    manifest = {
        'schema': SCHEMA, 'built': info['built'], 'gtfs': info['gtfs'], 'hash': info['hash'],
        'package': {'file': name, 'bytes': len(gz), 'sha256': hashlib.sha256(gz).hexdigest(),
                    'rawBytes': len(raw), 'rawSha256': hashlib.sha256(raw).hexdigest()},
        'counts': info['counts'], 'minApp': MIN_APP,
    }
    (out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n')
    log(f"{name}: {len(raw) / 1e6:.1f} MB ({len(gz) / 1e6:.2f} MB comprimido); {info['counts']}")


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Cambios en la red entre dos compilaciones de datos (decisión 011 en el repositorio del Worker).

    python3 tools/diff_network.py CARPETA_ANTERIOR CARPETA_NUEVA [--date AAAA-MM-DD] [--summary resumen.md]

Lee network.json, patterns.json y stops.json de las dos carpetas (y changes.json de la anterior, si
existe) y escribe CARPETA_NUEVA/changes.json:

    entries   cambios con fecha: rutas nuevas, retiradas, con paradas distintas o renombradas;
              estaciones nuevas, cerradas, reabiertas o renombradas. Últimos 60 días.
    aliases   id anterior → id nuevo de las rutas que TRANSMILENIO re-emitió con otro route_id (pasa
              con cientos de rutas entre versiones): enlaces y favoritos siguen funcionando. 120 días.

Las rutas no se comparan por id: dentro de cada (sistema, código) se emparejan por el parecido de sus
paradas (a nivel de estación), así un id nuevo con el mismo servicio no aparece como «ruta nueva».

`build_data.py` lo llama solo al compilar sobre una carpeta que ya tenía datos (en CI, los publicados).
"""
from __future__ import annotations

import argparse
import json
from datetime import date, timedelta
from pathlib import Path

KEEP_DAYS = 60
ALIAS_DAYS = 120
# Un día con al menos tantas estaciones «nuevas» no son cambios: es una compilación que no tuvo con qué
# comparar (la primera publicación lo registró así: toda la red nueva el 6 nov. 2026).
NO_BASE_STATIONS = 25
MATCH_MIN = 0.5


def read(d: Path, name: str):
    p = d / name
    return json.loads(p.read_text()) if p.exists() else None


def undelta(pf):
    if not pf or pf.get('v') != 2:
        return pf['patterns'] if pf else {}
    out = {}
    for rid, p in pf['patterns'].items():
        s = list(p['s'])
        for i in range(1, len(s)):
            s[i] += s[i - 1]
        out[rid] = {**p, 's': s}
    return out


class Net:
    """Lo necesario de una compilación: rutas, estaciones y la secuencia de lugares de cada ruta."""

    def __init__(self, d: Path):
        n = read(d, 'network.json') or {'routes': [], 'stations': []}
        self.routes = {r['id']: r for r in n['routes']}
        self.stations = {s['id']: s for s in n['stations']}
        place = {}
        for s in n['stations']:
            place[s['id']] = ('s', s['id'], s.get('short') or s['name'])
            for p in s.get('platforms') or []:
                place[p['id']] = ('s', s['id'], s.get('short') or s['name'])
        st = read(d, 'stops.json')
        if st:
            ci = {c: i for i, c in enumerate(st['cols'])}
            for row in st['stops']:
                place.setdefault(row[ci['id']], ('p', row[ci['id']], row[ci['name']]))
        self.place = place
        pats = undelta(read(d, 'patterns.json'))
        self.seq: dict[str, list[tuple]] = {}
        for rid, p in pats.items():
            out = []
            for sid in p['stops']:
                pl = place.get(sid, ('p', sid, sid))
                if not out or out[-1][1] != pl[1]:
                    out.append(pl)
            self.seq[rid] = out

    def places(self, rid: str) -> set:
        return {(k, i) for k, i, _ in self.seq.get(rid, [])}

    def names(self, rid: str) -> dict:
        return {(k, i): n for k, i, n in self.seq.get(rid, [])}


def similarity(a: Net, ra: str, b: Net, rb: str) -> float:
    pa, pb = a.places(ra), b.places(rb)
    if not pa and not pb:
        return 1.0 if a.routes[ra]['dest'] == b.routes[rb]['dest'] else 0.0
    j = len(pa & pb) / max(1, len(pa | pb))
    if a.routes[ra]['dest'] == b.routes[rb]['dest']:
        j += 0.15
    return j


def label(r: dict) -> str:
    return f"{r['code']} hacia {r['dest']}"


def diff(a: Net, b: Net, day: str) -> tuple[list[dict], dict[str, str]]:
    entries: list[dict] = []
    aliases: dict[str, str] = {}

    def route_entry(kind: str, r: dict, text: str, **extra):
        entries.append({'date': day, 'kind': kind, 'sys': r['sys'], 'route': r['id'], 'code': r['code'], 'dest': r['dest'], 'color': r.get('color'), 'text': text, **extra})

    def compare(ra: str, rb: str):
        """Misma ruta (mismo id o emparejada): destino y paradas."""
        old, new = a.routes[ra], b.routes[rb]
        if old['code'] != new['code']:
            route_entry('route-renamed', new, f"La ruta {old['code']} ahora es la {new['code']} ({new['dest']})", before=old['code'])
        elif old['dest'] != new['dest']:
            route_entry('route-renamed', new, f"{new['code']}: el destino {old['dest']} ahora se llama {new['dest']}", before=old['dest'])
        pa, pb = a.names(ra), b.names(rb)
        added = [pb[k] for k in pb if k not in pa]
        removed = [pa[k] for k in pa if k not in pb]
        if added or removed:
            parts = []
            if added:
                parts.append('ahora para en ' + ', '.join(added[:6]) + ('…' if len(added) > 6 else ''))
            if removed:
                parts.append('ya no para en ' + ', '.join(removed[:6]) + ('…' if len(removed) > 6 else ''))
            route_entry('route-stops', new, f"{label(new)}: " + ' · '.join(parts), add=added, remove=removed)

    same = [rid for rid in b.routes if rid in a.routes]
    for rid in same:
        compare(rid, rid)

    gone = [rid for rid in a.routes if rid not in b.routes]
    new = [rid for rid in b.routes if rid not in a.routes]
    by_key_old: dict[tuple, list[str]] = {}
    for rid in gone:
        r = a.routes[rid]
        by_key_old.setdefault((r['sys'], r['code']), []).append(rid)
    codes_before = {(r['sys'], r['code']) for r in a.routes.values()}
    codes_after = {(r['sys'], r['code']) for r in b.routes.values()}
    matched_old: set[str] = set()
    for rid in new:
        r = b.routes[rid]
        cands = [o for o in by_key_old.get((r['sys'], r['code']), []) if o not in matched_old]
        best = max(cands, key=lambda o: similarity(a, o, b, rid), default=None)
        if best is not None and similarity(a, best, b, rid) >= MATCH_MIN:
            matched_old.add(best)
            aliases[best] = rid
            compare(best, rid)
        elif (r['sys'], r['code']) in codes_before:
            route_entry('route-variant', r, f"Nuevo recorrido de la {label(r)}")
        else:
            route_entry('route-new', r, f"Nueva ruta {label(r)}")
    for rid in gone:
        if rid in matched_old:
            continue
        r = a.routes[rid]
        if (r['sys'], r['code']) in codes_after:
            # Otra variante del mismo código sigue: el enlace viejo lleva a la más parecida.
            alts = [x for x in b.routes if (b.routes[x]['sys'], b.routes[x]['code']) == (r['sys'], r['code'])]
            if alts:
                aliases[rid] = max(alts, key=lambda x: similarity(a, rid, b, x))
            route_entry('route-variant-gone', r, f"Deja de operar el recorrido de la {label(r)}")
        else:
            route_entry('route-gone', r, f"Sale de servicio la ruta {label(r)}")

    for sid, s in b.stations.items():
        old = a.stations.get(sid)
        name = s.get('short') or s['name']
        if not old:
            entries.append({'date': day, 'kind': 'station-new', 'station': sid, 'text': f"Nueva estación {name}"})
            continue
        if bool(old.get('closed')) != bool(s.get('closed')):
            kind = 'station-closed' if s.get('closed') else 'station-open'
            entries.append({'date': day, 'kind': kind, 'station': sid, 'text': f"{'Cierra' if s.get('closed') else 'Reabre'} la estación {name}"})
        oldname = old.get('short') or old['name']
        if oldname != name:
            entries.append({'date': day, 'kind': 'station-renamed', 'station': sid, 'text': f"La estación {oldname} ahora se llama {name}", 'before': oldname})
    for sid, s in a.stations.items():
        if sid not in b.stations:
            entries.append({'date': day, 'kind': 'station-gone', 'station': sid, 'text': f"La estación {s.get('short') or s['name']} sale del mapa"})
    return entries, aliases


SYS_ORDER = {'troncal': 0, 'dual': 1, 'cable': 2, 'alimentador': 3, 'zonal': 4}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('prev')
    ap.add_argument('new')
    ap.add_argument('--date')
    ap.add_argument('--summary')
    args = ap.parse_args()
    run(Path(args.prev), Path(args.new), args.date, Path(args.summary) if args.summary else None)


def run(prev: Path, new: Path, day: str | None = None, summary: Path | None = None) -> dict:
    meta = read(new, 'meta.json') or {}
    day = day or (meta.get('built') or date.today().isoformat())[:10]
    hist = read(prev, 'changes.json') or {'v': 1, 'entries': [], 'aliases': {}}
    # Fuera del historial los días sin base (la red entera como nueva).
    per_day: dict[str, int] = {}
    for e in hist.get('entries', []):
        if e['kind'] == 'station-new':
            per_day[e['date']] = per_day.get(e['date'], 0) + 1
    bogus = {d for d, n in per_day.items() if n >= NO_BASE_STATIONS}
    hist['entries'] = [e for e in hist.get('entries', []) if e['date'] not in bogus]
    same_data = (read(prev, 'meta.json') or {}).get('hash') == meta.get('hash') and meta.get('hash')
    # Sin red anterior (la primera publicación, o si no se pudo bajar lo publicado) no hay cambios que
    # contar: comparar contra nada daría la red entera como nueva.
    no_base = read(prev, 'network.json') is None
    entries, aliases = ([], {}) if same_data or no_base else diff(Net(prev), Net(new), day)
    entries.sort(key=lambda e: (SYS_ORDER.get(e.get('sys', ''), -1), e['kind'], e.get('code', ''), e['text']))

    cut = (date.fromisoformat(day) - timedelta(days=KEEP_DAYS)).isoformat()
    old_entries = [e for e in hist.get('entries', []) if e['date'] >= cut and e['date'] != day]
    # Alias: los anteriores se encadenan con los de hoy (A→B y B→C dan A→C); fuera los vencidos y los
    # que apuntan a rutas que ya no existen.
    b_routes = {r['id'] for r in (read(new, 'network.json') or {'routes': []})['routes']}
    acut = (date.fromisoformat(day) - timedelta(days=ALIAS_DAYS)).isoformat()
    out_alias: dict[str, list] = {}
    for old_id, (target, since) in (hist.get('aliases') or {}).items():
        target = aliases.get(target, target)
        if since >= acut and target in b_routes and old_id not in b_routes:
            out_alias[old_id] = [target, since]
    for old_id, target in aliases.items():
        if target in b_routes and old_id not in b_routes:
            out_alias[old_id] = [target, day]
    out = {'v': 1, 'updated': day, 'entries': entries + old_entries, 'aliases': out_alias}
    (new / 'changes.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))

    if summary:
        from collections import Counter
        c = Counter((e['kind'], e.get('sys', 'estación')) for e in entries)
        lines = [f'## Cambios en la red · {day}', '']
        if same_data:
            lines.append('Sin cambios: el paquete es el mismo que el publicado.')
        elif no_base:
            lines.append('Sin red anterior con qué comparar (primera publicación o descarga fallida): no se registran cambios.')
        elif not entries:
            lines.append('Sin cambios visibles (horarios o geometría solamente).')
        else:
            lines += ['| Tipo | Sistema | Cantidad |', '|---|---|---|'] + [f'| {k} | {s} | {n} |' for (k, s), n in sorted(c.items())]
            lines += ['', '### Troncal, dual y cable', '']
            lines += [f"- {e['text']}" for e in entries if e.get('sys') in ('troncal', 'dual', 'cable') or 'station' in e['kind']][:60]
        lines += ['', f'Alias de ids nuevos hoy: {len(aliases)} · vigentes: {len(out_alias)}']
        summary.write_text('\n'.join(lines) + '\n')
    return out


if __name__ == '__main__':
    main()

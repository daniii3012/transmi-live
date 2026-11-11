<script lang="ts">
  import { app } from '../app/store.svelte';
  import { go } from '../app/router';
  import { ctl } from '../app/instance';
  import { FILTER_GROUPS, FILTER_KEYS, classOf, groupState, toggle as toggleKeys, solo as soloKeys, type FilterKey, type FilterGroup, type GroupKey } from '../domain/filter';
  import { fmtNum } from '../domain/time';
  import { busesByRoute, arrivals } from './derive';
  import { favorites } from '../app/favorites.svelte';
  import { lonLatDist } from '../domain/geo';
  import { etaText } from '../domain/eta';
  import { meters } from '../domain/time';
  import RouteBadge from './RouteBadge.svelte';
  import { legAtStop } from '../domain/legs';
  import Pulse from './Pulse.svelte';

  const net = $derived(app.net);
  /** Cambios recientes en la red (troncal, dual, cable y estaciones) para el resumen del inicio. */
  let changesReady = $state(false);
  $effect(() => { void net?.loadChanges().then(() => (changesReady = true)); });
  const recent = $derived.by(() => {
    if (!changesReady || !net?.changes.updated) return null;
    const cut = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    const list = net.changes.entries.filter((e) => e.date >= cut && (!e.sys || e.sys === 'troncal' || e.sys === 'dual' || e.sys === 'cable'));
    if (!list.length) return null;
    const n = (k: string) => list.filter((e) => e.kind === k).length;
    const parts = [
      n('route-new') && `${n('route-new')} ${n('route-new') === 1 ? 'ruta nueva' : 'rutas nuevas'}`,
      n('route-stops') && `${n('route-stops')} con paradas distintas`,
      n('route-gone') && `${n('route-gone')} ${n('route-gone') === 1 ? 'retirada' : 'retiradas'}`,
      ...list.filter((e) => e.kind.startsWith('station')).slice(0, 2).map((e) => e.text),
    ].filter(Boolean) as string[];
    const last = list.map((e) => e.date).sort().at(-1)!;
    return { when: new Date(`${last}T12:00:00-05:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }), parts };
  });
  const total = $derived(FILTER_KEYS.reduce((a, k) => a + app.counts[k], 0));
  const visible = $derived(FILTER_KEYS.reduce((a, k) => a + (app.hidden.includes(k) ? 0 : app.counts[k]), 0));
  /** Sistemas (R10.2): cuatro grupos, con su nombre y color del paquete de la red. */
  const groups = $derived(net ? FILTER_GROUPS.map((g) => {
    const sys = net.systems.find((s) => s.key === g.sys);
    const classes = g.classes.map((c) => ({ ...c, color: net.systems.find((s) => s.key === c.sys)?.color ?? sys?.color ?? '#8b939e', n: app.counts[c.key] }));
    return { g, name: sys?.name ?? g.classes[0].name, color: sys?.color ?? '#8b939e', classes, n: classes.reduce((a, c) => a + c.n, 0), shown: classes.reduce((a, c) => a + (app.hidden.includes(c.key) ? 0 : c.n), 0) };
  }) : []);
  const max = $derived(Math.max(1, ...groups.map((x) => x.n)));
  let open = $state<GroupKey[]>([]);

  const top = $derived.by(() => {
    void app.version;
    if (!net || !app.fleet) return [];
    const by = busesByRoute(app.fleet, app.version);
    // Por código (los dos sentidos juntos): una ruta es lo que la gente reconoce.
    const byCode = new Map<string, { id: string; n: number }>();
    for (const [rid, list] of by) {
      const r = net.routes.get(rid);
      const cls = r ? classOf(r.sys, r.sub) : undefined;
      if (!r || (cls && app.hidden.includes(cls))) continue;
      const key = `${r.sys}:${r.code}`;
      const cur = byCode.get(key);
      if (!cur) byCode.set(key, { id: rid, n: list.length });
      else { cur.n += list.length; }
    }
    return [...byCode.values()].sort((a, b) => b.n - a.n).slice(0, 8).map((x) => ({ route: net.routes.get(x.id)!, n: x.n }));
  });

  /** Favoritos: rutas con su número de buses; lugares con su próxima llegada. */
  const favs = $derived.by(() => {
    void app.version;
    if (!net) return [];
    return favorites.list.map((f) => {
      if (f.kind === 'route') { const r = net.routes.get(f.id); return r ? { f, title: r.dest, route: r } : null; }
      const p = f.kind === 'station' ? net.stations.get(f.id) : net.streetStops.get(f.id);
      return p ? { f, title: 'short' in p ? p.short : p.name, route: undefined } : null;
    }).filter((x): x is NonNullable<typeof x> => !!x);
  });

  /** Cerca de ti: estaciones a menos de 1 km y paraderos a menos de 450 m, con su próxima llegada. */
  const near = $derived.by(() => {
    void app.now;
    const pos = app.userPos;
    if (!pos || !net || !app.fleet) return null;
    const places: { kind: 'station' | 'stop'; id: string; name: string; d: number; stopIds: Set<string>; routes: string[] }[] = [];
    for (const s of net.stations.values()) {
      const d = lonLatDist(pos[0], pos[1], s.lon, s.lat);
      if (d < 1000 && !s.closed) places.push({ kind: 'station', id: s.id, name: s.short, d, stopIds: new Set([s.id, ...s.platforms.map((p) => p.id)]), routes: s.routes });
    }
    for (const s of net.streetStops.values()) {
      const d = lonLatDist(pos[0], pos[1], s.lon, s.lat);
      if (d < 450) places.push({ kind: 'stop', id: s.id, name: s.name, d, stopIds: new Set([s.id]), routes: s.routes });
    }
    places.sort((a, b) => a.d - b.d);
    return places.slice(0, 6).map((p) => ({ ...p, next: app.patternsReady ? arrivals(net, app.fleet!, app.version, p.stopIds, p.routes, app.now)[0] : undefined }));
  });

  // Ocultarlos todos no tiene sentido: lo último visible no se apaga (`toggle` devuelve null).
  function toggle(keys: FilterKey[]) {
    const h = toggleKeys(app.hidden, keys);
    if (!h) return;
    app.hidden = h;
    ctl?.setHidden(h);
  }
  function solo(keys: FilterKey[]) {
    app.hidden = soloKeys(app.hidden, keys);
    ctl?.setHidden(app.hidden);
  }
  const keysOf = (g: FilterGroup) => g.classes.map((c) => c.key);
  function expand(k: GroupKey) { open = open.includes(k) ? open.filter((x) => x !== k) : [...open, k]; }
</script>

<div class="home">
  <section class="hero">
    <div class="label">Buses en vía</div>
    <div class="figure num">{fmtNum(visible)}</div>
    <div class="sub dim">
      {#if app.hidden.length}de {fmtNum(total)} · filtro activo{:else if net}{fmtNum(net.routes.size)} rutas · {fmtNum(net.stations.size)} estaciones{/if}
    </div>
  </section>

  <Pulse />

  <button class="search" onclick={() => (app.searchOpen = true)}>
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M11 11 L15 15" stroke="currentColor" stroke-width="1.5" /></svg>
    <span>Ruta, estación, paradero o bus</span>
    {#if !app.narrow}<kbd>/</kbd>{/if}
  </button>

  <button class="locate" onclick={() => go({ kind: 'plan', id: '' })}>
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="3" cy="3" r="2" /><rect x="11" y="11" width="4" height="4" /><path d="M3 5v4a3 3 0 0 0 3 3h5" /></svg>
    Planear un viaje
  </button>

  {#if near}
    <section class="block">
      <div class="head"><span class="label">Cercanos</span><span class="label hint">próxima llegada</span></div>
      {#if near.length === 0}
        <p class="empty faint">Ninguna estación ni paradero cerca.</p>
      {:else}
        <ul class="routes">
          {#each near as p (p.kind + p.id)}
            <li>
              <button class="row near" onclick={() => go({ kind: p.kind, id: p.id })}>
                <span class="place" class:stop={p.kind === 'stop'}></span>
                <span class="dest">{p.name}<span class="faint">&nbsp;· {meters(p.d)}</span></span>
                {#if p.next}<span class="nx"><RouteBadge route={p.next.route} code={legAtStop(p.next.route, p.next.index)?.c} size="sm" /><span class="num">{etaText(p.next.seconds)}</span></span>{:else}<span class="faint num">—</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {:else}
    <button class="locate" onclick={() => ctl?.locate()} disabled={app.locating}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="4" /><path d="M8 0v3M8 13v3M0 8h3M13 8h3" /></svg>
      {app.locating ? 'Buscando la ubicación…' : 'Estaciones y paraderos cercanos'}
    </button>
  {/if}

  {#if favs.length}
    <section class="block">
      <div class="head"><span class="label">Favoritos</span></div>
      <ul class="routes">
        {#each favs as x (x.f.kind + x.f.id)}
          <li>
            <button class="row" onclick={() => go({ kind: x.f.kind, id: x.f.id })}>
              {#if x.route}<RouteBadge route={x.route} />{:else}<span class="place" class:stop={x.f.kind === 'stop'}></span>{/if}
              <span class="dest">{x.title}</span>
              <span></span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if recent}
    <section class="block">
      <div class="head"><span class="label">Cambios en la red</span><span class="label hint">{recent.when}</span></div>
      <button class="changes" onclick={() => go({ kind: 'changes', id: '' })}>
        <span>{recent.parts.join(' · ')}</span><span class="go" aria-hidden="true">›</span>
      </button>
    </section>
  {/if}

  <section class="block">
    <div class="head"><span class="label">Sistemas</span><span class="label hint">mostrar u ocultar</span></div>
    <ul class="systems">
      {#each groups as x (x.g.key)}
        {@const st = groupState(app.hidden, x.g)}
        {@const many = x.classes.length > 1}
        {@const isOpen = many && open.includes(x.g.key)}
        <li>
          <div class="grp">
            <button class="sys" class:off={st === 'off'} onclick={() => toggle(keysOf(x.g))} ondblclick={() => solo(keysOf(x.g))} aria-pressed={st === 'on' ? true : st === 'off' ? false : 'mixed'} title={st === 'part' ? 'Visible en parte' : undefined}>
              <span class="swatch" class:part={st === 'part'} style:--c={x.color}></span>
              <span class="name">{x.name}</span>
              <span class="bar"><span style:width="{(x.shown / max) * 100}%" style:background={x.color}></span></span>
              <span class="n num">{fmtNum(x.shown)}</span>
            </button>
            {#if many}
              <button class="more" class:open={isOpen} onclick={() => expand(x.g.key)} aria-expanded={isOpen} aria-label={`Clases de ${x.name}`}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
              </button>
            {:else}<span class="more" aria-hidden="true"></span>{/if}
          </div>
          {#if isOpen}
            <ul class="classes">
              {#each x.classes as c (c.key)}
                {@const off = app.hidden.includes(c.key)}
                <li>
                  <button class="sys cls" class:off onclick={() => toggle([c.key])} ondblclick={() => solo([c.key])} aria-pressed={!off}>
                    <span class="swatch" style:--c={c.color}></span>
                    <span class="name">{c.name}</span>
                    <span class="bar"><span style:width="{(c.n / max) * 100}%" style:background={c.color}></span></span>
                    <span class="n num">{fmtNum(c.n)}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  {#if top.length}
    <section class="block">
      <div class="head"><span class="label">Más buses en vía</span></div>
      <ul class="routes">
        {#each top as t (t.route.id)}
          <li>
            <button class="row" onclick={() => go({ kind: 'route', id: t.route.id })}>
              <RouteBadge route={t.route} />
              <span class="dest">{t.route.dest}</span>
              <span class="n num">{t.n}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if app.narrow}
    <!-- En el teléfono el panel no tiene pie: los enlaces del pie van al final del inicio. -->
    <nav class="links" aria-label="Más">
      <span class="about">No oficial</span>
      <a href="#/recorrido">Recorrido</a>
      <a href="#/configuracion">Configuración</a>
      <a href="https://github.com/daniii3012/transmi-live/blob/main/FUENTES.md" target="_blank" rel="noopener">Fuentes</a>
    </nav>
  {/if}
</div>

<style>
  .links { display: flex; gap: var(--sp-4); padding: var(--sp-2) 0 var(--sp-5); font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.04em; }
  .links a { color: var(--fg-2); text-decoration: none; }
  .links .about { color: var(--fg-2); margin-right: auto; }
  .links a:hover { color: var(--fg-0); }
  .home { padding: var(--sp-4); display: grid; gap: var(--sp-5); }
  .hero { display: grid; gap: 2px; }
  .figure { font-size: var(--fs-figure); font-weight: 500; line-height: 1.05; letter-spacing: -0.02em; font-family: var(--font-sans); font-variant-numeric: tabular-nums; }
  .sub { font-size: var(--fs-small); }
  .search {
    height: var(--row);
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: 0 var(--sp-3);
    background: var(--bg-2);
    border: 1px solid var(--line-2);
    color: var(--fg-2);
    text-align: left;
    transition: border-color var(--t-out), color var(--t-out);
  }
  .search span { flex: 1; }
  .search:hover { border-color: var(--fg-3); color: var(--fg-1); }
  kbd { font-family: var(--font-mono); font-size: var(--fs-label); border: 1px solid var(--line-2); padding: 0 5px; line-height: 16px; color: var(--fg-2); }
  .block { display: grid; gap: var(--sp-2); }
  .head { display: flex; justify-content: space-between; align-items: baseline; }
  .hint { color: var(--fg-2); }
  ul { list-style: none; margin: 0; padding: 0; }
  .systems { display: grid; }
  .sys {
    width: 100%;
    height: var(--row);
    display: grid;
    grid-template-columns: 10px 104px 1fr 52px;
    align-items: center;
    gap: var(--sp-3);
    border-bottom: 1px solid var(--line-1);
    text-align: left;
    transition: opacity var(--t-out);
  }
  .swatch { width: 10px; height: 10px; background: var(--c); }
  .swatch.part { background: linear-gradient(135deg, var(--c) 50%, transparent 50%); box-shadow: inset 0 0 0 1px var(--c); }
  .grp { display: grid; grid-template-columns: 1fr 28px; border-bottom: 1px solid var(--line-1); }
  .grp .sys { border-bottom: 0; }
  .more { display: flex; align-items: center; justify-content: center; color: var(--fg-2); }
  button.more:hover { color: var(--fg-0); }
  .more svg { transition: transform 200ms var(--ease-out); }
  .more.open svg { transform: rotate(180deg); }
  .classes { display: grid; border-bottom: 1px solid var(--line-1); }
  .sys.cls { height: 32px; border-bottom: 0; padding-left: var(--sp-4); grid-template-columns: 8px 88px 1fr 52px; margin-right: 28px; width: calc(100% - 28px); }
  .sys.cls .swatch { width: 8px; height: 8px; }
  .sys.cls .name { font-size: var(--fs-small); color: var(--fg-1); }
  @media (pointer: coarse) { .grp { grid-template-columns: 1fr 44px; } .sys.cls { margin-right: 44px; width: calc(100% - 44px); height: 40px; } }
  .name { font-size: var(--fs-body); }
  .bar { height: 2px; background: var(--line-1); position: relative; }
  .bar span { position: absolute; left: 0; top: 0; bottom: 0; transition: width 600ms var(--ease-out); }
  .n { text-align: right; font-size: var(--fs-small); color: var(--fg-1); }
  .sys.off { opacity: 0.32; }
  .sys:hover .name { color: var(--fg-0); }
  .routes { display: grid; }
  .row {
    width: 100%;
    height: var(--row);
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: var(--sp-3);
    border-bottom: 1px solid var(--line-1);
    text-align: left;
  }
  .row:hover { background: var(--bg-2); }
  .dest { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dest .faint { font-size: var(--fs-small); }
  .locate { height: var(--row); display: flex; align-items: center; gap: var(--sp-3); padding: 0 var(--sp-3); border: 1px solid var(--line-1); color: var(--fg-1); font-size: var(--fs-small); text-align: left; }
  .locate:hover { color: var(--fg-0); border-color: var(--line-2); }
  .locate:disabled { color: var(--fg-2); }
  .place { width: 38px; height: 22px; display: inline-flex; align-items: center; justify-content: center; }
  .place::before { content: ''; width: 9px; height: 9px; background: var(--station); }
  .place.stop::before { border-radius: 50%; background: var(--bg-1); border: 1.5px solid var(--stop); }
  .nx { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-small); }
  .empty { margin: 0; font-size: var(--fs-small); }
  .changes { width: 100%; display: grid; grid-template-columns: 1fr auto; gap: var(--sp-3); align-items: center; padding: var(--sp-3); border: 1px solid var(--line-1); text-align: left; font-size: var(--fs-small); color: var(--fg-1); line-height: 1.4; }
  .changes:hover { color: var(--fg-0); border-color: var(--line-2); }
  .changes .go { font-size: 18px; color: var(--fg-2); }
</style>

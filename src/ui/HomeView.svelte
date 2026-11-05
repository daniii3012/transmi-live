<script lang="ts">
  import { app } from '../app/store.svelte';
  import { go } from '../app/router';
  import { ctl } from '../app/instance';
  import { SYSTEM_ORDER, type SystemKey } from '../domain/types';
  import { fmtNum } from '../domain/time';
  import { busesByRoute, arrivals } from './derive';
  import { favorites } from '../app/favorites.svelte';
  import { lonLatDist } from '../domain/geo';
  import { etaText } from '../domain/eta';
  import { meters } from '../domain/time';
  import RouteBadge from './RouteBadge.svelte';
  import Pulse from './Pulse.svelte';

  const net = $derived(app.net);
  const total = $derived(SYSTEM_ORDER.reduce((a, k) => a + app.counts[k], 0));
  const visible = $derived(SYSTEM_ORDER.reduce((a, k) => a + (app.hidden.includes(k) ? 0 : app.counts[k]), 0));
  const max = $derived(Math.max(1, ...SYSTEM_ORDER.map((k) => app.counts[k])));
  const systems = $derived(net ? SYSTEM_ORDER.map((k) => net.systems.find((s) => s.key === k)!).filter(Boolean) : []);

  const top = $derived.by(() => {
    void app.version;
    if (!net || !app.fleet) return [];
    const by = busesByRoute(app.fleet, app.version);
    // Por código (los dos sentidos juntos): una ruta es lo que la gente reconoce.
    const byCode = new Map<string, { id: string; n: number }>();
    for (const [rid, list] of by) {
      const r = net.routes.get(rid);
      if (!r || app.hidden.includes(r.sys)) continue;
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

  function toggle(k: SystemKey) {
    const h = new Set(app.hidden);
    if (h.has(k)) h.delete(k); else h.add(k);
    // Ocultarlos todos no tiene sentido: el último visible no se apaga.
    if (h.size === SYSTEM_ORDER.length) return;
    app.hidden = [...h];
    ctl?.setHidden(app.hidden);
  }
  function solo(k: SystemKey) {
    const all = SYSTEM_ORDER.filter((x) => x !== k);
    app.hidden = app.hidden.length === all.length && !app.hidden.includes(k) ? [] : all;
    ctl?.setHidden(app.hidden);
  }
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
      <div class="head"><span class="label">Cerca de ti</span><span class="label hint">próxima llegada</span></div>
      {#if near.length === 0}
        <p class="empty faint">Ninguna estación ni paradero cerca.</p>
      {:else}
        <ul class="routes">
          {#each near as p (p.kind + p.id)}
            <li>
              <button class="row near" onclick={() => go({ kind: p.kind, id: p.id })}>
                <span class="place" class:stop={p.kind === 'stop'}></span>
                <span class="dest">{p.name}<span class="faint">&nbsp;· {meters(p.d)}</span></span>
                {#if p.next}<span class="nx"><RouteBadge route={p.next.route} size="sm" /><span class="num">{etaText(p.next.seconds)}</span></span>{:else}<span class="faint num">—</span>{/if}
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

  <section class="block">
    <div class="head"><span class="label">Sistemas</span><span class="label hint">mostrar u ocultar</span></div>
    <ul class="systems">
      {#each systems as s (s.key)}
        {@const n = app.counts[s.key]}
        {@const off = app.hidden.includes(s.key)}
        <li>
          <button class="sys" class:off onclick={() => toggle(s.key)} ondblclick={() => solo(s.key)} aria-pressed={!off}>
            <span class="swatch" style:background={s.color}></span>
            <span class="name">{s.name}</span>
            <span class="bar"><span style:width="{(n / max) * 100}%" style:background={s.color}></span></span>
            <span class="n num">{fmtNum(n)}</span>
          </button>
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
</div>

<style>
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
  .swatch { width: 10px; height: 10px; }
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
</style>

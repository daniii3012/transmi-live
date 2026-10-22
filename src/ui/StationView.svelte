<script lang="ts">
  import { app } from '../app/store.svelte';
  import { go } from '../app/router';
  import { arrivals } from './derive';
  import { etaText } from '../domain/eta';
  import { meters } from '../domain/time';
  import { SYSTEM_ORDER, type Route } from '../domain/types';
  import RouteBadge from './RouteBadge.svelte';
  import Back from './Back.svelte';

  let { id, kind }: { id: string; kind: 'station' | 'stop' } = $props();
  const net = $derived(app.net!);
  const station = $derived(kind === 'station' ? net.stations.get(id) : undefined);
  let stopsReady = $state(false);
  $effect(() => { if (kind === 'stop') void net.loadStreetStops().then(() => (stopsReady = true)); });
  const stop = $derived.by(() => (kind === 'stop' && stopsReady ? net.streetStops.get(id) : undefined));
  const place = $derived(station ?? stop);
  const routeIds = $derived(station?.routes ?? stop?.routes ?? []);
  const stopIds = $derived(new Set(station ? [station.id, ...station.platforms.map((p) => p.id)] : stop ? [stop.id] : []));
  const routes = $derived(
    routeIds.map((r) => net.routes.get(r)).filter((r): r is Route => !!r)
      .sort((a, b) => SYSTEM_ORDER.indexOf(a.sys) - SYSTEM_ORDER.indexOf(b.sys) || a.code.localeCompare(b.code, 'es', { numeric: true })),
  );

  /** Próximas llegadas: hasta dos por ruta, las primeras 12. */
  const next = $derived.by(() => {
    void app.now; void app.version;
    if (!app.patternsReady || !app.fleet || !place) return null;
    const all = arrivals(net, app.fleet, app.version, stopIds, routeIds, app.now);
    const per = new Map<string, number>();
    return all.filter((a) => { const n = per.get(a.route.id) ?? 0; per.set(a.route.id, n + 1); return n < 2; }).slice(0, 12);
  });

  /** Vagones con las rutas que paran en cada uno. */
  const platforms = $derived(
    (station?.platforms ?? []).map((p) => ({ ...p, rs: p.routes.map((r) => net.routes.get(r)).filter((r): r is Route => !!r) })).filter((p) => p.rs.length),
  );
  const kindLabel = $derived(station ? (station.kind === 'portal' ? 'Portal' : station.kind === 'cable' ? 'Estación de cable' : 'Estación troncal') : 'Paradero');
</script>

{#if place}
  <div class="view">
    <Back />
    <header>
      <div class="label">{kindLabel}{stop ? ` · ${stop.code}` : ''}</div>
      <h1>{station?.short ?? stop?.name}</h1>
      {#if station && station.name !== station.short}<p class="faint sponsor">{station.name}</p>{/if}
    </header>

    {#if station?.closed}
      <p class="notice">Sin servicio programado en el horario vigente. Varias estaciones de la Caracas están cerradas por las obras del metro.</p>
    {/if}

    <section>
      <div class="head"><span class="label">Próximas llegadas</span><span class="label faint">estimado</span></div>
      {#if next === null}
        <p class="faint small">Calculando…</p>
      {:else if next.length === 0}
        <p class="faint small">Ningún bus en camino hacia aquí en este momento.</p>
      {:else}
        <ul class="arrivals">
          {#each next as a (a.bus.id)}
            <li>
              <button onclick={() => go({ kind: 'bus', id: a.bus.id })}>
                <RouteBadge route={a.route} />
                <span class="dest">{a.route.dest}<span class="faint">&nbsp;· bus {a.bus.label} · {meters(a.meters)}</span></span>
                <span class="eta num" class:soon={a.seconds < 60}>{etaText(a.seconds)}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if routes.length}
      <section>
        <div class="head"><span class="label">Rutas que paran</span><span class="label faint">{routes.length}</span></div>
        <div class="badges">
          {#each routes as r (r.id)}
            <button class="rb" onclick={() => go({ kind: 'route', id: r.id })} title="{r.code} hacia {r.dest}">
              <RouteBadge route={r} size="sm" />
              <span class="to">{r.dest}</span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    {#if platforms.length > 1}
      <section>
        <div class="head"><span class="label">Vagones</span><span class="label faint">dónde para cada ruta</span></div>
        <ul class="platforms">
          {#each platforms as p (p.id)}
            <li>
              <span class="pname">{p.name.replace(station?.short ?? '', '').replace(/^\s*[-–]?\s*/, '') || p.name}</span>
              <span class="pbadges">{#each p.rs as r (r.id)}<RouteBadge route={r} size="sm" />{/each}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
{:else}
  <div class="view"><Back /><p class="faint">{kind === 'stop' && !stopsReady ? 'Cargando…' : 'Lugar no encontrado.'}</p></div>
{/if}

<style>
  .view { padding: var(--sp-4); display: grid; gap: var(--sp-5); }
  h1 { margin: 2px 0 0; font-size: var(--fs-title); font-weight: 500; line-height: 1.2; letter-spacing: -0.01em; }
  .sponsor { margin: 2px 0 0; font-size: var(--fs-small); }
  .notice { margin: 0; padding: var(--sp-3); border: 1px solid var(--line-2); border-left: 2px solid var(--warn); font-size: var(--fs-small); color: var(--fg-1); }
  .head { display: flex; justify-content: space-between; margin-bottom: var(--sp-2); }
  .small { font-size: var(--fs-small); margin: 0; }
  ul { list-style: none; margin: 0; padding: 0; }
  .arrivals li button { width: 100%; height: var(--row); display: grid; grid-template-columns: auto 1fr auto; gap: var(--sp-3); align-items: center; border-bottom: 1px solid var(--line-1); text-align: left; }
  .arrivals li button:hover { background: var(--bg-2); }
  .dest { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dest .faint { font-size: var(--fs-small); }
  .eta { font-size: var(--fs-small); min-width: 56px; text-align: right; }
  .eta.soon { color: var(--fg-0); font-weight: 600; }
  .badges { display: grid; grid-template-columns: 1fr 1fr; gap: 0 var(--sp-3); }
  .rb { display: flex; align-items: center; gap: var(--sp-2); height: 32px; border-bottom: 1px solid var(--line-1); min-width: 0; text-align: left; }
  .rb:hover .to { color: var(--fg-0); }
  .to { color: var(--fg-1); font-size: var(--fs-small); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .platforms li { display: grid; grid-template-columns: 96px 1fr; gap: var(--sp-3); align-items: start; padding: 8px 0; border-bottom: 1px solid var(--line-1); }
  .pname { font-family: var(--font-mono); font-size: var(--fs-label); color: var(--fg-1); line-height: 18px; }
  .pbadges { display: flex; flex-wrap: wrap; gap: 4px; }
</style>

<script lang="ts">
  import { app } from '../app/store.svelte';
  import { go } from '../app/router';
  import { arrivals } from './derive';
  import { etaText } from '../domain/eta';
  import { meters, ago } from '../domain/time';
  import { SYSTEM_ORDER, type Route } from '../domain/types';
  import RouteBadge from './RouteBadge.svelte';
  import { legAtStop } from '../domain/legs';
  import Back from './Back.svelte';
  import Star from './Star.svelte';
  import AlertList from './AlertList.svelte';
  import { encodePlan } from '../planner/places';
  import { ctl } from '../app/instance';

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

  $effect(() => {
    const ids = (next ?? []).slice(0, 6).map((a) => a.bus.id);
    ctl?.setArriving(ids);
    return () => ctl?.setArriving([]);
  });

  /** «Resaltar en el mapa»: modo opcional (apagado al abrir cada estación) que deja en foco solo los
   * buses que llegan, con el tramo que les falta. Se actualiza con cada segundo (los buses avanzan). */
  let spotlight = $state(false);
  let framed = false;
  $effect(() => {
    void id;
    spotlight = false;
    framed = false;
  });
  $effect(() => {
    void app.now;
    if (!spotlight || !next?.length || !place) { ctl?.spotlight(null); framed = false; return; }
    const items = next.slice(0, 8).map((a) => ({ busId: a.bus.id, routeId: a.route.id, s1: a.bus.sFix + a.meters, color: a.route.color }));
    ctl?.spotlight(items, [place.lon, place.lat], !framed);
    framed = true;
  });
  $effect(() => () => ctl?.spotlight(null));

  /** Código del tramo que para aquí (una ruta en par para con uno solo de sus códigos). */
  function legHere(r: Route) {
    if (!r.legs || !app.patternsReady) return null;
    const p = net.pattern(r.id);
    const k = p ? p.stops.findIndex((s) => stopIds.has(s)) : -1;
    return k >= 0 ? legAtStop(r, k) : null;
  }

  function legOn(r: Route, stopId: string) {
    if (!r.legs || !app.patternsReady) return null;
    const k = net.pattern(r.id)?.stops.indexOf(stopId) ?? -1;
    return k >= 0 ? legAtStop(r, k) : null;
  }

  /** Vagones con las rutas que paran en cada uno. */
  const platforms = $derived(
    (station?.platforms ?? []).map((p) => ({ ...p, rs: p.routes.map((r) => net.routes.get(r)).filter((r): r is Route => !!r) })).filter((p) => p.rs.length),
  );
  const alerts = $derived(app.alerts.filter((a) => a.stops.some((s) => stopIds.has(s))));
  const kindLabel = $derived(station ? (station.kind === 'portal' ? 'Portal' : station.kind === 'cable' ? 'Estación de cable' : 'Estación troncal') : 'Paradero');
</script>

{#if place}
  <div class="view">
    <Back />
    <header class="head1">
      <div class="names">
        <div class="label">{kindLabel}{stop ? ` · ${stop.code}` : ''}</div>
        <h1>{station?.short ?? stop?.name}</h1>
        {#if station && station.name !== station.short}<p class="faint sponsor">{station.name}</p>{/if}
      </div>
      <Star kind={kind} {id} />
    </header>

    <AlertList {alerts} />

    <div class="go">
      <button class="btn" onclick={() => go({ kind: 'plan', id: encodePlan({ kind, id }, null, null) })}>Ir desde aquí</button>
      <button class="btn" onclick={() => go({ kind: 'plan', id: encodePlan(null, { kind, id }, null) })}>Ir hasta aquí</button>
    </div>

    {#if station?.closed}
      <p class="notice">Sin servicio programado en el horario vigente.{station.prov ? ' Cerrada por las obras de la primera línea del metro.' : ''}</p>
    {:else if station?.prov}
      <p class="notice">Estación provisional mientras se construye la primera línea del metro.</p>
    {/if}

    <section>
      <div class="head">
        <span class="label">Próximas llegadas</span>
        {#if next?.length}
          <button class="spot" class:on={spotlight} role="switch" aria-checked={spotlight} onclick={() => (spotlight = !spotlight)}
            title="Deja en el mapa solo los buses que llegan, con lo que les falta">
            <span class="sw" aria-hidden="true"></span>Resaltar en el mapa
          </button>
        {:else}
          <span class="label faint">estimado</span>
        {/if}
      </div>
      {#if next === null}
        <p class="faint small">Calculando…</p>
      {:else if next.length === 0}
        <p class="faint small">{app.poll.status === 'stale' || app.poll.status === 'error' ? 'Sin lecturas recientes de los buses: no hay llegadas que estimar.' : 'Ningún bus en camino hacia aquí en este momento.'}</p>
      {:else}
        <ul class="arrivals">
          {#each next as a (a.bus.id)}
            {@const leg = legAtStop(a.route, a.index)}
            <li>
              <button onclick={() => go({ kind: 'bus', id: a.bus.id })}>
                <RouteBadge route={a.route} code={leg?.c} />
                <span class="dest">{leg?.d ?? a.route.dest}<span class="faint">&nbsp;· bus {a.bus.label} · {meters(a.meters)}{#if a.age > 150}&nbsp;· lectura de hace {ago(a.age)}{/if}</span></span>
                <span class="eta num" class:soon={a.seconds < 60}>{etaText(a.seconds)}</span>
              </button>
            </li>
          {/each}
        </ul>
        <p class="faint delay">Las posiciones llegan con 1 a 2 min de retraso. Los tiempos ya lo descuentan, pero un bus «llegando» puede estar en la parada o haber salido.</p>
      {/if}
    </section>

    {#if routes.length}
      <section>
        <div class="head"><span class="label">Rutas que paran</span><span class="label faint">{routes.length}</span></div>
        <div class="badges">
          {#each routes as r (r.id)}
            {@const leg = legHere(r)}
            <button class="rb" onclick={() => go({ kind: 'route', id: r.id })} title="{leg?.c ?? r.code} hacia {leg?.d ?? r.dest}">
              <RouteBadge route={r} code={leg?.c} size="sm" />
              <span class="to">{leg?.d ?? r.dest}</span>
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
              <span class="pbadges">{#each p.rs as r (r.id)}<RouteBadge route={r} code={legOn(r, p.id)?.c} size="sm" />{/each}</span>
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
  .go { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); margin-top: calc(-1 * var(--sp-2)); }
  .btn { height: 32px; border: 1px solid var(--line-2); font-size: var(--fs-small); color: var(--fg-1); }
  .btn:hover { color: var(--fg-0); border-color: var(--fg-3); }
  .head1 { display: flex; gap: var(--sp-3); align-items: flex-start; }
  .names { flex: 1; min-width: 0; }
  h1 { margin: 2px 0 0; font-size: var(--fs-title); font-weight: 500; line-height: 1.2; letter-spacing: -0.01em; }
  .sponsor { margin: 2px 0 0; font-size: var(--fs-small); }
  .notice { margin: 0; padding: var(--sp-3); border: 1px solid var(--line-2); border-left: 2px solid var(--warn); font-size: var(--fs-small); color: var(--fg-1); }
  .head { display: flex; justify-content: space-between; margin-bottom: var(--sp-2); }
  .small { font-size: var(--fs-small); margin: 0; }
  ul { list-style: none; margin: 0; padding: 0; }
  .spot { display: inline-flex; align-items: center; gap: var(--sp-2); height: 24px; padding: 0 var(--sp-2); font-family: var(--font-mono); font-size: var(--fs-label); letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-2); border: 1px solid var(--line-2); }
  .spot:hover { color: var(--fg-0); }
  .spot .sw { width: 14px; height: 8px; border: 1px solid currentColor; position: relative; }
  .spot .sw::after { content: ''; position: absolute; top: 1px; left: 1px; width: 4px; height: 4px; background: currentColor; transition: transform var(--t-in) var(--ease-out); }
  .spot.on { color: var(--bg-1); border-color: var(--fg-0); background: var(--fg-0); }
  .spot.on .sw::after { transform: translateX(6px); }
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
  .delay { margin: var(--sp-3) 0 0; font-size: var(--fs-label); line-height: 1.5; }
</style>

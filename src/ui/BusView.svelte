<script lang="ts">
  import { app } from '../app/store.svelte';
  import { go } from '../app/router';
  import { ctl } from '../app/instance';
  import { etas, etaText, bandIndex, bandTimes, pace, nextStopIndex } from '../domain/eta';
  import { busesByRoute, MAX_FIX_AGE } from './derive';
  import { ago, bogotaSeconds, fmtHM, meters } from '../domain/time';
  import RouteBadge from './RouteBadge.svelte';
  import Back from './Back.svelte';
  import { KIND_NAME } from '../domain/fleetTypes';
  import { KX, KY } from '../domain/geo';
  import { watch } from '../app/watch.svelte';

  /** Avisar cuando el bus esté a 2 min de esa parada (o quitar el aviso). */
  function toggleWatch(e: { index: number; name: string; seconds: number }) {
    if (!bus || !route) return;
    if (watch.is(bus.id, e.index)) { watch.set(null); watch.show(`Aviso de llegada desactivado · ${route.code} en ${e.name}`, null); return; }
    watch.set({ busId: bus.id, busLabel: bus.label, routeCode: route.code, color: route.color, index: e.index, stopName: e.name, threshold: e.seconds > 180 ? 120 : 30 });
    watch.show(`Aviso de llegada activado · ${route.code} en ${e.name} · ${e.seconds > 180 ? '2 min antes' : 'al llegar'}`, null);
  }

  let { id }: { id: string } = $props();
  const net = $derived(app.net!);
  // La ficha se recalcula con cada instantánea y con el reloj de 1 Hz (antigüedad y cuentas).
  const bus = $derived.by(() => { void app.version; return app.fleet?.buses.get(id); });
  const route = $derived(bus?.route);
  const pattern = $derived.by(() => (app.patternsReady && bus ? net.pattern(bus.routeId) : undefined));
  let stopsReady = $state(false);
  $effect(() => { void net.loadStreetStops().then(() => (stopsReady = true)); });
  const age = $derived(bus ? Math.max(0, (app.now - bus.fixAt) / 1000) : 0);
  const progress = $derived(bus && route && route.len ? Math.min(1, Math.max(0, bus.sFix / route.len)) : null);
  const kmh = $derived(bus?.speed != null ? Math.round(bus.speed * 3.6) : null);

  /** Sin lecturas nuevas: el alimentador lo omitió (se conserva unos minutos) o su lectura ya es vieja. */
  const quiet = $derived(!!bus && (bus.missing || age > 180));
  /** Con una lectura de más de 4 min no se estiman llegadas: el bus pudo avanzar o detenerse. */
  const tooOld = $derived(age > MAX_FIX_AGE);

  // El bus ya no está en la flota: lo último que se supo de él (si se abrió en esta sesión), su ruta
  // y los buses que siguen en ella, del más cercano a donde iba al más lejano.
  const ghost = $derived.by(() => { void app.version; return bus ? undefined : ctl?.lastSeen(id); });
  const ghostRoute = $derived(ghost ? net.routes.get(ghost.routeId) : undefined);
  const others = $derived.by(() => {
    void app.version;
    if (!ghost || !app.fleet) return [];
    const path = net.paths.get(ghost.routeId);
    const pat = app.patternsReady ? net.pattern(ghost.routeId) : undefined;
    const s0 = path?.nearest(ghost.lon * KX, ghost.lat * KY, undefined, 0, Infinity, 200)?.s ?? 0;
    return (busesByRoute(app.fleet, app.version).get(ghost.routeId) ?? [])
      .filter((b) => b.onPath)
      .map((b) => { const k = pat ? nextStopIndex(pat, b.sFix) : -1; return { b, d: b.sFix - s0, next: pat && k >= 0 && k < pat.stops.length ? net.placeName(pat.stops[k]) : '' }; })
      .sort((a, c) => Math.abs(a.d) - Math.abs(c.d))
      .slice(0, 6);
  });

  const itinerary = $derived.by(() => {
    void app.now;
    void stopsReady;
    if (!bus || !pattern || !bus.onPath || tooOld) return [];
    const band = bandIndex(bogotaSeconds(app.now));
    const t = bandTimes(pattern, band);
    const k = t ? pace(pattern, t, bus.hist) : 1;
    const fixAge = (app.now - bus.fixAt) / 1000;
    return etas(pattern, band, bus.sFix, fixAge, k, 40).map((e) => ({
      ...e,
      name: net.placeName(e.stopId),
      station: net.stationOf.get(e.stopId),
      at: app.now + e.seconds * 1000,
    }));
  });
  const paceNote = $derived.by(() => {
    if (!bus || !pattern) return null;
    const t = bandTimes(pattern, bandIndex(bogotaSeconds(app.now)));
    if (!t || bus.hist.length < 3) return null;
    const k = pace(pattern, t, bus.hist);
    if (k > 1.15) return 'más lento que el horario';
    if (k < 0.87) return 'más rápido que el horario';
    return 'al ritmo del horario';
  });
</script>

{#if bus}
  <div class="view">
    <Back />
    <header class="title">
      <RouteBadge {route} size="lg" />
      <div class="names">
        <h1>{route?.dest ?? 'Ruta sin datos'}</h1>
        <p class="dim">Bus <span class="num">{bus.label}</span>&nbsp;· <span class="num">{bus.plate}</span>{#if bus.kind}&nbsp;· {KIND_NAME[bus.kind]}{:else if bus.sys === 'zonal' && bus.route?.sub}&nbsp;· <span title="Estimado por el tipo de servicio">{bus.route.sub === 'especial' ? 'buseta' : bus.route.sub === 'complementario' ? 'busetón' : 'padrón'}</span>{/if}</p>
      </div>
    </header>

    {#if progress != null}
      <div class="progress" style:--c={route?.color}>
        <div class="track"><span style:width="{progress * 100}%"></span><i style:left="{progress * 100}%"></i></div>
        <div class="ends label"><span>{route?.origin ?? ''}</span><span class="num">{Math.round(progress * 100)} %</span></div>
      </div>
    {/if}

    <dl class="stats">
      <div title="Calculada con las lecturas de los últimos 3 minutos sobre el recorrido: el alimentador no la trae"><dt class="label">Velocidad</dt><dd class="num">{kmh != null ? `${kmh} km/h` : '—'}</dd>{#if kmh != null}<span class="note">estimada</span>{/if}</div>
      <div><dt class="label">Reporte</dt><dd class="num" class:warn={age > 180}>hace {ago(age)}</dd></div>
      <div><dt class="label">Ruta</dt><dd><button class="link" onclick={() => go({ kind: 'route', id: bus.routeId })}>Ver ruta</button></dd></div>
    </dl>

    <div class="actions">
      <button class="btn" class:on={app.following} onclick={() => ctl?.toggleFollow()} aria-pressed={app.following}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.5" fill="currentColor" /><path d="M8 0v3M8 13v3M0 8h3M13 8h3" stroke="currentColor" stroke-width="1.4" /></svg>
        {app.following ? 'Siguiendo' : 'Seguir'}
      </button>
      {#if !bus.onPath}<span class="faint note">Fuera de su recorrido: sin estimaciones</span>{/if}
    </div>

    {#if quiet}
      <p class="notice">Sin lecturas nuevas de este bus desde las <span class="num">{fmtHM(bus.fixAt)}</span>.
        {tooOld ? 'Sin estimaciones hasta que vuelva a reportar.' : 'Las estimaciones parten de esa lectura.'}
        <span class="faint">El alimentador omite buses por momentos; se conserva en el mapa unos minutos por si vuelve.</span></p>
    {/if}

    {#if itinerary.length}
      <section class="itin" style:--c={route?.color}>
        <div class="head"><span class="label">Próximas paradas</span><span class="label faint">estimado</span></div>
        {#if paceNote}<p class="pace faint">Ritmo del bus: {paceNote}</p>{/if}
        <ol>
          {#each itinerary as e, i (e.index)}
            {@const on = watch.is(id, e.index)}
            <li class:first={i === 0} class:watched={on}>
              <button class="row" onclick={() => (e.station ? go({ kind: 'station', id: e.station.id }) : go({ kind: 'stop', id: e.stopId }))}>
                <span class="tick"></span>
                <span class="name">{e.name}</span>
                <span class="eta num">{etaText(e.seconds)}</span>
                <span class="at num faint">{fmtHM(e.at)}</span>
              </button>
              <button class="bell" class:on onclick={() => toggleWatch(e)} aria-pressed={on}
                aria-label={on ? `Desactivar el aviso de llegada a ${e.name}` : `Activar el aviso de llegada a ${e.name}`} title={on ? 'Aviso de llegada activado' : 'Aviso de llegada'}>
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5c-2.2 0-3.6 1.6-3.6 3.8v2.6L2 10h10l-1.4-2.1V5.3C10.6 3.1 9.2 1.5 7 1.5z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /><path d="M5.6 11.6a1.5 1.5 0 0 0 2.8 0" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
              </button>
            </li>
          {/each}
        </ol>
        <p class="foot faint">Calculado con los tiempos del horario de esta franja y el ritmo del bus en sus últimos minutos. Distancia a la última: {meters(itinerary[itinerary.length - 1].meters)}.</p>
      </section>
    {:else if bus.onPath && !pattern}
      <p class="faint">Cargando paradas…</p>
    {/if}
  </div>
{:else if ghost}
  <div class="view">
    <Back />
    <header class="title">
      <RouteBadge route={ghostRoute} size="lg" />
      <div class="names">
        <h1>{ghostRoute?.dest ?? 'Ruta sin datos'}</h1>
        <p class="dim">Bus <span class="num">{ghost.label}</span>{#if ghost.plate}&nbsp;· <span class="num">{ghost.plate}</span>{/if}</p>
      </div>
    </header>
    <p class="notice">Sin lecturas de este bus desde las <span class="num">{fmtHM(ghost.fixAt)}</span> (hace {ago(Math.max(0, (app.now - ghost.fixAt) / 1000))}).
      <span class="faint">Puede haber terminado su recorrido, entrado a patio o dejado de reportar. Si vuelve a aparecer, la ficha se actualiza sola.</span></p>
    {#if ghostRoute}
      <div class="actions">
        <button class="btn" onclick={() => go({ kind: 'route', id: ghost.routeId })}>Ver la ruta {ghostRoute.code}</button>
      </div>
    {/if}
    {#if others.length}
      <section class="others">
        <div class="head"><span class="label">Otros buses de la ruta</span><span class="label faint">del más cercano</span></div>
        <ul>
          {#each others as o (o.b.id)}
            <li>
              <button class="orow" onclick={() => go({ kind: 'bus', id: o.b.id }, true)}>
                <span class="num">{o.b.label}</span>
                <span class="faint where">{o.next ? `antes de ${o.next}` : ''}</span>
                <span class="num faint">{o.d >= 0 ? `${meters(o.d)} adelante` : `${meters(-o.d)} atrás`}</span>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
{:else}
  <div class="view">
    <Back />
    <p class="dim">El bus <span class="num">{id.replace(/^ruta:/, '')}</span> no aparece en las lecturas recientes.</p>
    <p class="faint small">Puede haber terminado su recorrido, entrado a patio o dejado de reportar. Si vuelve a aparecer, la ficha se actualiza sola.</p>
  </div>
{/if}

<style>
  .view { padding: var(--sp-4); display: grid; gap: var(--sp-4); }
  .title { display: flex; gap: var(--sp-3); align-items: flex-start; }
  .names { min-width: 0; }
  h1 { margin: 0; font-size: var(--fs-title); font-weight: 500; line-height: 1.2; letter-spacing: -0.01em; }
  .names p { margin: 2px 0 0; font-size: var(--fs-small); }
  .progress { display: grid; gap: 6px; }
  .track { position: relative; height: 2px; background: var(--line-2); }
  .track span { position: absolute; left: 0; top: 0; bottom: 0; background: var(--c); transition: width 1s linear; }
  .track i { position: absolute; top: -4px; width: 2px; height: 10px; background: var(--fg-0); transform: translateX(-1px); transition: left 1s linear; }
  .ends { display: flex; justify-content: space-between; }
  .stats { margin: 0; display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--line-1); }
  .stats div { padding: var(--sp-2) var(--sp-3); display: grid; gap: 2px; }
  .stats div + div { border-left: 1px solid var(--line-1); }
  dd { margin: 0; font-size: var(--fs-row); }
  .note { font-size: 10px; letter-spacing: 0.02em; color: var(--fg-2); line-height: 1; }
  dd.warn { color: var(--warn); }
  .link { color: var(--fg-0); text-decoration: underline; text-decoration-color: var(--fg-3); text-underline-offset: 3px; font-size: var(--fs-body); }
  .link:hover { text-decoration-color: var(--fg-0); }
  .actions { display: flex; align-items: center; gap: var(--sp-3); }
  .btn { height: 32px; padding: 0 var(--sp-3); border: 1px solid var(--line-2); display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-small); color: var(--fg-1); }
  .btn:hover { color: var(--fg-0); border-color: var(--fg-3); }
  .btn.on { background: var(--fg-0); color: var(--bg-0); border-color: var(--fg-0); }
  .note { font-size: var(--fs-small); }
  .head { display: flex; justify-content: space-between; gap: var(--sp-2); margin-bottom: var(--sp-2); }
  ol { list-style: none; margin: 0; padding: 0; }
  li { position: relative; }
  li::before { content: ''; position: absolute; left: 7px; top: 0; bottom: 0; width: 2px; background: var(--c); opacity: 0.7; }
  li.first::before { top: 20px; }
  li:last-child::before { bottom: 20px; }
  li { display: grid; grid-template-columns: 1fr 36px; align-items: center; }
  li .row { width: 100%; height: 40px; display: grid; grid-template-columns: 16px 1fr auto 44px; gap: var(--sp-3); align-items: center; text-align: left; }
  li .row:hover .name { color: var(--fg-0); }
  .bell { width: 36px; height: 36px; display: grid; place-items: center; color: var(--fg-3); }
  .bell:hover { color: var(--fg-0); }
  .bell.on { color: var(--fg-0); }
  li.watched .name { color: var(--fg-0); }
  .tick { width: 10px; height: 10px; margin-left: 3px; background: var(--bg-1); border: 2px solid var(--c); position: relative; z-index: 1; }
  li.first .tick { background: var(--c); }
  .name { color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  li.first .name { color: var(--fg-0); }
  .eta { text-align: right; font-size: var(--fs-small); }
  .at { text-align: right; font-size: var(--fs-label); }
  .pace { margin: calc(-1 * var(--sp-2)) 0 var(--sp-2); font-size: var(--fs-small); }
  .foot { margin: var(--sp-3) 0 0; font-size: var(--fs-label); line-height: 1.5; }
  .small { font-size: var(--fs-small); }
  .notice { margin: 0; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--line-1); border-left: 2px solid var(--warn); font-size: var(--fs-small); line-height: 1.5; color: var(--fg-1); }
  .notice .faint { display: block; margin-top: 2px; }
  .others ul { list-style: none; margin: 0; padding: 0; }
  .others li { display: block; border-top: 1px solid var(--line-1); }
  .others li::before { content: none; }
  .orow { width: 100%; height: 40px; display: grid; grid-template-columns: auto 1fr auto; gap: var(--sp-3); align-items: center; text-align: left; font-size: var(--fs-small); color: var(--fg-1); }
  .orow:hover { color: var(--fg-0); }
  .where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>

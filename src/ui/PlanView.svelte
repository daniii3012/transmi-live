<script lang="ts">
  import { app } from '../app/store.svelte';
  import { go } from '../app/router';
  import { ctl } from '../app/instance';
  import { planTrip } from '../planner/client';
  import { decodePlan, encodePlan, endName, toPlace, type End, type Day } from '../planner/places';
  import type { Answer } from '../planner/planner.worker';
  import { bogotaSeconds, clock, dayType, meters } from '../domain/time';
  import { etaText } from '../domain/eta';
  import { arrivals } from './derive';
  import PlaceField from './PlaceField.svelte';
  import RouteBadge from './RouteBadge.svelte';
  import Back from './Back.svelte';

  let { id }: { id: string } = $props();
  const net = $derived(app.net!);
  const st = $derived(decodePlan(id));
  let result = $state<Answer | null>(null);
  let busy = $state(false);
  let selected = $state(0);

  function update(from: End | null, to: End | null, time: string | null, day: Day | null = st.day) {
    go({ kind: 'plan', id: encodePlan(from, to, time, day) }, true);
  }
  function swap() { update(st.to, st.from, st.time); }
  const DAYS: [Day | null, string][] = [[null, 'Hoy'], ['habil', 'Hábil'], ['sabado', 'Sábado'], ['festivo', 'Festivo']];

  // Consulta: cada vez que cambian los extremos o la hora. «Mi ubicación» pide permiso primero.
  $effect(() => {
    const { from, to, time, day } = st;
    result = null;
    selected = 0;
    if (!from || !to) return;
    if ((from.kind === 'here' || to.kind === 'here') && !app.userPos) { ctl?.locate(); return; }
    const here = app.userPos;
    void net.loadStreetStops().then(async () => {
      const a = toPlace(net, from, here), b = toPlace(net, to, here);
      if (!a || !b) return;
      busy = true;
      const now = Date.now();
      const depart = time ? Number(time.slice(0, 2)) * 3600 + Number(time.slice(3)) * 60 : bogotaSeconds(now);
      const r = await planTrip(a, b, depart, day ?? dayType(now));
      busy = false;
      if (decodePlan(id).from === null) return;
      result = r;
    });
  });

  const journeys = $derived(result?.journeys ?? []);
  const sel = $derived(journeys[selected]);
  $effect(() => { ctl?.showJourney(sel ?? null, st.from, st.to); });

  function legRoute(j: NonNullable<typeof sel>, l: { route: number }) { return net.routes.get(j.routeIds[l.route]); }
  function stopName(j: NonNullable<typeof sel>, s: number | null, fallback: string) { return s === null ? fallback : net.placeName(j.stopIds[s]); }

  /** Próximo bus en vivo para el primer tramo, si el viaje es para ya. */
  const firstLive = $derived.by(() => {
    void app.now; void app.version;
    if (!sel || st.time || st.day || !app.fleet || !app.patternsReady) return null;
    const ride = sel.legs.find((l) => l.kind === 'ride');
    if (!ride || ride.kind !== 'ride') return null;
    const rid = sel.routeIds[ride.route], sid = sel.stopIds[ride.from];
    const a = arrivals(net, app.fleet, app.version, new Set([sid]), [rid], app.now)[0];
    return a ? { seconds: a.seconds, label: a.bus.label, busId: a.bus.id } : null;
  });
</script>

<div class="view">
  <Back />
  <header><h1>Planear un viaje</h1></header>

  <div class="ends">
    <PlaceField label="Desde" mark="from" value={st.from} onpick={(e) => update(e, st.to, st.time)} />
    <PlaceField label="Hasta" mark="to" value={st.to} onpick={(e) => update(st.from, e, st.time)} />
    <button class="swap" onclick={swap} aria-label="Invertir origen y destino" title="Invertir">
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2v12M5 2 2 5M5 2l3 3M11 14V2M11 14l-3-3M11 14l3-3" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
    </button>
  </div>

  <div class="when">
    <button class="seg" class:on={!st.time} onclick={() => update(st.from, st.to, null)}>Salir ahora</button>
    <div class="seg" class:on={!!st.time}>
      <span>A las</span>
      <!-- Dos selectores en 24 h: el control nativo de hora muestra a. m./p. m. según el sistema. -->
      <select aria-label="Hora" value={st.time?.slice(0, 2) ?? ''} onchange={(e) => update(st.from, st.to, `${e.currentTarget.value}:${st.time?.slice(3) ?? '00'}`)}>
        {#if !st.time}<option value="" disabled>hh</option>{/if}
        {#each Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')) as h (h)}<option value={h}>{h}</option>{/each}
      </select>
      <span class="colon">:</span>
      <select aria-label="Minutos" value={st.time?.slice(3) ?? ''} onchange={(e) => update(st.from, st.to, `${st.time?.slice(0, 2) ?? String(new Date().getHours()).padStart(2, '0')}:${e.currentTarget.value}`)}>
        {#if !st.time}<option value="" disabled>mm</option>{/if}
        {#each Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0')) as m (m)}<option value={m}>{m}</option>{/each}
      </select>
    </div>
  </div>

  <div class="days" role="radiogroup" aria-label="Día">
    {#each DAYS as [k, name] (name)}
      <button role="radio" aria-checked={st.day === k} class:on={st.day === k} onclick={() => update(st.from, st.to, st.time, k)}>{name}</button>
    {/each}
  </div>

  {#if !st.from || !st.to}
    <p class="hint faint">Origen y destino: desde el buscador de cada campo, manteniendo presionado el mapa (clic derecho en computador) o con «Ir desde aquí» en la ficha de una estación.</p>
  {:else if busy || (!result && (st.from.kind !== 'here' || app.userPos))}
    <p class="hint faint">Buscando el mejor viaje…</p>
  {:else if result && !journeys.length}
    <p class="hint faint">No hay viaje con servicio a esa hora entre {endName(net, st.from)} y {endName(net, st.to)}.</p>
  {:else if journeys.length}
    <ul class="cards">
      {#each journeys as j, i (i)}
        <li>
          <button class="card" class:on={i === selected} onclick={() => (selected = i)}>
            <div class="top">
              <span class="dur num">{Math.round((j.arrive - j.depart) / 60)} min</span>
              <span class="arr faint num">llega {clock(j.arrive)}</span>
            </div>
            <div class="chain">
              {#each j.legs as l, k (k)}
                {#if k > 0}<span class="sep">›</span>{/if}
                {#if l.kind === 'walk'}<span class="walk num"><svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true"><circle cx="5.5" cy="1.8" r="1.5" /><path d="M5 4 3 7l2 1-1 4M5 4l2 3 2 .5M3.5 5.5 1.5 6.5" stroke="currentColor" stroke-width="1.2" fill="none" /></svg>{Math.max(1, Math.round(l.seconds / 60))}</span>
                {:else}<RouteBadge route={legRoute(j, l)} size="sm" />{/if}
              {/each}
            </div>
            <div class="meta faint">{j.rides === 1 ? 'Directo' : `${j.rides} buses`} · {Math.round(j.walkSeconds / 60)} min a pie</div>
          </button>
        </li>
      {/each}
    </ul>

    {#if sel}
      <ol class="legs">
        {#each sel.legs as l, k (k)}
          {#if l.kind === 'walk'}
            <li class="leg walk">
              <span class="t num">{clock(l.start)}</span>
              <span class="rail dashed"></span>
              <div class="body">
                <div>Camina {Math.max(1, Math.round(l.seconds / 60))} min <span class="faint">· {meters(l.meters)}</span></div>
                <div class="faint small">{l.to === null ? `hasta ${endName(net, st.to)}` : `hasta ${stopName(sel, l.to, '')}`}</div>
              </div>
            </li>
          {:else}
            {@const r = legRoute(sel, l)}
            <li class="leg ride" style:--c={r?.color}>
              <span class="t num">{clock(l.board)}</span>
              <span class="rail"></span>
              <div class="body">
                <div class="board"><RouteBadge route={r} size="sm" /> <span>hacia {r?.dest}</span></div>
                <div class="small">Sube en <button class="lk" onclick={() => { const s = net.stationOf.get(sel.stopIds[l.from]); if (s) go({ kind: 'station', id: s.id }); }}>{stopName(sel, l.from, '')}</button></div>
                <div class="faint small">
                  {#if k === sel.legs.findIndex((x) => x.kind === 'ride') && firstLive}
                    Próximo bus <button class="lk live" onclick={() => go({ kind: 'bus', id: firstLive!.busId })}>{etaText(firstLive.seconds)}</button> · en vivo
                  {:else}
                    Espera ~{Math.max(1, Math.round(l.wait / 60))} min según la frecuencia
                  {/if}
                  · {l.toPos - l.fromPos} paradas · {Math.round((l.end - l.board) / 60)} min
                </div>
                <div class="small">Baja en {stopName(sel, l.to, '')} <span class="faint num">{clock(l.end)}</span></div>
              </div>
            </li>
          {/if}
        {/each}
        <li class="leg end"><span class="t num">{clock(sel.arrive)}</span><span class="rail none"></span><div class="body">Llegas a {endName(net, st.to)}</div></li>
      </ol>
      <p class="foot faint">Tiempos del horario de la franja y espera según la frecuencia programada. Calculado en {result?.ms} ms.</p>
    {/if}
  {/if}
</div>

<style>
  .view { padding: var(--sp-4); display: grid; gap: var(--sp-4); }
  h1 { margin: 0; font-size: var(--fs-title); font-weight: 500; }
  .ends { display: grid; gap: var(--sp-2); position: relative; padding-right: 44px; }
  .swap { position: absolute; right: 0; top: 50%; transform: translateY(-50%); width: 36px; height: 36px; border: 1px solid var(--line-2); color: var(--fg-1); display: flex; align-items: center; justify-content: center; }
  .swap:hover { color: var(--fg-0); border-color: var(--fg-3); }
  .when { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--line-2); }
  .seg { height: 36px; display: flex; align-items: center; justify-content: center; gap: var(--sp-2); font-size: var(--fs-small); color: var(--fg-1); cursor: pointer; }
  .seg + .seg { border-left: 1px solid var(--line-2); }
  .seg.on { background: var(--fg-0); color: var(--bg-0); }
  .seg select { appearance: none; -webkit-appearance: none; background: none; border: 0; color: inherit; font: inherit; font-family: var(--font-mono); padding: 0 2px; cursor: pointer; }
  .seg select option { color: var(--fg-0); background: var(--bg-1); }
  .colon { margin: 0 -4px; }
  .days { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--line-2); margin-top: calc(-1 * var(--sp-2)); }
  .days button { height: 30px; font-size: var(--fs-small); color: var(--fg-1); }
  .days button + button { border-left: 1px solid var(--line-2); }
  .days button.on { background: var(--bg-3); color: var(--fg-0); }
  .hint { margin: 0; font-size: var(--fs-small); line-height: 1.5; }
  .cards { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--sp-2); }
  .card { width: 100%; display: grid; gap: 6px; padding: var(--sp-3); border: 1px solid var(--line-1); text-align: left; }
  .card:hover { border-color: var(--line-2); }
  .card.on { border-color: var(--fg-1); background: var(--bg-2); }
  .top { display: flex; justify-content: space-between; align-items: baseline; }
  .dur { font-size: var(--fs-row); font-weight: 500; }
  .arr { font-size: var(--fs-small); }
  .chain { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .sep { color: var(--fg-3); }
  .walk { display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-label); color: var(--fg-1); }
  .walk svg { fill: currentColor; }
  .meta { font-size: var(--fs-label); }
  .legs { list-style: none; margin: 0; padding: 0; }
  .leg { display: grid; grid-template-columns: 40px 12px 1fr; gap: var(--sp-3); position: relative; }
  .t { font-size: var(--fs-label); color: var(--fg-1); padding-top: 2px; }
  .rail { position: relative; justify-self: center; width: 4px; background: var(--c, var(--fg-2)); margin: 6px 0; }
  .rail.dashed { width: 2px; background: repeating-linear-gradient(var(--fg-2) 0 4px, transparent 4px 8px); }
  .rail.none { background: none; }
  .rail.none::before { content: ''; position: absolute; top: 0; left: -3px; width: 8px; height: 8px; background: var(--fg-0); }
  .body { display: grid; gap: 4px; padding-bottom: var(--sp-4); font-size: var(--fs-body); }
  .board { display: flex; align-items: center; gap: var(--sp-2); }
  .small { font-size: var(--fs-small); }
  .lk { color: var(--fg-0); text-decoration: underline; text-decoration-color: var(--fg-3); text-underline-offset: 3px; }
  .lk.live { font-family: var(--font-mono); }
  .foot { margin: 0; font-size: var(--fs-label); line-height: 1.5; }
</style>

<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '../app/store.svelte';
  import { go } from '../app/router';
  import { busesByRoute, frequencyNow } from './derive';
  import { clock, fmtNum, meters, ago, bogotaSeconds, dayType } from '../domain/time';
  import { bandIndex, bandTimes, timeAt, nextStopIndex } from '../domain/eta';
  import RouteBadge from './RouteBadge.svelte';
  import Back from './Back.svelte';
  import Star from './Star.svelte';
  import AlertList from './AlertList.svelte';
  import HourBars from './HourBars.svelte';
  import type { Route } from '../domain/types';
  import { backup } from '../live/backup.svelte';
  import { busCode, busCodes, destOfCode } from '../domain/legs';

  let { id }: { id: string } = $props();
  const net = $derived(app.net!);
  const route = $derived(net.routes.get(id));
  const sysName = $derived(route ? net.systems.find((s) => s.key === route.sys)?.name : '');
  let serviceReady = $state(false);
  let stopsReady = $state(false);
  onMount(() => {
    void net.loadService().then(() => (serviceReady = true));
    // Nombres de los paraderos zonales: llegan con stops.json.
    void net.loadStreetStops().then(() => (stopsReady = true));
  });

  const pattern = $derived.by(() => (app.patternsReady ? net.pattern(id) : undefined));
  const buses = $derived.by(() => {
    void app.version;
    return app.fleet ? busesByRoute(app.fleet, app.version).get(id) ?? [] : [];
  });
  const freq = $derived.by(() => {
    void app.now;
    return serviceReady ? frequencyNow(net, id, app.now) : null;
  });
  /** Buses que el horario espera en servicio ahora: salidas por hora × duración del viaje (franja
   * actual). Es una estimación: compararla con los buses en vía dice si la ruta va como debería. */
  const expected = $derived.by(() => {
    if (!freq?.perHour || !pattern) return null;
    const t = bandTimes(pattern, bandIndex(bogotaSeconds(app.now)));
    if (!t?.length) return null;
    return Math.max(1, Math.round((freq.perHour * t[t.length - 1]) / 3600));
  });
  /**
   * Regularidad: separación en tiempo del horario entre buses seguidos de la ruta. «Juntos» si van a
   * menos de un tercio del intervalo programado (o a menos de 1 min); hueco, si pasa del doble. Dice
   * dónde está el hueco mayor (antes de qué parada).
   */
  const regularity = $derived.by(() => {
    void app.version;
    if (!pattern || !freq?.every || buses.length < 3) return null;
    const t = bandTimes(pattern, bandIndex(bogotaSeconds(app.now)));
    if (!t) return null;
    const on = buses.filter((b) => b.onPath && b.age < 300).map((b) => ({ b, t: timeAt(pattern, t, b.sFix) })).sort((a, c) => c.t - a.t);
    const every = freq.every * 60;
    let together = 0, worst = 0, where = '';
    for (let i = 1; i < on.length; i++) {
      const h = on[i - 1].t - on[i].t;
      if (h < Math.max(60, every / 3)) together++;
      if (h > worst) {
        worst = h;
        const k = nextStopIndex(pattern, on[i].b.sFix);
        where = k >= 0 && k < pattern.stops.length ? net.placeName(pattern.stops[k]) : '';
      }
    }
    return { together, gap: worst > 2 * every ? Math.round(worst / 60) : null, where };
  });

  /** Cambios recientes de esta ruta (30 días): paradas, destino, recorrido nuevo. */
  let changesReady = $state(false);
  $effect(() => { void net.loadChanges().then(() => (changesReady = true)); });
  const routeChanges = $derived.by(() => {
    if (!changesReady) return [];
    const cut = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    return net.changes.entries.filter((e) => e.route === id && e.date >= cut);
  });

  /** Salidas por hora del tipo de día de hoy (gráfico plegable «Horario de hoy»). */
  const hours = $derived.by(() => {
    if (!serviceReady) return null;
    const d = net.serviceOf(id)?.[dayType(app.now)];
    return d?.h?.some((n: number) => n > 0) ? d.h : null;
  });
  const hourNow = $derived.by(() => { const h = Math.floor(bogotaSeconds(app.now) / 3600); return h < 4 ? h + 24 : h; });
  const others = $derived(route?.pair?.map((p) => net.routes.get(p)!).filter(Boolean) ?? []);
  /**
   * Variantes de la misma línea: el circuito que une dos códigos (FZ63 = «F63 Pradera || Z63 Tibanica»)
   * y sus partes. TRANSMILENIO programa unas u otras según la hora (entre semana el F63 sale como
   * FZ63 casi todo el día): quien busca el F63 a mediodía encontraba una ruta sin buses.
   */
  const variants = $derived.by(() => {
    if (!route) return [];
    const parts = (r: Route) => (r.codes ?? []).map((c) => c.toUpperCase());
    const mine = parts(route), code = route.code.toUpperCase();
    const out: Route[] = [];
    for (const r of net.routes.values()) {
      if (r.id === route.id || r.sys !== route.sys || route.pair?.includes(r.id)) continue;
      if (busCode(r) === busCode(route)) continue; // la misma línea con otro id (variante de ciclovía)
      if (mine.includes(r.code.toUpperCase()) || parts(r).includes(code)) out.push(r);
    }
    return out;
  });
  /** Códigos del bus en esta ruta, con su destino («A153 hasta Centro, C153 hasta Suba La Gaitana»). */
  const codeLegs = $derived(route && busCodes(route).length > 1 ? busCodes(route).map((c) => ({ c, d: destOfCode(route, c) })) : []);
  /** Tramo que empieza en cada parada del diagrama (después de la primera). */
  const legStart = $derived(new Map((route?.legs ?? []).slice(1).map((l) => [l.i, l])));
  /** Sin salidas a esta hora y una variante que sí las tiene: ahí están los buses. */
  const variantNow = $derived.by(() => {
    void app.now;
    if (!serviceReady || !freq || freq.perHour) return null;
    return variants.find((r) => (frequencyNow(net, r.id, app.now)?.perHour ?? 0) > 0) ?? null;
  });
  /** Con salidas programadas y el alimentador al día, ningún bus de la ruta reporta. */
  const silent = $derived(!!freq?.perHour && buses.length === 0 && app.poll.status === 'live');
  const alerts = $derived(app.alerts.filter((a) => a.routes.includes(id)));

  const ROW = 52;
  /** Paradas del patrón. */
  const rows = $derived.by(() => {
    if (!pattern) return [];
    void stopsReady;
    return pattern.stops.map((sid, i) => ({ i, id: sid, name: net.placeName(sid), s: pattern.s[i], station: net.stationOf.get(sid) }));
  });
  /** Buses sobre el diagrama: `y` exacta por abscisa (centro de fila a centro de fila) y `ly` de la
   * etiqueta, empujada hacia abajo lo justo para que dos etiquetas nunca se monten. */
  const marks = $derived.by(() => {
    if (!rows.length) return [];
    const out: { id: string; label: string; age: number; y: number; ly: number }[] = [];
    for (const b of buses) {
      if (!b.onPath) continue;
      let k = 0;
      while (k < rows.length - 1 && rows[k + 1].s <= b.sFix) k++;
      const a = rows[k].s, z = rows[k + 1]?.s ?? a;
      const f = z > a ? Math.min(1, Math.max(0, (b.sFix - a) / (z - a))) : 0;
      const y = k * ROW + ROW / 2 + f * ROW;
      out.push({ id: b.id, label: b.label, age: b.age, y, ly: y });
    }
    out.sort((p, q) => p.y - q.y);
    return out;
  });
  /** Etiquetas: los buses a menos de una etiqueta de distancia van juntos («B12 +2»); así, con muchos
   * buses en cola, las etiquetas ya no se empujan más allá del final del diagrama. */
  const groups = $derived.by(() => {
    const gs: { ids: string[]; labels: string[]; age: number; y: number; ly: number }[] = [];
    for (const m of marks) {
      const g = gs.at(-1);
      if (g && m.y - g.y < 18) { g.ids.push(m.id); g.labels.push(m.label); g.age = Math.min(g.age, m.age); }
      else gs.push({ ids: [m.id], labels: [m.label], age: m.age, y: m.y, ly: m.y });
    }
    for (let i = 1; i < gs.length; i++) gs[i].ly = Math.max(gs[i].y, gs[i - 1].ly + 18);
    return gs;
  });
</script>

{#if route}
  <div class="view">
    <Back />
    <header class="title">
      <RouteBadge {route} size="lg" />
      <div class="names">
        <h1>{route.dest}</h1>
        <p class="dim">{route.loop ? 'Circuito · ' : 'Desde '}{route.origin ?? '—'}</p>
      </div>
      <Star kind="route" {id} />
    </header>

    <AlertList {alerts} />

    <div class="meta label">{sysName}{route.sub ? ` · ${route.sub}` : ''}{route.zone ? ` · zona ${route.zone}` : ''}{busCode(route) !== route.code ? ` · ${route.code} en el catálogo` : ''}</div>

    {#if codeLegs.length}
      <p class="legs">
        {#each codeLegs as l, k (l.c)}
          {k === 0 ? 'Va como' : ' y vuelve como'} <RouteBadge {route} code={l.c} size="sm" /> {k === 0 ? 'hasta' : 'hasta'} {l.d}
        {/each}
        {#if !route.legs}<span class="faint">. El letrero del horario no dice dónde cambia.</span>{/if}
      </p>
    {/if}

    <dl class="stats">
      <div><dt class="label">En vía</dt><dd class="num">{fmtNum(buses.length)}</dd></div>
      <div><dt class="label">Frecuencia</dt><dd class="num">{freq?.every ? `${freq.every} min` : freq ? '—' : '·'}</dd></div>
      <div><dt class="label">Longitud</dt><dd class="num">{meters(route.len)}</dd></div>
    </dl>
    {#if freq}
      <p class="sched faint">
        {#if freq.first != null}Hoy de <span class="num">{clock(freq.first)}</span> a <span class="num">{clock(freq.last ?? 0)}</span>{:else}Sin servicio programado hoy{/if}
        {#if freq.perHour}· <span class="num">{freq.perHour}</span> salidas esta hora{/if}
        {#if expected}· el horario espera <span class="num">~{expected}</span> en vía{/if}
      </p>
    {/if}
    {#if variantNow}
      <p class="notice">A esta hora la línea sale {variantNow.loop ? 'en circuito' : `hacia ${variantNow.dest}`}: <button class="link" onclick={() => go({ kind: 'route', id: variantNow.id }, true)}>{busCode(variantNow)}{variantNow.loop ? `, ${variantNow.dest} – ${variantNow.origin}` : ''}</button>.</p>
    {:else if silent}
      <p class="notice">Ningún bus de esta ruta reporta ahora, aunque el horario tiene salidas esta hora.
        <span class="faint">El alimentador abierto no trae toda la flota en todo momento.{backup.status === 'off' ? '' : backup.status === 'rejected' ? ' El respaldo por ruta rechazó las credenciales.' : ' El respaldo por ruta tampoco trae buses de esta ruta por ahora.'}</span></p>
    {/if}
    {#if routeChanges.length}
      <div class="changed">
        {#each routeChanges as c, k (k)}
          <p><span class="label">Cambio · {new Date(`${c.date}T12:00:00-05:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}</span>
            {c.kind === 'route-stops' ? [c.add?.length ? `ahora para en ${c.add.join(', ')}` : '', c.remove?.length ? `ya no para en ${c.remove.join(', ')}` : ''].filter(Boolean).join(' · ') : c.text}</p>
        {/each}
      </div>
    {/if}
    {#if regularity && (regularity.together || regularity.gap)}
      <p class="regular faint">
        {#if regularity.together}<span class="num">{regularity.together}</span> {regularity.together === 1 ? 'par de buses van juntos' : 'pares de buses van juntos'}{/if}
        {#if regularity.together && regularity.gap} · {/if}
        {#if regularity.gap}hueco de <span class="num">{regularity.gap} min</span>{regularity.where ? ` antes de ${regularity.where}` : ''}{/if}
      </p>
    {/if}
    {#if hours}
      <details class="hours">
        <summary class="label">Horario de hoy</summary>
        <HourBars counts={hours} color={route.color} now={hourNow} />
      </details>
    {/if}

    {#if others.length || variants.length}
      <div class="pair">
        {#each others as o (o.id)}
          <button class="btn" onclick={() => go({ kind: 'route', id: o.id }, true)}>
            {#if o.dest === route.dest}
              Variante · {o.origin ?? o.name}
            {:else}
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5h9l-3-3M13 11H4l3 3" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
              Hacia {o.dest}
            {/if}
          </button>
        {/each}
        {#each variants as o (o.id)}
          <button class="btn" onclick={() => go({ kind: 'route', id: o.id }, true)}>
            <span class="num">{busCode(o)}</span>{o.loop ? 'Circuito' : `Hacia ${o.dest}`}
          </button>
        {/each}
      </div>
    {/if}

    <section class="diagram" style:--c={route.color}>
      <div class="dhead"><span class="label">Recorrido</span><span class="label faint">{route.stops} paradas</span></div>
      {#if !pattern}
        <p class="faint loading">Cargando paradas…</p>
      {:else}
        <div class="lines" style:height="{Math.max(rows.length * ROW, (groups.at(-1)?.ly ?? 0) + 12)}px">
          <ol>
            {#each rows as r (r.i)}
              <li class:end={r.i === rows.length - 1}>
                <button class="stop" onclick={() => r.station ? go({ kind: 'station', id: r.station.id }) : go({ kind: 'stop', id: r.id })}>
                  <span class="tick" class:terminal={r.i === 0 || r.i === rows.length - 1}></span>
                  <span class="sname">{r.name}{#if legStart.has(r.i)}<span class="legmark">sigue como <RouteBadge {route} code={legStart.get(r.i)?.c} size="sm" /></span>{/if}</span>
                </button>
              </li>
            {/each}
          </ol>
          {#each marks as b (b.id)}
            <button class="chev" class:stale={b.age > 180} style:top="{b.y - 7}px" onclick={() => go({ kind: 'bus', id: b.id })} aria-label="Bus {b.label}">
              <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M1 1h10v7l-5 5-5-5z" /></svg>
            </button>
          {/each}
          {#each groups as g (g.ids[0])}
            <button class="pill num" class:stale={g.age > 180} style:top="{g.ly - 8}px" onclick={() => go({ kind: 'bus', id: g.ids[0] })}
              aria-label={g.ids.length > 1 ? `Buses ${g.labels.join(', ')}` : `Bus ${g.labels[0]}`}>
              {g.labels[0]}{#if g.ids.length > 1}<span class="faint">&nbsp;+{g.ids.length - 1}</span>{:else if g.age > 120}<span class="faint">&nbsp;· {ago(g.age)}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </section>
  </div>
{:else}
  <div class="view"><Back /><p class="faint">Ruta no encontrada.</p></div>
{/if}

<style>
  .view { padding: var(--sp-4); display: grid; gap: var(--sp-4); }
  .title { display: flex; gap: var(--sp-3); align-items: flex-start; }
  .names { min-width: 0; flex: 1; }
  h1 { margin: 0; font-size: var(--fs-title); font-weight: 500; line-height: 1.2; letter-spacing: -0.01em; }
  .names p { margin: 2px 0 0; font-size: var(--fs-small); }
  .meta { margin-top: -8px; }
  .stats { margin: 0; display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--line-1); }
  .stats div { padding: var(--sp-2) var(--sp-3); display: grid; gap: 2px; }
  .stats div + div { border-left: 1px solid var(--line-1); }
  dd { margin: 0; font-size: var(--fs-row); }
  .sched { margin: -8px 0 0; font-size: var(--fs-small); }
  .regular { margin: -8px 0 0; font-size: var(--fs-small); }
  .changed { border-left: 2px solid var(--warn); padding: var(--sp-2) var(--sp-3); background: var(--bg-2); display: grid; gap: var(--sp-1); }
  .changed p { margin: 0; font-size: var(--fs-small); color: var(--fg-1); line-height: 1.4; }
  .changed .label { display: block; color: var(--fg-2); margin-bottom: 2px; }
  .hours summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: var(--sp-2); color: var(--fg-2); }
  .hours summary::-webkit-details-marker { display: none; }
  .hours summary::before { content: '+'; font-family: var(--font-mono); width: 10px; }
  .hours[open] summary::before { content: '−'; }
  .hours[open] summary { margin-bottom: var(--sp-3); }
  .pair { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .legs { margin: -8px 0 0; font-size: var(--fs-small); color: var(--fg-1); line-height: 1.9; }
  .legmark { margin-left: var(--sp-2); font-size: var(--fs-label); color: var(--fg-2); display: inline-flex; align-items: center; gap: 4px; vertical-align: 1px; }
  .notice { margin: -4px 0 0; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--line-1); border-left: 2px solid var(--warn); font-size: var(--fs-small); line-height: 1.5; color: var(--fg-1); }
  .notice .faint { display: block; margin-top: 2px; }
  .link { color: var(--fg-0); text-decoration: underline; text-decoration-color: var(--fg-3); text-underline-offset: 3px; }
  .link:hover { text-decoration-color: var(--fg-0); }
  .btn { height: 32px; padding: 0 var(--sp-3); border: 1px solid var(--line-2); display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-small); color: var(--fg-1); }
  .btn:hover { color: var(--fg-0); border-color: var(--fg-3); }
  .dhead { display: flex; justify-content: space-between; margin-bottom: var(--sp-2); }
  .loading { font-size: var(--fs-small); }
  ol { list-style: none; margin: 0; padding: 0; }
  li { position: relative; height: 52px; }
  /* Línea de la ruta: une el centro de las marcas. */
  li::before { content: ''; position: absolute; left: 7px; top: 26px; bottom: -26px; width: 2px; background: var(--c); opacity: 0.85; }
  li.end::before { display: none; }
  .stop { position: absolute; inset: 0 0 auto 0; height: 52px; display: grid; grid-template-columns: 16px 1fr; align-items: center; gap: var(--sp-3); text-align: left; padding-right: 96px; }
  .stop:hover .sname { color: var(--fg-0); }
  .tick { width: 10px; height: 10px; margin-left: 3px; background: var(--bg-1); border: 2px solid var(--c); position: relative; z-index: 1; }
  .tick.terminal { background: var(--fg-0); border-color: var(--fg-0); }
  .sname { color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lines { position: relative; }
  .chev { position: absolute; left: 2px; width: 12px; height: 14px; z-index: 2; transition: top 1.2s linear; }
  .chev svg { fill: var(--c); stroke: var(--bg-1); stroke-width: 1.5; display: block; }
  .pill {
    position: absolute;
    right: 0;
    height: 16px;
    padding: 0 5px;
    background: var(--bg-1);
    border: 1px solid var(--line-2);
    font-size: var(--fs-label);
    line-height: 14px;
    color: var(--fg-0);
    white-space: nowrap;
    z-index: 2;
    transition: top 1.2s linear, border-color var(--t-out);
  }
  .pill:hover { border-color: var(--fg-2); }
  .stale { opacity: 0.5; }
</style>

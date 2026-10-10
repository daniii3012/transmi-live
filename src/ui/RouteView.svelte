<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '../app/store.svelte';
  import { go } from '../app/router';
  import { busesByRoute, frequencyNow } from './derive';
  import { clock, fmtNum, meters, ago } from '../domain/time';
  import RouteBadge from './RouteBadge.svelte';
  import Back from './Back.svelte';

  let { id }: { id: string } = $props();
  const net = $derived(app.net!);
  const route = $derived(net.routes.get(id));
  const sysName = $derived(route ? net.systems.find((s) => s.key === route.sys)?.name : '');
  let serviceReady = $state(false);
  onMount(() => { void net.loadService().then(() => (serviceReady = true)); });

  const pattern = $derived.by(() => (app.patternsReady ? net.pattern(id) : undefined));
  const buses = $derived.by(() => {
    void app.version;
    return app.fleet ? busesByRoute(app.fleet, app.version).get(id) ?? [] : [];
  });
  const freq = $derived.by(() => {
    void app.now;
    return serviceReady ? frequencyNow(net, id, app.now) : null;
  });
  const others = $derived(route?.pair?.map((p) => net.routes.get(p)!).filter(Boolean) ?? []);

  const ROW = 40;
  /** Paradas del patrón. */
  const rows = $derived.by(() => {
    if (!pattern) return [];
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
    for (let i = 1; i < out.length; i++) out[i].ly = Math.max(out[i].y, out[i - 1].ly + 18);
    return out;
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
    </header>

    <div class="meta label">{sysName}{route.sub ? ` · ${route.sub}` : ''}{route.zone ? ` · zona ${route.zone}` : ''}</div>

    <dl class="stats">
      <div><dt class="label">En vía</dt><dd class="num">{fmtNum(buses.length)}</dd></div>
      <div><dt class="label">Frecuencia</dt><dd class="num">{freq?.every ? `${freq.every} min` : freq ? '—' : '·'}</dd></div>
      <div><dt class="label">Longitud</dt><dd class="num">{meters(route.len)}</dd></div>
    </dl>
    {#if freq}
      <p class="sched faint">
        {#if freq.first != null}Hoy de <span class="num">{clock(freq.first)}</span> a <span class="num">{clock(freq.last ?? 0)}</span>{:else}Sin servicio programado hoy{/if}
        {#if freq.perHour}· <span class="num">{freq.perHour}</span> salidas esta hora{/if}
      </p>
    {/if}

    {#if others.length}
      <div class="pair">
        {#each others as o (o.id)}
          <button class="btn" onclick={() => go({ kind: 'route', id: o.id }, true)}>
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5h9l-3-3M13 11H4l3 3" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
            Hacia {o.dest}
          </button>
        {/each}
      </div>
    {/if}

    <section class="diagram" style:--c={route.color}>
      <div class="dhead"><span class="label">Recorrido</span><span class="label faint">{route.stops} paradas</span></div>
      {#if !pattern}
        <p class="faint loading">Cargando paradas…</p>
      {:else}
        <div class="lines" style:height="{Math.max(rows.length * ROW, (marks.at(-1)?.ly ?? 0) + 12)}px">
          <ol>
            {#each rows as r (r.i)}
              <li class:end={r.i === rows.length - 1}>
                <button class="stop" onclick={() => r.station ? go({ kind: 'station', id: r.station.id }) : go({ kind: 'stop', id: r.id })}>
                  <span class="tick" class:terminal={r.i === 0 || r.i === rows.length - 1}></span>
                  <span class="sname">{r.name}</span>
                </button>
              </li>
            {/each}
          </ol>
          {#each marks as b (b.id)}
            <button class="chev" class:stale={b.age > 180} style:top="{b.y - 7}px" onclick={() => go({ kind: 'bus', id: b.id })} aria-label="Bus {b.label}">
              <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M1 1h10v7l-5 5-5-5z" /></svg>
            </button>
            <button class="pill num" class:stale={b.age > 180} style:top="{b.ly - 8}px" onclick={() => go({ kind: 'bus', id: b.id })}>
              {b.label}{#if b.age > 120}<span class="faint">&nbsp;· {ago(b.age)}</span>{/if}
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
  .names { min-width: 0; }
  h1 { margin: 0; font-size: var(--fs-title); font-weight: 500; line-height: 1.2; letter-spacing: -0.01em; }
  .names p { margin: 2px 0 0; font-size: var(--fs-small); }
  .meta { margin-top: -8px; }
  .stats { margin: 0; display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--line-1); }
  .stats div { padding: var(--sp-2) var(--sp-3); display: grid; gap: 2px; }
  .stats div + div { border-left: 1px solid var(--line-1); }
  dd { margin: 0; font-size: var(--fs-row); }
  .sched { margin: -8px 0 0; font-size: var(--fs-small); }
  .pair { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .btn { height: 32px; padding: 0 var(--sp-3); border: 1px solid var(--line-2); display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-small); color: var(--fg-1); }
  .btn:hover { color: var(--fg-0); border-color: var(--fg-3); }
  .dhead { display: flex; justify-content: space-between; margin-bottom: var(--sp-2); }
  .loading { font-size: var(--fs-small); }
  ol { list-style: none; margin: 0; padding: 0; }
  li { position: relative; height: 40px; }
  /* Línea de la ruta: une el centro de las marcas. */
  li::before { content: ''; position: absolute; left: 7px; top: 20px; bottom: -20px; width: 2px; background: var(--c); opacity: 0.85; }
  li.end::before { display: none; }
  .stop { position: absolute; inset: 0 0 auto 0; height: 40px; display: grid; grid-template-columns: 16px 1fr; align-items: center; gap: var(--sp-3); text-align: left; padding-right: 96px; }
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

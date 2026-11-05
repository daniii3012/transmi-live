<script lang="ts">
  import { app } from '../app/store.svelte';
  import { go } from '../app/router';
  import Back from './Back.svelte';
  import RouteBadge from './RouteBadge.svelte';
  import type { ChangeEntry } from '../data/network';

  /**
   * Cambios en la red de los últimos 60 días (rutas nuevas, retiradas, con paradas distintas,
   * renombradas; estaciones que abren, cierran o cambian de nombre), por fecha. Por defecto, troncal,
   * dual, cable y estaciones; zonal y alimentador, a pedido (son cientos).
   */
  const net = $derived(app.net!);
  let ready = $state(false);
  $effect(() => { void net.loadChanges().then(() => (ready = true)); });
  let all = $state(false);
  const major = (e: ChangeEntry) => !e.sys || e.sys === 'troncal' || e.sys === 'dual' || e.sys === 'cable';
  const days = $derived.by(() => {
    if (!ready) return [];
    const list = net.changes.entries.filter((e) => all || major(e));
    const by = new Map<string, ChangeEntry[]>();
    for (const e of list) by.set(e.date, [...(by.get(e.date) ?? []), e]);
    return [...by.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  });
  const hidden = $derived(ready ? net.changes.entries.filter((e) => !major(e)).length : 0);
  const fmt = (d: string) => new Date(`${d}T12:00:00-05:00`).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
  function open(e: ChangeEntry) {
    if (e.station && net.stations.has(e.station)) go({ kind: 'station', id: e.station });
    else if (e.route) { const r = net.resolveRoute(e.route); if (r) go({ kind: 'route', id: r }); }
  }
  const linkable = (e: ChangeEntry) => (e.station ? net.stations.has(e.station) : e.route ? !!net.resolveRoute(e.route) : false);
</script>

<div class="view">
  <Back />
  <header>
    <div class="label">Red</div>
    <h1>Cambios en la red</h1>
    <p class="faint small">Comparación diaria del paquete de datos con el día anterior. Últimos 60 días.</p>
  </header>
  <div class="seg" role="radiogroup" aria-label="Sistemas">
    <button role="radio" aria-checked={!all} class:on={!all} onclick={() => (all = false)}>Troncal, dual, cable y estaciones</button>
    <button role="radio" aria-checked={all} class:on={all} onclick={() => (all = true)}>Todo{hidden ? ` (+${hidden})` : ''}</button>
  </div>
  {#if !ready}
    <p class="faint small">Cargando…</p>
  {:else if !days.length}
    <p class="faint small">Sin cambios registrados.</p>
  {/if}
  {#each days as [d, list] (d)}
    <section>
      <div class="head"><span class="label">{fmt(d)}</span><span class="label faint">{list.length}</span></div>
      <ul>
        {#each list as e, i (i)}
          {@const r = e.route ? net.routes.get(net.resolveRoute(e.route) ?? '') : undefined}
          <li>
            <button onclick={() => open(e)} disabled={!linkable(e)}>
              <span class="mark">
                {#if r}<RouteBadge route={r} />
                {:else if e.code}<span class="ghost num" style:border-color={e.color ?? 'var(--line-2)'}>{e.code}</span>
                {:else}<span class="st" class:closed={e.kind === 'station-closed'}></span>{/if}
              </span>
              <span class="text">{e.text}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>

<style>
  .view { padding: var(--sp-4); display: grid; gap: var(--sp-5); }
  h1 { margin: 2px 0 0; font-size: var(--fs-title); font-weight: 500; letter-spacing: -0.01em; }
  .small { font-size: var(--fs-small); margin: var(--sp-1) 0 0; }
  .seg { display: grid; grid-template-columns: 1fr auto; border: 1px solid var(--line-2); }
  .seg button { height: 32px; padding: 0 var(--sp-3); font-size: var(--fs-small); color: var(--fg-1); }
  .seg button + button { border-left: 1px solid var(--line-2); }
  .seg button.on { background: var(--bg-3); color: var(--fg-0); }
  .head { display: flex; justify-content: space-between; margin-bottom: var(--sp-2); }
  .head .label:first-child::first-letter { text-transform: uppercase; }
  ul { list-style: none; margin: 0; padding: 0; }
  li button { width: 100%; min-height: var(--row); display: grid; grid-template-columns: 56px 1fr; gap: var(--sp-3); align-items: center; padding: var(--sp-2) 0; border-bottom: 1px solid var(--line-1); text-align: left; font-size: var(--fs-body); color: var(--fg-1); }
  li button:not(:disabled):hover { color: var(--fg-0); background: var(--bg-2); }
  li button:disabled { cursor: default; }
  .mark { display: flex; justify-content: flex-start; }
  .ghost { height: 20px; padding: 0 6px; display: inline-flex; align-items: center; font-size: var(--fs-small); border: 1.5px dashed; color: var(--fg-2); }
  .st { width: 10px; height: 10px; margin-left: 4px; background: var(--station); box-shadow: 0 0 0 1.5px var(--fg-1); }
  .st.closed { background: none; }
  .text { line-height: 1.35; }
</style>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { app } from '../app/store.svelte';
  import { go, type View } from '../app/router';
  import { norm, frequencyNow } from './derive';
  import { SYSTEM_ORDER, type Route } from '../domain/types';
  import RouteBadge from './RouteBadge.svelte';

  let q = $state('');
  let active = $state(0);
  let input: HTMLInputElement;
  const net = $derived(app.net!);
  let stopsReady = $state(false);
  // Con el horario se sabe qué variante de una línea sale a esta hora (F63 o su circuito FZ63).
  let serviceReady = $state(false);
  onMount(() => {
    void net.loadService().then(() => (serviceReady = true));
    void net.loadStreetStops().then(() => (stopsReady = true));
    tick().then(() => input?.focus());
  });

  interface Item { key: string; view: View; group: string; title: string; sub: string; route?: Route; score: number }

  /** Índices de búsqueda (una vez). */
  const routeIndex = $derived([...net.routes.values()].map((r) => ({ r, code: norm(r.code), text: norm(`${r.code} ${r.dest} ${r.origin ?? ''} ${r.name}`) })));
  const stationIndex = $derived([...net.stations.values()].map((s) => ({ s, text: norm(s.name) })));
  const stopIndex = $derived.by(() => (stopsReady ? [...net.streetStops.values()].map((s) => ({ s, text: norm(`${s.name} ${s.code}`) })) : []));

  const results = $derived.by((): Item[] => {
    const n = norm(q);
    if (!n) return [];
    const words = n.split(' ');
    const has = (t: string) => words.every((w) => t.includes(w));
    const out: Item[] = [];
    // Rutas: el código exacto primero, luego prefijo, luego texto. Un código con dos sentidos sale dos veces.
    const now = Date.now();
    const rs = routeIndex
      .map(({ r, code, text }) => ({ r, s: code === n ? 0 : code.startsWith(n) ? 1 : has(text) ? 2 : 9 }))
      .filter((x) => x.s < 9)
      .map((x) => { const f = serviceReady ? frequencyNow(net, x.r.id, now) : null; return { ...x, off: !!f && !f.perHour }; })
      .sort((a, b) => a.s - b.s || Number(a.off) - Number(b.off) || SYSTEM_ORDER.indexOf(a.r.sys) - SYSTEM_ORDER.indexOf(b.r.sys) || a.r.code.localeCompare(b.r.code, 'es', { numeric: true }))
      .slice(0, 8);
    for (const { r, s, off } of rs) out.push({ key: `r${r.id}`, view: { kind: 'route', id: r.id }, group: 'Rutas', title: r.dest, sub: `${r.loop ? `circuito · ${r.origin}` : `desde ${r.origin ?? '—'}`}${off ? ' · sin salidas a esta hora' : ''}`, route: r, score: s });
    for (const { s } of stationIndex.filter((x) => has(x.text)).slice(0, 6))
      out.push({ key: `s${s.id}`, view: { kind: 'station', id: s.id }, group: 'Estaciones', title: s.short, sub: s.kind === 'portal' ? 'portal' : s.closed ? 'sin servicio' : `${s.routes.length} rutas`, score: 3 });
    for (const { s } of stopIndex.filter((x) => has(x.text)).slice(0, 5))
      out.push({ key: `p${s.id}`, view: { kind: 'stop', id: s.id }, group: 'Paraderos', title: s.name, sub: `${s.code} · ${s.routes.length} rutas`, score: 4 });
    if (app.fleet && n.length >= 3) {
      let k = 0;
      for (const b of app.fleet.buses.values()) {
        if (norm(b.label).includes(n) || norm(b.plate).includes(n)) {
          out.push({ key: `b${b.id}`, view: { kind: 'bus', id: b.id }, group: 'Buses', title: `${b.label} · ${b.plate}`, sub: b.route ? `${b.route.code} hacia ${b.route.dest}` : 'ruta sin datos', route: b.route, score: 5 });
          if (++k >= 5) break;
        }
      }
    }
    return out;
  });
  $effect(() => { void results; active = 0; });

  function close() { app.searchOpen = false; }
  function pick(i: Item) { close(); go(i.view); }
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(results.length - 1, active + 1); scroll(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); scroll(); }
    else if (e.key === 'Enter' && results[active]) { e.preventDefault(); pick(results[active]); }
  }
  function scroll() { tick().then(() => document.querySelector('.results .active')?.scrollIntoView({ block: 'nearest' })); }
</script>

<div class="scrim" onclick={close} role="presentation"></div>
<div class="search" role="dialog" aria-label="Buscar" aria-modal="true">
  <div class="field">
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M11 11 L15 15" stroke="currentColor" stroke-width="1.5" /></svg>
    <input bind:this={input} bind:value={q} onkeydown={key} placeholder="B10, Calle 72, Suba, E0035…" autocomplete="off" spellcheck="false" aria-label="Buscar" role="combobox" aria-expanded={results.length > 0} aria-controls="search-results" />
    <button class="esc" onclick={close} aria-label="Cerrar">{app.narrow ? 'Cerrar' : 'Esc'}</button>
  </div>
  {#if q && !results.length}
    <p class="empty faint">Sin resultados para «{q}».</p>
  {:else if results.length}
    <ul class="results scroll" id="search-results" role="listbox">
      {#each results as r, i (r.key)}
        {#if i === 0 || results[i - 1].group !== r.group}<li class="group label" role="presentation">{r.group}</li>{/if}
        <li role="option" aria-selected={i === active}>
          <button class:active={i === active} onclick={() => pick(r)} onmousemove={() => (active = i)}>
            {#if r.route}<RouteBadge route={r.route} />{:else}<span class="icon" class:stop={r.group === 'Paraderos'}></span>{/if}
            <span class="t">{r.title}</span>
            <span class="s faint">{r.sub}</span>
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty faint">Escribe el código de una ruta, el nombre de una estación o paradero, o el número o placa de un bus.</p>
  {/if}
</div>

<style>
  .scrim { position: fixed; inset: 0; background: var(--scrim); z-index: 40; animation: fade var(--t-in) var(--ease-out); }
  .search {
    position: fixed;
    top: 12vh;
    left: 50%;
    width: min(600px, calc(100vw - 32px));
    transform: translateX(-50%);
    background: var(--bg-1);
    border: 1px solid var(--line-2);
    z-index: 41;
    display: flex;
    flex-direction: column;
    max-height: 70vh;
    animation: rise var(--t-in) var(--ease-out);
  }
  .field { display: flex; align-items: center; gap: var(--sp-3); height: 52px; padding: 0 var(--sp-4); border-bottom: 1px solid var(--line-1); color: var(--fg-2); }
  input { flex: 1; background: none; border: 0; outline: none; font-size: 16px; color: var(--fg-0); min-width: 0; }
  input::placeholder { color: var(--fg-2); }
  .esc { font-family: var(--font-mono); font-size: var(--fs-label); color: var(--fg-2); border: 1px solid var(--line-2); padding: 2px 6px; }
  .results { list-style: none; margin: 0; padding: 0 0 var(--sp-2); overflow-y: auto; }
  .group { padding: var(--sp-3) var(--sp-4) var(--sp-1); }
  .results button { width: 100%; height: var(--row); display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: var(--sp-3); padding: 0 var(--sp-4); text-align: left; }
  .results button.active { background: var(--bg-3); }
  .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s { font-size: var(--fs-small); white-space: nowrap; max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
  .icon { width: 38px; height: 22px; display: inline-flex; align-items: center; justify-content: center; }
  .icon::before { content: ''; width: 9px; height: 9px; background: var(--station); box-shadow: 0 0 0 1.5px var(--fg-1); }
  .icon.stop::before { border-radius: 50%; background: var(--bg-1); border: 1.5px solid var(--stop); }
  .empty { margin: 0; padding: var(--sp-4); font-size: var(--fs-small); line-height: 1.5; }
  @keyframes fade { from { opacity: 0; } }
  @keyframes rise { from { opacity: 0; transform: translate(-50%, -6px); } }
  @media (max-width: 759px) {
    .search { top: 0; left: 0; width: 100vw; max-height: 100dvh; height: 100dvh; transform: none; border: 0; padding-top: var(--safe-top); animation: fade var(--t-in) var(--ease-out); }
  }
</style>

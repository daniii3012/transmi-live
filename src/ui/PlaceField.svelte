<script lang="ts">
  import { app } from '../app/store.svelte';
  import { norm } from './derive';
  import { endName, type End } from '../planner/places';

  let { label, value, onpick, mark }: { label: string; value: End | null; onpick: (e: End | null) => void; mark: 'from' | 'to' } = $props();
  const net = $derived(app.net!);
  let editing = $state(false);
  let q = $state('');
  let active = $state(0);
  let input = $state<HTMLInputElement>();

  const results = $derived.by(() => {
    const n = norm(q);
    const out: { key: string; end: End; title: string; sub: string; stop?: boolean }[] = [{ key: 'u', end: { kind: 'here' }, title: 'Mi ubicación', sub: 'GPS del dispositivo' }];
    if (!n) return out;
    const words = n.split(' ');
    const has = (t: string) => words.every((w) => t.includes(w));
    for (const s of net.stations.values()) if (!s.closed && has(norm(s.name))) { out.push({ key: `s${s.id}`, end: { kind: 'station', id: s.id }, title: s.short, sub: s.kind === 'portal' ? 'portal' : 'estación' }); if (out.length > 7) break; }
    let k = 0;
    for (const s of net.streetStops.values()) if (has(norm(`${s.name} ${s.code}`))) { out.push({ key: `p${s.id}`, end: { kind: 'stop', id: s.id }, title: s.name, sub: `paradero ${s.code}`, stop: true }); if (++k >= 5) break; }
    return out;
  });
  $effect(() => { void results; active = 0; });

  function open() { editing = true; q = ''; void net.loadStreetStops(); setTimeout(() => input?.focus()); }
  function pick(e: End) { editing = false; onpick(e); }
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') { editing = false; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(results.length - 1, active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); }
    else if (e.key === 'Enter' && results[active]) { e.preventDefault(); pick(results[active].end); }
  }
</script>

<div class="field" class:editing>
  <span class="mark {mark}" aria-hidden="true"></span>
  <span class="lab label">{label}</span>
  {#if editing}
    <input bind:this={input} bind:value={q} onkeydown={key} onblur={() => setTimeout(() => (editing = false), 150)} placeholder="Estación, paradero o mi ubicación" autocomplete="off" spellcheck="false" aria-label={label} />
  {:else}
    <button class="val" class:empty={!value} onclick={open}>{value ? endName(net, value) : 'Elegir…'}</button>
    {#if value}<button class="x" onclick={() => onpick(null)} aria-label="Quitar">×</button>{/if}
  {/if}
</div>
{#if editing && results.length}
  <ul class="drop">
    {#each results as r, i (r.key)}
      <li><button class:active={i === active} onmousedown={(e) => { e.preventDefault(); pick(r.end); }}>
        <span class="ic" class:stop={r.stop} class:here={r.end.kind === 'here'}></span><span class="t">{r.title}</span><span class="s faint">{r.sub}</span>
      </button></li>
    {/each}
  </ul>
{/if}

<style>
  .field { height: var(--row); display: grid; grid-template-columns: 16px 44px 1fr auto; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-3); border: 1px solid var(--line-2); background: var(--bg-2); }
  .field.editing { border-color: var(--fg-3); }
  .mark { width: 8px; height: 8px; justify-self: center; }
  .mark.from { border-radius: 50%; border: 2px solid var(--fg-0); }
  .mark.to { background: var(--fg-0); }
  .lab { color: var(--fg-2); }
  .val { text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; height: 100%; }
  .val.empty { color: var(--fg-2); }
  .x { width: 24px; height: 24px; color: var(--fg-2); font-size: 16px; }
  .x:hover { color: var(--fg-0); }
  input { background: none; border: 0; outline: none; color: var(--fg-0); min-width: 0; font-size: 16px; grid-column: 3 / 5; }
  input::placeholder { color: var(--fg-3); }
  .drop { list-style: none; margin: -1px 0 0; padding: 0; border: 1px solid var(--line-2); background: var(--bg-1); }
  .drop button { width: 100%; height: 36px; display: grid; grid-template-columns: 20px 1fr auto; gap: var(--sp-2); align-items: center; padding: 0 var(--sp-3); text-align: left; }
  .drop button.active { background: var(--bg-3); }
  .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s { font-size: var(--fs-label); }
  .ic { width: 8px; height: 8px; background: var(--station); justify-self: center; }
  .ic.stop { border-radius: 50%; background: none; border: 1.5px solid var(--stop); }
  .ic.here { border-radius: 50%; background: #fff; box-shadow: 0 0 0 2px var(--bg-1), 0 0 0 3px var(--fg-2); }
</style>

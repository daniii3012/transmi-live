<script lang="ts">
  import { app } from '../app/store.svelte';
  import { go } from '../app/router';
  import { decodePlan, encodePlan, type End } from '../planner/places';

  const m = $derived(app.ctxMenu);
  function pick(which: 'from' | 'to') {
    if (!m) return;
    const here: End = { kind: 'point', lon: m.lon, lat: m.lat };
    // Si ya hay un viaje a medio armar, se conserva el otro extremo.
    const cur = app.view.kind === 'plan' ? decodePlan(app.view.id) : { from: null, to: null, time: null };
    const id = which === 'from' ? encodePlan(here, cur.to, cur.time) : encodePlan(cur.from, here, cur.time);
    app.ctxMenu = null;
    go({ kind: 'plan', id });
  }
</script>

{#if m}
  <div class="scrim" onclick={() => (app.ctxMenu = null)} oncontextmenu={(e) => { e.preventDefault(); app.ctxMenu = null; }} role="presentation"></div>
  <div class="menu" style:left="{Math.min(m.x + 8, innerWidth - 200)}px" style:top="{Math.min(m.y + 8, innerHeight - 110)}px" role="menu">
    <button role="menuitem" onclick={() => pick('from')}><span class="mk from"></span>Ir desde aquí</button>
    <button role="menuitem" onclick={() => pick('to')}><span class="mk to"></span>Ir hasta aquí</button>
  </div>
  <span class="pin" style:left="{m.x}px" style:top="{m.y}px" aria-hidden="true"></span>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 30; }
  .menu { position: absolute; z-index: 31; width: 184px; background: var(--bg-1); border: 1px solid var(--line-2); box-shadow: var(--shadow); animation: in var(--t-in) var(--ease-out); }
  .menu button { width: 100%; height: 40px; display: flex; align-items: center; gap: var(--sp-3); padding: 0 var(--sp-3); text-align: left; font-size: var(--fs-body); }
  .menu button + button { border-top: 1px solid var(--line-1); }
  .menu button:hover { background: var(--bg-2); }
  .mk { width: 8px; height: 8px; }
  .mk.from { border-radius: 50%; border: 2px solid var(--fg-0); }
  .mk.to { background: var(--fg-0); }
  .pin { position: absolute; z-index: 31; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; background: var(--fg-0); box-shadow: 0 0 0 3px var(--bg-1); pointer-events: none; }
  @keyframes in { from { opacity: 0; transform: translateY(-3px); } }
</style>

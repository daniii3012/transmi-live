<script lang="ts">
  import { app } from '../app/store.svelte';
  import { ctl } from '../app/instance';
  let { bearing = 0 }: { bearing?: number } = $props();
  // Siguiendo un bus, la brújula alterna norte arriba y rumbo arriba (R10.3).
  const heading = $derived(app.following && app.followHeading);
  const label = $derived(app.following ? (heading ? 'Norte arriba' : 'Rumbo arriba: el mapa gira con el bus') : 'Norte arriba');
</script>

<div class="controls" class:narrow={app.narrow} style:--sheet="{app.sheetHeight}px">
  <div class="group zoom">
    <button onclick={() => ctl?.zoom(1)} aria-label="Acercar"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.5" /></svg></button>
    <button onclick={() => ctl?.zoom(-1)} aria-label="Alejar"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 7h12" stroke="currentColor" stroke-width="1.5" /></svg></button>
  </div>
  <div class="group">
    <button class:on={app.layersOpen} onclick={() => (app.layersOpen = !app.layersOpen)} aria-label="Capas" title="Capas">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 2 15 5.5 8 9 1 5.5Z" /><path d="M1 8.5 8 12l7-3.5" /><path d="M1 11.5 8 15l7-3.5" /></svg>
    </button>
    <button class="d3" class:on={app.threeD} onclick={() => ctl?.set3d(!app.threeD)} aria-pressed={app.threeD} aria-label="Vista 3D" title="Vista 3D">3D</button>
    <button class:on={heading} onclick={() => ctl?.compass()} aria-label={label} title={label} aria-pressed={app.following ? heading : undefined}>
      <svg width="16" height="16" viewBox="0 0 16 16" style:transform="rotate({-bearing}deg)"><path d="M8 1 L11 8 H5 Z" fill="#e5483b" /><path d="M8 15 L5 8 H11 Z" fill="currentColor" /></svg>
    </button>
    <button onclick={() => ctl?.overview()} aria-label="Toda la ciudad" title="Toda la ciudad">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1 4V1h3M10 1h3v3M13 10v3h-3M4 13H1v-3" /></svg>
    </button>
    <button onclick={() => ctl?.locate()} aria-label="Ubicación actual" title="Ubicación actual" class:busy={app.locating}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="4" /><path d="M8 0v3M8 13v3M0 8h3M13 8h3" /></svg>
    </button>
  </div>
</div>

<style>
  .controls { position: absolute; right: var(--sp-4); bottom: calc(var(--sp-6) + 20px); display: grid; gap: var(--sp-2); z-index: 5; }
  .controls.narrow { right: var(--sp-3); bottom: calc(var(--sheet) + var(--sp-3)); transition: bottom 260ms var(--ease-out); }
  .group { display: grid; background: var(--glass); box-shadow: var(--shadow); border: 1px solid var(--line-2); }
  .group button + button { border-top: 1px solid var(--line-1); }
  button { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; color: var(--fg-1); transition: color var(--t-out), background var(--t-out); }
  button:hover { color: var(--fg-0); background: var(--bg-2); }
  svg { transition: transform 200ms var(--ease-out); }
  .d3 { font-family: var(--font-mono); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; }
  .d3.on, button.on { background: var(--fg-0); color: var(--bg-0); }
  .busy svg { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (pointer: coarse) { button { width: 44px; height: 44px; } .zoom { display: none; } }
</style>

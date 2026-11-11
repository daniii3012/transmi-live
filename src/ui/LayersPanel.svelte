<script lang="ts">
  import { app } from '../app/store.svelte';
  import { ctl } from '../app/instance';
  const items: { key: keyof typeof app.layersOn; name: string; note: string }[] = [
    { key: 'speed', name: 'Velocidad en la troncal', note: 'lento en rojo · medida con los buses' },
    { key: 'dual', name: 'Rutas duales', note: 'recorridos de fondo' },
    { key: 'zonal', name: 'Rutas zonales y alimentadoras', note: 'recorridos de fondo' },
    { key: 'stops', name: 'Paraderos', note: 'desde zoom de calle' },
    { key: 'metro', name: 'Metro · Línea 1', note: 'en obra · vista previa' },
    { key: 'obras', name: 'Troncales en obra', note: 'Av. 68, Séptima, Soacha, Calle 13 · vista previa' },
    { key: 'trails', name: 'Larga exposición', note: 'lo recorrido en 3 min · sistemas visibles' },
  ];
</script>

{#if app.layersOpen}
  <div class="scrim" onclick={() => (app.layersOpen = false)} role="presentation"></div>
  <div class="panel" class:narrow={app.narrow} style:--sheet="{app.sheetHeight}px" role="dialog" aria-label="Capas">
    <div class="head"><span class="label">Capas</span><button class="x" onclick={() => (app.layersOpen = false)} aria-label="Cerrar">×</button></div>
    <div class="theme">
      <span class="label">Tema</span>
      <div class="seg">
        {#each [['system', 'Sistema'], ['dark', 'Oscuro'], ['light', 'Claro']] as [k, name] (k)}
          <button class:on={app.themePref === k} onclick={() => ctl?.setTheme(k as 'system' | 'dark' | 'light')}>{name}</button>
        {/each}
      </div>
    </div>
    {#each items as it (it.key)}
      <label class="row">
        <input type="checkbox" checked={app.layersOn[it.key]} onchange={(e) => ctl?.setLayer(it.key, e.currentTarget.checked)} />
        <span class="box" aria-hidden="true"></span>
        <span class="txt"><span>{it.name}</span><span class="faint note">{it.note}</span></span>
      </label>
    {/each}
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 30; }
  .panel { position: absolute; right: calc(var(--sp-4) + 48px); bottom: calc(var(--sp-6) + 20px); width: 280px; background: var(--bg-1); border: 1px solid var(--line-2); z-index: 31; animation: in var(--t-in) var(--ease-out); }
  .panel.narrow { right: var(--sp-3); left: var(--sp-3); width: auto; bottom: calc(var(--sheet) + var(--sp-3)); }
  /* En teléfonos bajos (o con la hoja alta) el panel no pasa de la barra superior: se desplaza. */
  .panel { max-height: calc(100dvh - var(--safe-top) - 64px - var(--sp-6) - 20px); overflow-y: auto; overscroll-behavior: contain; }
  .panel.narrow { max-height: calc(100dvh - var(--sheet) - var(--safe-top) - 72px); }
  .head { height: 36px; display: flex; align-items: center; justify-content: space-between; padding: 0 var(--sp-3); border-bottom: 1px solid var(--line-1); }
  .x { width: 24px; height: 24px; color: var(--fg-2); font-size: 16px; }
  .theme { display: grid; gap: 6px; padding: 10px var(--sp-3); border-bottom: 1px solid var(--line-1); }
  .seg { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--line-2); }
  .seg button { height: 28px; font-size: var(--fs-small); color: var(--fg-1); }
  .seg button + button { border-left: 1px solid var(--line-2); }
  .seg button.on { background: var(--fg-0); color: var(--bg-1); }
  .row { display: grid; grid-template-columns: 14px 1fr; gap: var(--sp-3); align-items: center; padding: 10px var(--sp-3); cursor: pointer; position: relative; }
  .row + .row { border-top: 1px solid var(--line-1); }
  .row:hover { background: var(--bg-2); }
  input { position: absolute; opacity: 0; pointer-events: none; }
  .box { width: 14px; height: 14px; border: 1px solid var(--fg-2); }
  input:checked + .box { background: var(--fg-0); border-color: var(--fg-0); box-shadow: inset 0 0 0 3px var(--bg-1); }
  input:focus-visible + .box { outline: 1px solid var(--fg-0); outline-offset: 2px; }
  .txt { display: grid; }
  .note { font-size: var(--fs-label); }
  @keyframes in { from { opacity: 0; transform: translateY(4px); } }
</style>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { app } from '../app/store.svelte';
  import { go } from '../app/router';
  import { ctl } from '../app/instance';
  import Brand from './Brand.svelte';
  import StatusLine from './StatusLine.svelte';

  let { children }: { children: Snippet } = $props();

  // Cada vista nueva empieza arriba (si no, heredaba el desplazamiento de la anterior y la cabecera
  // con «Volver» y «Cerrar» quedaba fuera de la vista).
  let scrollers: HTMLElement[] = [];
  $effect(() => {
    void app.view.kind; void (app.view as { id?: string }).id;
    for (const el of scrollers) if (el) el.scrollTop = 0;
  });

  // ── Hoja inferior (móvil) ──────────────────────────────────────────────────────────────────
  // Tres alturas: asomada (lo esencial de la vista), media y completa. Arrastre con inercia.
  type Snap = 'peek' | 'half' | 'full';
  let snap = $state<Snap>('peek');
  let dragY = $state<number | null>(null);
  let vh = $state(typeof window !== 'undefined' ? window.innerHeight : 800);
  const PEEK = 196;
  // Margen de la barra de inicio del iPhone (`--safe-bottom`): en Safari vale 0 (abajo está la barra del
  // navegador) y en la app instalada ~34 px. La hoja asomada lo suma a su altura; antes salía del
  // contenido y el buscador quedaba recortado en la app instalada.
  let sb = $state(0);
  const heights = $derived({ peek: PEEK + sb, half: Math.round(vh * 0.5), full: vh - 64 });
  const height = $derived(dragY !== null ? dragY : heights[snap]);

  $effect(() => {
    app.sheetHeight = app.narrow ? heights[snap] : 0;
    // Tras la transición de altura, el relleno del mapa sigue a la hoja.
    const t = setTimeout(() => ctl?.syncPadding(), 280);
    return () => clearTimeout(t);
  });
  // Al cambiar de vista, la hoja muestra al menos la media altura (la ficha se lee entera).
  $effect(() => {
    const k = app.view.kind;
    if (app.narrow) snap = k === 'home' ? 'peek' : 'half';
  });

  let start = { y: 0, h: 0, t: 0 };
  let samples: { y: number; t: number }[] = [];
  function down(e: PointerEvent) {
    if (!app.narrow) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start = { y: e.clientY, h: height, t: performance.now() };
    samples = [{ y: e.clientY, t: start.t }];
    dragY = height;
  }
  function move(e: PointerEvent) {
    if (dragY === null) return;
    const h = start.h + (start.y - e.clientY);
    dragY = Math.max(heights.peek - 40, Math.min(heights.full, h));
    samples.push({ y: e.clientY, t: performance.now() });
    if (samples.length > 5) samples.shift();
  }
  function up() {
    if (dragY === null) return;
    const a = samples[0], b = samples[samples.length - 1];
    const v = b && a && b.t > a.t ? (a.y - b.y) / (b.t - a.t) : 0; // px/ms, positivo = hacia arriba
    const projected = dragY + v * 180;
    const order: Snap[] = ['peek', 'half', 'full'];
    let best: Snap = 'peek';
    for (const s of order) if (Math.abs(heights[s] - projected) < Math.abs(heights[best] - projected)) best = s;
    // Un toque sin arrastre alterna entre asomada y media.
    if (Math.abs(start.y - (b?.y ?? start.y)) < 4) best = snap === 'peek' ? 'half' : snap === 'half' ? 'peek' : 'half';
    snap = best;
    dragY = null;
  }

  onMount(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:var(--safe-bottom);visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    const r = () => { vh = window.innerHeight; sb = probe.offsetHeight; };
    r();
    addEventListener('resize', r);
    return () => { removeEventListener('resize', r); probe.remove(); };
  });
</script>

{#if app.narrow}
  <header class="topbar">
    <Brand onclick={() => go({ kind: 'home' })} />
    <StatusLine compact />
  </header>
  <section
    class="sheet"
    class:dragging={dragY !== null}
    style:height="{height}px"
    aria-label="Panel"
  >
    <div class="grip" role="slider" aria-label="Altura del panel" aria-valuenow={height} tabindex="0"
      onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}
      onkeydown={(e) => { if (e.key === 'ArrowUp') snap = snap === 'peek' ? 'half' : 'full'; if (e.key === 'ArrowDown') snap = snap === 'full' ? 'half' : 'peek'; }}>
      <span></span>
    </div>
    <div class="content scroll" class:locked={snap === 'peek'} bind:this={scrollers[0]}>
      {@render children()}
    </div>
  </section>
{:else}
  <aside class="panel" aria-label="Panel">
    <header class="head">
      <div class="row1">
        <Brand onclick={() => go({ kind: 'home' })} />
        <button class="kbd" onclick={() => (app.searchOpen = true)} aria-label="Buscar">
          <span>⌘K</span>
        </button>
      </div>
      <StatusLine />
    </header>
    <div class="content scroll" bind:this={scrollers[1]}>
      {@render children()}
    </div>
    <footer class="foot">
      <span class="about">Proyecto no oficial</span>
      <span class="links"><a href="#/configuracion">Configuración</a><a href="https://github.com/daniii3012/transmi-live/blob/main/FUENTES.md" target="_blank" rel="noopener">Fuentes</a></span>
    </footer>
  </aside>
{/if}

<style>
  /* Escritorio: columna fija a la izquierda. */
  /* Panel flotante, separado del borde: el mapa sigue hasta la orilla (revisión R1.16). */
  .panel {
    position: absolute;
    top: var(--sp-3);
    left: var(--sp-3);
    bottom: var(--sp-3);
    width: var(--panel-w);
    display: flex;
    flex-direction: column;
    background: var(--bg-1);
    border: 1px solid var(--line-2);
    box-shadow: var(--shadow);
    z-index: 10;
  }
  .head { padding: var(--sp-3) var(--sp-4) var(--sp-3); border-bottom: 1px solid var(--line-1); display: grid; gap: 6px; }
  .row1 { display: flex; align-items: center; justify-content: space-between; }
  .kbd {
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--line-2);
    font-family: var(--font-mono);
    font-size: var(--fs-label);
    color: var(--fg-2);
    transition: color var(--t-out), border-color var(--t-out);
  }
  .kbd:hover { color: var(--fg-0); border-color: var(--fg-3); }
  .content { flex: 1; min-height: 0; position: relative; }
  .foot {
    height: 32px;
    padding: 0 var(--sp-4);
    border-top: 1px solid var(--line-1);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--fg-2);
  }
  .foot a { color: var(--fg-2); text-decoration: none; }
  .foot .links { display: flex; gap: var(--sp-3); flex: none; }
  .foot .about { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: var(--sp-3); }
  .foot a:hover { color: var(--fg-0); }

  /* Móvil: barra superior y hoja inferior. */
  .topbar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    padding: calc(var(--safe-top) + 8px) var(--sp-4) 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    background: var(--glass);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--line-1);
    z-index: 10;
  }
  .sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-1);
    border-top: 1px solid var(--line-2);
    z-index: 10;
    transition: height 260ms var(--ease-out);
    padding-bottom: var(--safe-bottom);
    touch-action: none;
  }
  .sheet.dragging { transition: none; }
  .grip {
    height: 20px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: grab;
    touch-action: none;
  }
  .grip span { width: 36px; height: 3px; background: var(--line-2); }
  .grip:focus-visible { outline-offset: -2px; }
  .sheet .content { touch-action: pan-y; }
  .sheet .content.locked { overflow: hidden; }
</style>

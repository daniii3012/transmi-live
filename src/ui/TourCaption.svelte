<script lang="ts">
  import { app } from '../app/store.svelte';
  import { go } from '../app/router';
  import { fmtNum } from '../domain/time';
  import StatusLine from './StatusLine.svelte';
  import Brand from './Brand.svelte';

  /** Rótulo del recorrido automático (app/tour.ts): qué se muestra, con sus cifras de ahora. */
  const t = $derived(app.tour);
  let now = $state(performance.now());
  $effect(() => {
    let raf = 0;
    const tick = () => { now = performance.now(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
  const progress = $derived(t ? Math.min(1, (now - t.startedAt) / t.duration) : 0);
</script>

<aside class="caption" class:narrow={app.narrow} aria-live="polite">
  <div class="top">
    <Brand onclick={() => go({ kind: 'home' })} />
    <button class="exit" onclick={() => go({ kind: 'home' })} aria-label="Salir del recorrido">
      Salir {#if !app.narrow}<kbd>Esc</kbd>{:else}<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1 1 9" stroke="currentColor" stroke-width="1.4" /></svg>{/if}
    </button>
  </div>
  <StatusLine compact={app.narrow} />
  {#if t}
    <div class="step label">Recorrido · <span class="num">{t.step + 1}/{t.total}</span></div>
    {#if t.kind === 'corridor' && t.zone}
      <h2><span class="chip" style:background={t.zone.color}></span>Troncal {t.zone.name}</h2>
      <p class="dim">
        <span class="num">{fmtNum(t.buses)}</span> {t.buses === 1 ? 'bus troncal en vía' : 'buses troncales en vía'}
        {#if t.bus}· siguiendo el <span class="code num" style:background={t.bus.color}>{t.bus.code}</span> hacia {t.bus.dest} <span class="faint">· bus <span class="num">{t.bus.label}</span></span>{:else}<span class="faint"> · sin buses en vivo para seguir</span>{/if}
      </p>
    {:else}
      <h2>{#if t.color}<span class="chip" style:background={t.color}></span>{/if}{t.title}</h2>
      <p class="dim">{t.detail}</p>
    {/if}
    <div class="bar" aria-hidden="true"><span style:width="{progress * 100}%"></span></div>
  {/if}
</aside>

<style>
  .caption {
    position: absolute;
    left: var(--sp-4);
    bottom: var(--sp-4);
    width: min(440px, calc(100% - 2 * var(--sp-4)));
    padding: var(--sp-3) var(--sp-4) var(--sp-3);
    display: grid;
    gap: 6px;
    background: var(--glass);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid var(--line-2);
    box-shadow: var(--shadow);
    z-index: 10;
  }
  .caption.narrow { left: var(--sp-3); right: var(--sp-3); width: auto; bottom: calc(var(--safe-bottom) + var(--sp-3)); }
  .top { display: flex; justify-content: space-between; align-items: center; }
  .exit { height: 26px; padding: 0 8px; border: 1px solid var(--line-2); display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-small); color: var(--fg-1); }
  .exit:hover { color: var(--fg-0); border-color: var(--fg-3); }
  kbd { font-family: var(--font-mono); font-size: 10px; color: var(--fg-2); }
  .step { margin-top: var(--sp-2); }
  h2 { margin: 0; font-size: var(--fs-title); font-weight: 500; letter-spacing: -0.01em; display: flex; align-items: center; gap: var(--sp-2); }
  .chip { width: 10px; height: 10px; flex: none; }
  p { margin: 0; font-size: var(--fs-small); line-height: 1.6; }
  .code { color: #fff; padding: 0 5px; font-family: var(--font-mono); font-size: 11px; font-weight: 600; text-shadow: 0 0 2px rgba(0, 0, 0, 0.35); }
  .bar { height: 2px; background: var(--line-1); margin-top: var(--sp-2); }
  .bar span { display: block; height: 100%; background: var(--fg-1); }
  @media (prefers-reduced-motion: reduce) { .bar span { transition: none; } }
</style>

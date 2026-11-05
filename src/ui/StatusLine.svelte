<script lang="ts">
  import { app } from '../app/store.svelte';
  import { fmtHMS, ago, fmtNum } from '../domain/time';

  let { compact = false }: { compact?: boolean } = $props();
  const p = $derived(app.poll);
  const age = $derived(p.feedTime ? Math.max(0, app.now / 1000 - p.feedTime) : null);
  const label = $derived(
    p.status === 'live' ? 'En vivo' : p.status === 'stale' ? 'Datos viejos' : p.status === 'error' ? 'Sin conexión' : p.status === 'idle' ? 'En pausa' : 'Conectando',
  );
</script>

<!-- Solo el estado se anuncia (al cambiar); la hora y la antigüedad cambian cada segundo y se leen al
     recorrer la página, no como aviso. -->
<div class="status {p.status}" class:compact>
  <span class="dot" aria-hidden="true"></span>
  <span class="label" role="status" aria-live="polite">{label}</span>
  {#if p.feedTime}
    <span class="sep" aria-hidden="true">·</span>
    <span class="num"><span class="sr">datos de las </span>{fmtHMS(p.feedTime * 1000)}</span>
    {#if !compact}
      <span class="sep" aria-hidden="true">·</span>
      <span class="num faint">hace {ago(age ?? 0)}</span>
    {/if}
  {/if}
  {#if !compact && p.status === 'error' && p.error}
    <span class="sep">·</span><span class="faint">{p.error}</span>
  {/if}
  {#if compact && p.vehicles}
    <span class="sep">·</span><span class="num">{fmtNum(p.vehicles)}</span>
  {/if}
</div>

<style>
  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 20px;
    font-family: var(--font-mono);
    font-size: var(--fs-label);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-1);
    white-space: nowrap;
    overflow: hidden;
  }
  .label { color: var(--fg-0); font-weight: 500; }
  .sep { color: var(--fg-3); }
  .num { font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
  .faint { color: var(--fg-2); }
  .dot { width: 6px; height: 6px; background: var(--fg-2); flex: none; }
  .live .dot { background: var(--fg-0); animation: pulse 2s var(--ease-out) infinite; }
  .stale .dot { background: var(--warn); }
  .stale .label { color: var(--warn); }
  .error .dot { background: var(--error); }
  .error .label { color: var(--error); }
  .connecting .dot { animation: blink 1s steps(2) infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(236, 239, 242, 0.5); } 70%, 100% { box-shadow: 0 0 0 6px rgba(236, 239, 242, 0); } }
  @keyframes blink { 50% { opacity: 0.2; } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none !important; } }
</style>

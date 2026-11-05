<script lang="ts">
  import { watch } from '../app/watch.svelte';
  import { go } from '../app/router';
  const t = $derived(watch.toast);
</script>

{#if t}
  <div class="toast" role="alert">
    <span class="dot" aria-hidden="true"></span>
    <span class="text">{t.text}</span>
    {#if t.busId}<button class="act" onclick={() => { go({ kind: 'bus', id: t.busId! }); watch.toast = null; }}>Ver bus</button>{/if}
    <button class="x" onclick={() => (watch.toast = null)} aria-label="Cerrar aviso">×</button>
  </div>
{/if}

<style>
  .toast {
    position: fixed; left: 50%; top: calc(var(--safe-top) + 64px); transform: translateX(-50%); z-index: 45;
    display: flex; align-items: center; gap: var(--sp-3); width: min(520px, calc(100vw - 24px));
    padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3); background: var(--fg-0); color: var(--bg-1);
    box-shadow: var(--shadow); font-size: var(--fs-body); animation: in var(--t-in) var(--ease-out);
  }
  .dot { width: 8px; height: 8px; background: var(--bg-1); flex: none; animation: blink 1.2s steps(2) 3; }
  .text { flex: 1; }
  .act { flex: none; white-space: nowrap; height: 30px; padding: 0 var(--sp-3); border: 1px solid var(--bg-1); color: var(--bg-1); font-family: var(--font-mono); font-size: var(--fs-label); letter-spacing: 0.06em; text-transform: uppercase; }
  .x { flex: none; width: 30px; height: 30px; color: var(--bg-1); font-size: 18px; }
  @keyframes in { from { opacity: 0; transform: translate(-50%, -6px); } }
  @keyframes blink { 50% { opacity: 0.2; } }
  @media (prefers-reduced-motion: reduce) { .toast, .dot { animation: none; } }
</style>

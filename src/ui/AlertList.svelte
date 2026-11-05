<script lang="ts">
  import { describe, type Alert } from '../live/alerts';
  let { alerts }: { alerts: Alert[] } = $props();
  let open = $state(false);
  const shown = $derived(open ? alerts : alerts.slice(0, 2));
</script>

{#if alerts.length}
  <section class="alerts" aria-label="Alertas">
    {#each shown as a (a.id)}
      {@const d = describe(a)}
      <div class="alert">
        <div class="t">{d.title}{#if d.detail}<span class="dim">&nbsp;{d.detail}</span>{/if}</div>
        <div class="code">{d.code}</div>
      </div>
    {/each}
    {#if alerts.length > 2}
      <button class="more" onclick={() => (open = !open)}>{open ? 'Mostrar menos' : `${alerts.length - 2} alertas más`}</button>
    {/if}
  </section>
{/if}

<style>
  .alerts { display: grid; border: 1px solid var(--line-2); border-left: 2px solid var(--warn); }
  .alert { padding: var(--sp-2) var(--sp-3); display: grid; gap: 2px; }
  .alert + .alert { border-top: 1px solid var(--line-1); }
  .t { font-size: var(--fs-small); color: var(--fg-0); }
  .code { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.04em; color: var(--fg-2); word-break: break-all; }
  .more { height: 28px; border-top: 1px solid var(--line-1); font-size: var(--fs-label); font-family: var(--font-mono); letter-spacing: 0.04em; color: var(--fg-1); text-transform: uppercase; }
  .more:hover { color: var(--fg-0); }
</style>

<script lang="ts">
  import type { Route } from '../domain/types';
  import { textOn } from '../domain/time';
  import { busCode } from '../domain/legs';

  /** `code`: el del tramo cuando se sabe (bus, llegada a una parada); si no, los códigos del bus. */
  let { route, size = 'md', code }: { route: Route | undefined; size?: 'sm' | 'md' | 'lg'; code?: string } = $props();
  const bg = $derived(route?.color ?? '#69727d');
  const label = $derived(code ?? (route ? busCode(route) : '—'));
  const title = $derived(route ? `${label}${label !== route.code ? ` (en el catálogo, ${route.code})` : ''} · ${route.dest}` : '');
</script>

<span class="badge {size}" style:background={bg} style:color={textOn(bg)} {title}>
  {label}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.01em;
    white-space: nowrap;
    flex: none;
  }
  .sm { height: 18px; min-width: 30px; padding: 0 4px; font-size: 11px; }
  .md { height: 22px; min-width: 38px; padding: 0 6px; font-size: 12px; }
  .lg { height: 32px; min-width: 56px; padding: 0 10px; font-size: 16px; letter-spacing: 0.02em; }
</style>

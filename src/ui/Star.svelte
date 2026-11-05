<script lang="ts">
  import { favorites, type Favorite } from '../app/favorites.svelte';
  let { kind, id }: { kind: Favorite['kind']; id: string } = $props();
  const on = $derived(favorites.has(kind, id));
</script>

<button class="star" class:on onclick={() => favorites.toggle(kind, id)} aria-pressed={on} aria-label={on ? 'Quitar de favoritos' : 'Guardar en favoritos'} title={on ? 'Quitar de favoritos' : 'Guardar en favoritos'}>
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.9 4.2 4.6.4-3.5 3 1.1 4.5L8 11.2l-4.1 2.4L5 9.1 1.5 6.1l4.6-.4z" /></svg>
</button>

<style>
  .star { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--line-2); color: var(--fg-2); flex: none; }
  .star svg { fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linejoin: miter; }
  .star:hover { color: var(--fg-0); border-color: var(--fg-3); }
  .star.on { color: var(--fg-0); }
  .star.on svg { fill: currentColor; }
</style>

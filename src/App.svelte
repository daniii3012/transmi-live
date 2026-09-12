<script lang="ts">
  import { onMount } from 'svelte';
  import { MapView } from './map/MapView';

  let container: HTMLDivElement;
  let view: MapView | undefined;

  onMount(() => {
    view = new MapView(container);
    (window as any).__map = view.map;
    return () => view?.map.remove();
  });
</script>

<div class="map" bind:this={container}></div>

<style>
  .map { position: absolute; inset: 0; background: var(--bg-0); }
</style>

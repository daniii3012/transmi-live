<script lang="ts">
  import { onMount } from 'svelte';
  import { MapView } from './map/MapView';
  import { Network } from './data/network';
  import { NetworkLayers } from './map/networkLayers';

  let container: HTMLDivElement;
  let view: MapView | undefined;

  onMount(() => {
    view = new MapView(container);
    const w = window as any;
    w.__map = view.map;
    (async () => {
      const [net] = await Promise.all([Network.load(), view!.ready()]);
      const layers = new NetworkLayers(view!.map, net);
      layers.mount();
      w.__net = net;
      w.__layers = layers;
      await layers.loadZonal();
      layers.loadStreetStops();
      const focus = new URLSearchParams(location.search).get('focus');
      if (focus) layers.setFocus(focus);
    })();
    return () => view?.map.remove();
  });
</script>

<div class="map" bind:this={container}></div>

<style>
  .map { position: absolute; inset: 0; background: var(--bg-0); }
</style>

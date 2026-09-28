<script lang="ts">
  import { onMount } from 'svelte';
  import { MapView } from './map/MapView';
  import { Network } from './data/network';
  import { NetworkLayers } from './map/networkLayers';
  import { Fleet } from './live/fleet';
  import { Poller } from './live/poller';
  import { apiBase } from './live/api';
  import { BusLayer } from './map/busLayer';

  let container: HTMLDivElement;
  let view: MapView | undefined;

  onMount(() => {
    view = new MapView(container);
    const w = window as any;
    w.__map = view.map;
    let poller: Poller | undefined;
    (async () => {
      const [net] = await Promise.all([Network.load(), view!.ready()]);
      const layers = new NetworkLayers(view!.map, net);
      layers.mount();
      const fleet = new Fleet(net);
      const buses = new BusLayer(fleet);
      view!.map.addLayer(buses, 'stations-label');
      w.__net = net;
      w.__layers = layers;
      w.__fleet = fleet;
      w.__fps = () => buses.fps();
      poller = new Poller(apiBase(), (d) => { fleet.ingest(d); view!.map.triggerRepaint(); }, (s) => (w.__poll = s));
      poller.start();
      await layers.loadZonal();
      // Las rutas zonales llegan después: los buses que ya estaban se reubican en la próxima lectura.
      for (const b of fleet.buses.values()) if (!b.path) b.path = net.paths.get(b.routeId);
      layers.loadStreetStops();
      const focus = new URLSearchParams(location.search).get('focus');
      if (focus) layers.setFocus(focus);
    })();
    return () => { poller?.stop(); view?.map.remove(); };
  });
</script>

<div class="map" bind:this={container}></div>

<style>
  .map { position: absolute; inset: 0; background: var(--bg-0); }
</style>

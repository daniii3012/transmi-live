<script lang="ts">
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { MapView } from './map/MapView';
  import { Network } from './data/network';
  import { NetworkLayers } from './map/networkLayers';
  import { Fleet } from './live/fleet';
  import { BusLayer } from './map/busLayer';
  import { Controller } from './app/controller';
  import { setController, ctl } from './app/instance';
  import { app } from './app/store.svelte';
  import { go } from './app/router';
  import Panel from './ui/Panel.svelte';
  import HomeView from './ui/HomeView.svelte';
  import RouteView from './ui/RouteView.svelte';
  import BusView from './ui/BusView.svelte';
  import StationView from './ui/StationView.svelte';
  import PlanView from './ui/PlanView.svelte';
  import Search from './ui/Search.svelte';
  import MapControls from './ui/MapControls.svelte';
  import LayersPanel from './ui/LayersPanel.svelte';
  import MapMenu from './ui/MapMenu.svelte';
  import { applyTheme, effective } from './app/theme';

  let container: HTMLDivElement;
  let bearing = $state(0);
  let failed = $state<string | null>(null);
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  onMount(() => {
    applyTheme(effective());
    const view = new MapView(container, effective());
    const w = window as any;
    w.__map = view.map;
    view.map.on('rotate', () => (bearing = view.map.getBearing()));
    let controller: Controller | undefined;
    (async () => {
      try {
        const [net] = await Promise.all([Network.load(), view.ready()]);
        const layers = new NetworkLayers(view.map, net, effective());
        layers.mount();
        const fleet = new Fleet(net);
        // Orden de capas (DISENO.md): buses atenuados bajo la ruta en foco; el resto sobre las estaciones.
        const buses = new BusLayer(fleet, 'main');
        const dimBuses = new BusLayer(fleet, 'dim');
        view.map.addLayer(dimBuses, 'route-focus-glow');
        view.map.addLayer(buses, 'stations-label');
        controller = new Controller(view.map, net, fleet, layers, buses);
        controller.dimBuses = dimBuses;
        setController(controller);
        app.net = net;
        app.fleet = fleet;
        controller.start();
        Object.assign(w, { __net: net, __fleet: fleet, __layers: layers, __ctl: controller, __fps: () => buses.fps(), __app: app });
        await layers.loadZonal();
        fleet.relocate();
        view.map.triggerRepaint();
        void layers.loadStreetStops();
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e);
      }
    })();
    return () => { controller?.stop(); setController(null); view.map.remove(); };
  });

  function onKey(e: KeyboardEvent) {
    const typing = (e.target as HTMLElement)?.closest('input, textarea');
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
      e.preventDefault();
      app.searchOpen = true;
      return;
    }
    if (typing || app.searchOpen) return;
    if (e.key === 'Escape' && app.view.kind !== 'home') go({ kind: 'home' });
    else if ((e.key === 'f' || e.key === 'F') && app.view.kind === 'bus') ctl?.toggleFollow();
    else if ((e.key === 'r' || e.key === 'R') && app.view.kind === 'bus') {
      const b = app.fleet?.buses.get(app.view.id);
      if (b) go({ kind: 'route', id: b.routeId });
    }
    else if (e.key === '0') ctl?.overview();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="map" bind:this={container}></div>

{#if app.net}
  <Panel>
    {#key app.view.kind === 'home' ? 'home' : app.view.kind === 'plan' ? 'plan' : `${app.view.kind}:${app.view.id}`}
      <div class="viewwrap" in:fly={{ y: reduced ? 0 : 8, duration: reduced ? 1 : 200, easing: cubicOut }}>
        {#if app.view.kind === 'home'}
          <HomeView />
        {:else if app.view.kind === 'route'}
          <RouteView id={app.view.id} />
        {:else if app.view.kind === 'bus'}
          <BusView id={app.view.id} />
        {:else if app.view.kind === 'station'}
          <StationView id={app.view.id} kind="station" />
        {:else if app.view.kind === 'stop'}
          <StationView id={app.view.id} kind="stop" />
        {:else if app.view.kind === 'plan'}
          <PlanView id={app.view.id} />
        {/if}
      </div>
    {/key}
  </Panel>
  <MapControls {bearing} />
  <LayersPanel />
  <MapMenu />
  {#if app.searchOpen}<Search />{/if}
{:else}
  <div class="boot" class:failed>
    <span class="label">{failed ? 'No se pudo cargar la red' : 'Cargando la red'}</span>
    {#if failed}<span class="faint small">{failed}</span>{:else}<span class="bar"><span></span></span>{/if}
  </div>
{/if}

<style>
  .map { position: absolute; inset: 0; background: var(--bg-0); }
  .viewwrap { min-height: 100%; }
  .boot {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    display: grid;
    gap: var(--sp-3);
    justify-items: center;
    z-index: 20;
  }
  .bar { width: 160px; height: 1px; background: var(--line-2); position: relative; overflow: hidden; }
  .bar span { position: absolute; top: 0; bottom: 0; width: 40%; background: var(--fg-0); animation: load 1.1s var(--ease-out) infinite; }
  .small { font-size: var(--fs-small); }
  @keyframes load { from { left: -40%; } to { left: 100%; } }
</style>

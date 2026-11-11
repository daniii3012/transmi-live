<script lang="ts">
  import Back from './Back.svelte';
  import { backup } from '../live/backup.svelte';
  import { app } from '../app/store.svelte';
  import { ctl } from '../app/instance';
  import { fmtHMS } from '../domain/time';

  /**
   * Configuración: el movimiento de los buses entre lecturas (decisión 013) y el respaldo por ruta: cada persona pone sus propias credenciales del
   * servicio por ruta (appid y UUID del dispositivo, las mismas de la app móvil). Se guardan solo en
   * este navegador; el Worker las reenvía en cada consulta y no las guarda.
   */
  let appid = $state(backup.creds?.appid ?? '');
  let uuid = $state(backup.creds?.uuid ?? '');
  let show = $state(false);
  let saved = $state(false);
  const dirty = $derived(appid.trim() !== (backup.creds?.appid ?? '') || uuid.trim() !== (backup.creds?.uuid ?? ''));
  const valid = $derived(/^[\x21-\x7e]{4,200}$/.test(appid.trim()) && (!uuid.trim() || /^[\x21-\x7e]{4,200}$/.test(uuid.trim())));

  function save() {
    if (!valid) return;
    backup.save({ appid, uuid });
    saved = true;
    setTimeout(() => (saved = false), 2500);
  }
  function clear() {
    backup.clear();
    appid = '';
    uuid = '';
  }

  const estado = $derived.by(() => {
    switch (backup.status) {
      case 'off': return 'Respaldo desactivado: sin credenciales.';
      case 'ready': return 'Credenciales guardadas. El respaldo se usa cuando el alimentador se detiene o no trae buses de la ruta abierta.';
      case 'active': return `Respaldo en uso: ${backup.codes.join(', ')}${backup.at ? ` · ${fmtHMS(backup.at).slice(0, 5)}` : ''}.`;
      case 'rejected': return 'El servicio rechazó las credenciales. Respaldo detenido hasta cambiarlas.';
      case 'unavailable': return 'Servicio por ruta no disponible por ahora; se reintenta solo.';
    }
  });
</script>

<div class="view">
  <Back />
  <header>
    <div class="label">Ajustes</div>
    <h1>Configuración</h1>
  </header>

  <section>
    <div class="label">Movimiento de los buses</div>
    <label class="check">
      <input type="checkbox" checked={app.motion === 'continuo'} onchange={(e) => ctl?.setMotion(e.currentTarget.checked ? 'continuo' : 'directo')} aria-describedby="movimiento-nota" />
      <span class="small">Movimiento continuo entre lecturas</span>
    </label>
    <p id="movimiento-nota" class="small faint">
      {#if app.motion === 'continuo'}
        Activado: cada bus avanza sin pausas por su recorrido entre una lectura y la siguiente, unos 40 s
        detrás del dato más reciente.
      {:else}
        Desactivado: con cada lectura (cada ~20 s), el bus va en un instante a su última posición conocida
        y espera ahí la siguiente.
      {/if}
      Las llegadas y la velocidad no cambian.
    </p>
  </section>

  <section>
    <div class="label">Al dejar la página quieta</div>
    <div class="seg" role="radiogroup" aria-label="Al dejar la página quieta">
      {#each [[0, 'Nunca'], [30_000, '30 s'], [120_000, '2 min'], [300_000, '5 min']] as [ms, name] (ms)}
        <button role="radio" aria-checked={app.idleMs === ms} class:on={app.idleMs === ms} onclick={() => ctl?.setIdle(ms as number)}>{name}</button>
      {/each}
    </div>
    <p class="small faint">
      Sin tocar nada durante ese tiempo, arranca el recorrido por las troncales; con una estación o un
      paradero abiertos, la cámara gira despacio a su alrededor. Cualquier toque vuelve a donde estaba.
    </p>
  </section>

  <section>
    <div class="label">Respaldo por ruta</div>
    <p class="small">
      Si el alimentador en vivo deja de actualizarse, o no trae ningún bus de la ruta que se mira (trae
      solo parte de la flota), las posiciones de la ruta abierta, del bus seguido o de los tramos del
      viaje se consultan al servicio por ruta con estas credenciales: el appid y el UUID del
      dispositivo, los mismos de la app móvil. Los buses que solo trae el respaldo salen del mapa
      3 minutos después de dejar de mirar su ruta.
    </p>
    <p class="small faint">
      Se guardan solo en este navegador. El servidor intermedio las reenvía al servicio en cada consulta
      y no las guarda. Cada consulta usa la cuota de estas credenciales. Sin credenciales, el respaldo
      queda desactivado.
    </p>

    <form onsubmit={(e) => { e.preventDefault(); save(); }}>
      <label>
        <span class="label">appid</span>
        <input type={show ? 'text' : 'password'} bind:value={appid} autocomplete="off" spellcheck="false" autocapitalize="off" aria-describedby="estado-respaldo" />
      </label>
      <label>
        <span class="label">UUID del dispositivo <span class="faint">(opcional)</span></span>
        <input type={show ? 'text' : 'password'} bind:value={uuid} autocomplete="off" spellcheck="false" autocapitalize="off" />
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={show} />
        <span class="small">Mostrar</span>
      </label>
      <div class="row">
        <button class="btn primary" type="submit" disabled={!valid || !dirty}>{saved ? 'Guardado' : 'Guardar'}</button>
        {#if backup.creds}
          <button class="btn" type="button" onclick={clear}>Borrar credenciales</button>
        {/if}
      </div>
    </form>

    <p id="estado-respaldo" class="small state {backup.status}" role="status" aria-live="polite">{estado}</p>
  </section>
</div>

<style>
  .view { padding: var(--sp-4); display: grid; gap: var(--sp-5); }
  h1 { margin: 2px 0 0; font-size: var(--fs-title); font-weight: 500; letter-spacing: -0.01em; }
  section { display: grid; gap: var(--sp-3); }
  .small { font-size: var(--fs-small); margin: 0; line-height: 1.45; color: var(--fg-1); }
  .faint { color: var(--fg-2); }
  form { display: grid; gap: var(--sp-3); }
  label { display: grid; gap: var(--sp-1); }
  input:not([type='checkbox']) {
    height: 40px;
    padding: 0 var(--sp-3);
    background: var(--bg-2);
    border: 1px solid var(--line-2);
    color: var(--fg-0);
    font-family: var(--font-mono);
    font-size: 16px;
    outline: none;
  }
  input:not([type='checkbox']):focus-visible { border-color: var(--fg-2); }
  .check { display: flex; align-items: center; gap: var(--sp-2); }
  .seg { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--line-2); }
  .seg button { height: 32px; font-size: var(--fs-small); color: var(--fg-1); }
  .seg button + button { border-left: 1px solid var(--line-2); }
  .seg button:hover { color: var(--fg-0); }
  .seg button.on { background: var(--fg-0); color: var(--bg-1); }
  .row { display: flex; gap: var(--sp-2); }
  .btn { height: 36px; padding: 0 var(--sp-4); border: 1px solid var(--line-2); font-size: var(--fs-small); color: var(--fg-1); }
  .btn:hover:not(:disabled) { color: var(--fg-0); background: var(--bg-2); }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .btn.primary { background: var(--fg-0); color: var(--bg-0); border-color: var(--fg-0); }
  .btn.primary:hover:not(:disabled) { background: var(--fg-1); color: var(--bg-0); }
  .state { padding-top: var(--sp-2); border-top: 1px solid var(--line-1); }
  .state.active { color: var(--fg-0); }
  .state.rejected, .state.unavailable { color: var(--warn); }
</style>

<script lang="ts">
  import { ctl } from '../app/instance';
  import { go } from '../app/router';
  // A la vista anterior de esta sesión (pila del controlador); si no hay, al inicio.
  function back() {
    if (ctl) ctl.back(); else go({ kind: 'home' });
  }
</script>

<button class="back" onclick={back} aria-label="Volver">
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
  <span class="label">Volver</span>
</button>

<style>
  .back { display: inline-flex; align-items: center; gap: 6px; height: 24px; color: var(--fg-2); margin: -4px 0 -8px; justify-self: start; }
  .back:hover, .back:hover .label { color: var(--fg-0); }
</style>

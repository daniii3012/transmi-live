<script lang="ts">
  import { ctl } from '../app/instance';
  import { go } from '../app/router';
  // Volver: a la vista anterior de esta sesión (pila del controlador); si no hay, al inicio.
  // Cerrar: quita toda la selección y va al inicio de una vez, sin recorrer lo navegado.
  function back() {
    if (ctl) ctl.back(); else go({ kind: 'home' });
  }
  function close() {
    if (ctl) ctl.close(); else go({ kind: 'home' });
  }
</script>

<div class="nav">
  <button class="back" onclick={back} aria-label="Volver">
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
    <span class="label">Volver</span>
  </button>
  <button class="close" onclick={close} aria-label="Cerrar y volver al inicio" title="Cerrar">
    <span class="label">Cerrar</span>
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2 L10 10 M10 2 L2 10" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
  </button>
</div>

<style>
  .nav { display: flex; justify-content: space-between; align-items: center; margin: -4px 0 -8px; }
  .back, .close { display: inline-flex; align-items: center; gap: 6px; height: 28px; color: var(--fg-2); }
  .close { padding-left: var(--sp-3); }
  .back:hover, .back:hover .label, .close:hover, .close:hover .label { color: var(--fg-0); }
</style>

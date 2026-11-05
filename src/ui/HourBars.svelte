<script lang="ts">
  /**
   * Salidas por hora del día de servicio (gráfico de una serie): barras finas con 2 px entre ellas,
   * ejes discretos, la hora actual en el color de la ruta. Sin leyenda (el título la nombra); cada
   * barra dice su valor al pasar o tocar, y una tabla oculta lo da a los lectores de pantalla.
   */
  let { counts, color, now }: { counts: number[]; color: string; now: number } = $props();
  // Las horas del GTFS pasan de 24 de madrugada; se muestra el tramo con servicio.
  const span = $derived.by(() => {
    let a = counts.findIndex((n) => n > 0), b = counts.length - 1;
    while (b > 0 && !counts[b]) b--;
    return a < 0 ? null : { a, b };
  });
  const max = $derived(Math.max(1, ...counts));
  let hover = $state<number | null>(null);
  const label = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
</script>

{#if span}
  <div class="chart" role="img" aria-label="Salidas por hora, de {label(span.a)} a {label(span.b)}; la mayor, {max} en una hora">
    <div class="bars" style:--n={span.b - span.a + 1}>
      {#each counts.slice(span.a, span.b + 1) as n, i (i)}
        {@const h = span.a + i}
        <button class="bar" class:now={h === now} style:--k={n / max} style:--c={color}
          onpointerenter={() => (hover = h)} onpointerleave={() => (hover = null)} onfocus={() => (hover = h)} onblur={() => (hover = null)}
          aria-label="{label(h)}: {n} salidas"></button>
      {/each}
    </div>
    <div class="axis faint num">
      <span>{label(span.a)}</span>
      {#if hover !== null}<span class="tip">{label(hover)} · {counts[hover]} salidas</span>{/if}
      <span>{label(span.b)}</span>
    </div>
  </div>
  <table class="sr">
    <caption>Salidas por hora</caption>
    <tbody>{#each counts.slice(span.a, span.b + 1) as n, i (i)}<tr><th>{label(span.a + i)}</th><td>{n}</td></tr>{/each}</tbody>
  </table>
{/if}

<style>
  .chart { display: grid; gap: var(--sp-1); }
  .bars { display: grid; grid-template-columns: repeat(var(--n), 1fr); gap: 2px; height: 56px; align-items: end; border-bottom: 1px solid var(--line-2); }
  .bar { height: calc(var(--k) * 100%); min-height: 1px; background: var(--fg-3); padding: 0; }
  .bar.now { background: var(--c); }
  .bar:hover, .bar:focus-visible { background: var(--fg-1); outline: none; }
  .bar.now:hover { background: var(--c); }
  .axis { display: flex; justify-content: space-between; font-size: var(--fs-label); letter-spacing: 0.04em; }
  .tip { color: var(--fg-0); }
</style>

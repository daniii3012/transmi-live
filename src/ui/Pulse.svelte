<script lang="ts">
  import { app } from '../app/store.svelte';
  import { fmtNum, fmtHM } from '../domain/time';
  // Pulso: buses en vía desde que se abrió la página. Línea fina, sin relleno ni ejes.
  const W = 348, H = 36;
  const pts = $derived(app.pulse);
  const path = $derived.by(() => {
    if (pts.length < 2) return '';
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { lo = Math.min(lo, p.n); hi = Math.max(hi, p.n); }
    const span = Math.max(1, hi - lo), dt = Math.max(1, t1 - t0);
    return pts.map((p, i) => `${i ? 'L' : 'M'}${(((p.t - t0) / dt) * (W - 4) + 2).toFixed(1)} ${(H - 3 - ((p.n - lo) / span) * (H - 6)).toFixed(1)}`).join(' ');
  });
  const last = $derived(pts[pts.length - 1]);
  const first = $derived(pts[0]);
  const delta = $derived(last && first ? last.n - first.n : 0);
</script>

{#if pts.length >= 3}
  <section class="pulse">
    <div class="head">
      <span class="label">Pulso · desde {fmtHM(first.t * 1000)}</span>
      <span class="label num" class:up={delta > 0}>{delta > 0 ? '+' : ''}{fmtNum(delta)}</span>
    </div>
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-label="Buses en vía en el tiempo">
      <path d={path} />
    </svg>
  </section>
{/if}

<style>
  .pulse { display: grid; gap: 6px; }
  .head { display: flex; justify-content: space-between; }
  .up { color: var(--fg-0); }
  svg { width: 100%; height: 36px; display: block; border-bottom: 1px solid var(--line-1); }
  path { fill: none; stroke: var(--fg-1); stroke-width: 1.25; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
</style>

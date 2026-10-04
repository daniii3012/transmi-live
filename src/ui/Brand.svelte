<script lang="ts">
  let { onclick }: { onclick?: () => void } = $props();
</script>

<button class="brand" {onclick} aria-label="TransMi Live: vista general">
  <svg width="18" height="18" viewBox="0 0 64 64" aria-hidden="true">
    <path d="M10 46 L32 12 L54 46" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="square" />
    <rect x="27" y="46" width="10" height="10" fill="#e5483b" />
  </svg>
  <span class="word">TRANSMI<span class="slash">/</span>LIVE</span>
</button>

<style>
  .brand { display: inline-flex; align-items: center; gap: 10px; height: 28px; color: var(--fg-0); }
  .word { font-family: var(--font-mono); font-weight: 600; font-size: 13px; letter-spacing: 0.16em; }
  .slash { color: var(--fg-3); margin: 0 1px; }
</style>

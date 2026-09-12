import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  base: './',
  plugins: [svelte()],
  server: { port: 5173, host: true },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1200 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});

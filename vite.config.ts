import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.ico', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'],
      manifest: {
        name: 'TransMi Live',
        short_name: 'TransMi Live',
        description: 'TransMilenio en tiempo real sobre el mapa de Bogotá (no oficial).',
        lang: 'es-CO',
        dir: 'ltr',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#07090b',
        theme_color: '#07090b',
        categories: ['travel', 'navigation', 'utilities'],
        // Accesos directos al mantener presionado el ícono (Android, escritorio; iOS no los muestra).
        shortcuts: [
          { name: 'Planear un viaje', short_name: 'Planear', url: './#/planear', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Estaciones y paraderos cercanos', short_name: 'Cercanos', url: './?cerca=1#/', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
        ],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Armazón y fuentes en la precarga; los datos de la red y las teselas, en caché de uso.
        globPatterns: ['**/*.{js,css,html,woff2,svg,png,ico}'],
        // Subconjuntos de letra que el español no usa: el navegador los pide solo si hacen falta.
        globIgnores: ['data/**', '**/*-{cyrillic,cyrillic-ext,greek,vietnamese,symbols2}-*'],
        navigateFallback: 'index.html',
        // Los íconos, imágenes, el manifiesto y el sitemap nunca reciben la página: si el navegador los
        // pide como navegación (iOS al tomar el ícono de inicio), van a la red o a la precarga.
        navigateFallbackDenylist: [/\/icons\//, /\.(?:png|jpg|ico|svg|webmanifest|xml|json)$/],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // Activación inmediata (R10.0): con `injectRegister: false` el complemento no la enciende aunque
        // `registerType` sea `autoUpdate`, y la versión nueva quedaba en espera hasta cerrar todas las
        // pestañas y la app instalada. Así se instala, toma la página y `registerSW` recarga.
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/data/') && url.pathname.endsWith('.json'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'red', expiration: { maxEntries: 20 } },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'tiles.openfreemap.org' && /\.pbf$/.test(url.pathname) && !url.pathname.startsWith('/fonts'),
            handler: 'CacheFirst',
            options: { cacheName: 'teselas', expiration: { maxEntries: 2500, maxAgeSeconds: 7 * 24 * 3600 }, cacheableResponse: { statuses: [0, 200] } },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'tiles.openfreemap.org' && (url.pathname.startsWith('/fonts') || url.pathname === '/planet'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'mapa-base', expiration: { maxEntries: 200, maxAgeSeconds: 30 * 24 * 3600 }, cacheableResponse: { statuses: [0, 200] } },
          },
          // El API en vivo nunca pasa por la caché: un dato viejo presentado como actual es peor que ninguno.
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 5173, host: true },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1200 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});

import './styles/base.css';
import { mount } from 'svelte';
import App from './App.svelte';

const app = mount(App, { target: document.getElementById('app')! });

// Service worker solo en la versión compilada: en desarrollo estorba más de lo que ayuda.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // Actualización automática: la app instalada puede quedar abierta días; se busca versión nueva al
  // volver a ella y cada hora (con `autoUpdate`, al instalarse la nueva se recarga sola).
  import('virtual:pwa-register').then(({ registerSW }) =>
    registerSW({
      immediate: true,
      onRegisteredSW(_url, reg) {
        if (!reg) return;
        const check = () => { if (!document.hidden && navigator.onLine) void reg.update(); };
        setInterval(check, 60 * 60 * 1000);
        document.addEventListener('visibilitychange', check);
      },
    }),
  );
}

export default app;

import type { Controller } from './controller';

/** El controlador activo, para que los componentes den órdenes al mapa. */
export let ctl: Controller | null = null;
export const setController = (c: Controller | null) => (ctl = c);

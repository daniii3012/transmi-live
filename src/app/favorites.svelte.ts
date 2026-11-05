/** Favoritos en el dispositivo: rutas (por código y sistema, los dos sentidos) y lugares. */
const KEY = 'transmi-live:favoritos:v1';

export interface Favorite { kind: 'route' | 'station' | 'stop'; id: string; added: number }

function load(): Favorite[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}

class Favorites {
  list = $state<Favorite[]>(typeof localStorage !== 'undefined' ? load() : []);
  has(kind: Favorite['kind'], id: string) { return this.list.some((f) => f.kind === kind && f.id === id); }
  toggle(kind: Favorite['kind'], id: string) {
    this.list = this.has(kind, id) ? this.list.filter((f) => !(f.kind === kind && f.id === id)) : [...this.list, { kind, id, added: Date.now() }];
    try { localStorage.setItem(KEY, JSON.stringify(this.list)); } catch { /* modo privado */ }
  }
}

export const favorites = new Favorites();

/** Favoritos en el dispositivo: rutas (por código y sistema, los dos sentidos) y lugares. */
const KEY = 'transmi-live:favoritos:v1';

export interface Favorite { kind: 'route' | 'station' | 'stop'; id: string; added: number }

function load(): Favorite[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}

class Favorites {
  list = $state<Favorite[]>(typeof localStorage !== 'undefined' ? load() : []);
  has(kind: Favorite['kind'], id: string) { return this.list.some((f) => f.kind === kind && f.id === id); }
  /** Rutas guardadas cuyo id cambió en el paquete nuevo: pasan al id vigente (alias). */
  migrate(resolve: (id: string) => string | null) {
    let changed = false;
    const list = this.list.map((f) => {
      if (f.kind !== 'route') return f;
      const r = resolve(f.id);
      if (r && r !== f.id) { changed = true; return { ...f, id: r }; }
      return f;
    });
    if (!changed) return;
    this.list = list;
    try { localStorage.setItem(KEY, JSON.stringify(this.list)); } catch { /* modo privado */ }
  }
  toggle(kind: Favorite['kind'], id: string) {
    this.list = this.has(kind, id) ? this.list.filter((f) => !(f.kind === kind && f.id === id)) : [...this.list, { kind, id, added: Date.now() }];
    try { localStorage.setItem(KEY, JSON.stringify(this.list)); } catch { /* modo privado */ }
  }
}

export const favorites = new Favorites();

import { describe, it, expect } from 'vitest';
import { FILTER_GROUPS, FILTER_KEYS, classOf, groupState, migrateHidden, solo, toggle } from '../src/domain/filter';

const troncal = FILTER_GROUPS.find((g) => g.key === 'troncal')!;
const zonal = FILTER_GROUPS.find((g) => g.key === 'zonal')!;

describe('filtro de sistemas (R10.2)', () => {
  it('cuatro grupos en el orden pedido: Troncal (con Dual), Zonal (tres clases), Alimentador, TransMiCable', () => {
    expect(FILTER_GROUPS.map((g) => g.key)).toEqual(['troncal', 'zonal', 'alimentador', 'cable']);
    expect(troncal.classes.map((c) => c.key)).toEqual(['troncal', 'dual']);
    expect(zonal.classes.map((c) => c.name)).toEqual(['Urbano', 'Complementario', 'Especial']);
  });

  it('clase de una ruta: el zonal por su clase del GTFS; sin clase, urbano', () => {
    expect(classOf('zonal', 'especial')).toBe('zonal-especial');
    expect(classOf('zonal', 'complementario')).toBe('zonal-complementario');
    expect(classOf('zonal')).toBe('zonal-urbano');
    expect(classOf('dual')).toBe('dual');
    expect(classOf(undefined)).toBeUndefined();
  });

  it('lo guardado antes con «zonal» entero pasa a sus tres clases; lo desconocido sale; todo oculto = nada oculto', () => {
    expect(migrateHidden(['zonal', 'cable', 'otro'])).toEqual(['zonal-urbano', 'zonal-complementario', 'zonal-especial', 'cable']);
    expect(migrateHidden(undefined)).toEqual([]);
    expect(migrateHidden(['troncal', 'dual', 'alimentador', 'zonal', 'cable'])).toEqual([]);
  });

  it('grupo: se oculta entero (también si estaba en parte) y vuelve entero', () => {
    const part = toggle([], ['dual'])!;
    expect(groupState(part, troncal)).toBe('part');
    const off = toggle(part, ['troncal', 'dual'])!;
    expect(groupState(off, troncal)).toBe('off');
    expect(groupState(toggle(off, ['troncal', 'dual'])!, troncal)).toBe('on');
  });

  it('no deja el mapa vacío: lo último visible no se apaga', () => {
    const allButCable = FILTER_KEYS.filter((k) => k !== 'cable');
    expect(toggle(allButCable, ['cable'])).toBeNull();
  });

  it('«solo esto» deja visible una clase o un grupo; repetido, vuelve todo', () => {
    const h = solo([], ['zonal-especial']);
    expect(FILTER_KEYS.filter((k) => !h.includes(k))).toEqual(['zonal-especial']);
    expect(solo(h, ['zonal-especial'])).toEqual([]);
    const g = solo([], ['troncal', 'dual']);
    expect(FILTER_KEYS.filter((k) => !g.includes(k))).toEqual(['troncal', 'dual']);
  });
});

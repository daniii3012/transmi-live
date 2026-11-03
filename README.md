# TransMi Live

Todo TransMilenio en tiempo real sobre el mapa de Bogotá: troncal, duales, alimentadores, zonal y
TransMiCable, con sus rutas, estaciones, vagones y llegadas estimadas. Web instalable (PWA).

- Buses moviéndose por su vía, con el color de su ruta.
- Fichas de ruta (con diagrama lineal y buses en vivo), de bus (seguimiento y próximas paradas) y de
  estación (próximas llegadas y en qué vagón para cada ruta).
- Buscador de rutas, estaciones, paraderos y buses; filtro por sistema.

## Desarrollo

```sh
npm install
python3 tools/build_data.py RUTA/AL/PAQUETE_GTFS.zip   # datos de la red en public/data (no se versionan)
npm run dev
```

La página lee las posiciones de un intermediario propio; su dirección se da en compilación
(`VITE_API_BASE`) o en la URL (`?api=`). Pruebas: `npm test` (lógica) y
`node tests/visual/shot.mjs <url> <nombre>` (capturas de escritorio y móvil).

Proyecto personal e independiente; no está afiliado a TRANSMILENIO S.A. Fuentes y referencias en
[`FUENTES.md`](FUENTES.md).

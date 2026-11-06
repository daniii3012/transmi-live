# TransMi Live

TransMilenio en tiempo real sobre el mapa de Bogotá (no oficial): troncal, duales, alimentadores, zonal
y TransMiCable, con sus rutas, estaciones, vagones y llegadas estimadas. Web instalable (PWA).

**En línea:** <https://daniii3012.github.io/transmi-live/>

- Buses moviéndose por su carril, con el color de su ruta; en 3D, con volumen (articulados y
  biarticulados que se doblan en las curvas) y estaciones con su planta real.
- Fichas de ruta (con diagrama lineal y buses en vivo), de bus (seguimiento y próximas paradas) y de
  estación (próximas llegadas y en qué vagón para cada ruta).
- Planificador de viajes con alternativas, a cualquier hora y día.
- Buscador de rutas, estaciones, paraderos y buses; filtro por sistema; temas claro y oscuro.

## Desarrollo

```sh
npm install
python3 tools/build_data.py RUTA/AL/PAQUETE_GTFS.zip   # datos de la red en public/data (no se versionan)
npm run dev
```

La página lee las posiciones de un intermediario propio; su dirección se da en compilación
(`VITE_API_BASE`) o en la URL (`?api=`). Pruebas: `npm test` (lógica), `npm run test:datos`
(geometría) y `node tests/visual/shot.mjs <url> <nombre>` (capturas de escritorio y móvil).

Proyecto personal e independiente; no está afiliado a TRANSMILENIO S.A. Fuentes y referencias en
[`FUENTES.md`](FUENTES.md).

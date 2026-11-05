# Fuentes y referencias

## Mapa y tecnología

- **OpenStreetMap** — calles, manzanas, edificios y nombres. © colaboradores de OpenStreetMap, ODbL.
  <https://www.openstreetmap.org/copyright>
- **OpenStreetMap, calzada de la troncal** — ejes de la calzada exclusiva por sentido, edificios y
  plataformas de las estaciones, puentes y deprimidos (`data/curated/busway.json`, derivado de OSM y
  bajo ODbL; importado de los datos curados del simulador con `tools/import_busway.py`).
- **Ejes de los corredores troncales** — una línea por corredor sobre el separador, curados y
  verificados contra el servicio vigente (`data/curated/corridors.json`).
- **Letra de troncal por estación** — donde los códigos de vagón no la traen (casi toda la Caracas
  central): lista curada a partir del mapa del sistema y del simulador (`data/curated/station_corridors.json`).
- **OpenMapTiles** — esquema de las teselas vectoriales. <https://openmaptiles.org>
- **OpenFreeMap** — teselas y tipografías del mapa base, sin clave. <https://openfreemap.org>
- **MapLibre GL JS** — motor del mapa. <https://maplibre.org>
- **Geist y Geist Mono** — tipografías de la interfaz (Vercel, OFL). <https://vercel.com/font>
- **Svelte, Vite, Workbox** — interfaz, compilación y service worker.

## Referencias de diseño y experiencia

- **Croma · TransMilenio en vivo** — conteo grande, filtro por sistema con barras, estelas.
  <https://transmi.usecroma.com>
- **«Información de TransMilenio en tiempo real, vía API y MCP»**, Cristian Correa — animaciones al
  seleccionar un bus y una ruta. <https://youtube.com/shorts/0sfiu836z1k>
- **Subway Builder** — ciudad apagada con líneas de color e insignias de ruta.
  <https://www.subwaybuilder.com>
- **Mini Tokyo 3D** — movimiento fluido de toda la flota y cámara que acompaña. <https://minitokyo3d.com>
- **Watch Dogs** (mapa del juego) y **Cities: Skylines** (vista de transporte público) — la ciudad
  como fondo neutro y la red en primer plano.

- **Apple Human Interface Guidelines** (Motion, Maps, Color, Accessibility) y **Material Design 3**
  (Motion) — criterios de movimiento, selección, contraste y temas.
  <https://developer.apple.com/design/human-interface-guidelines> · <https://m3.material.io>

## Referencias para los buses en 3D

Proporciones de las fichas de fabricante: ancho 2,55 m, alto ≈ 3,2 m, articulado de 18 m y
biarticulado de 27 m.

- **Marcopolo Gran Viale BRT** y **Busscar** — carrocerías de la troncal. <https://www.marcopolo.com.br>
- **Volvo B340M y Gran Artic 300**, **Scania K**, **Mercedes-Benz O500** — chasis articulados y
  biarticulados. <https://www.volvobuses.com>
- **BYD** — buses eléctricos de la flota zonal y troncal (modelo pendiente). <https://www.byd.com>

## Trabajo previo

- **transmi-sim** — simulador de la troncal del mismo autor: reglas de ubicación de lecturas sobre el
  recorrido (medidas sobre un día de lecturas troncales), clasificación de flota y geometría de
  estaciones que se retomarán en la vista 3D. <https://github.com/daniii3012/transmi-sim>

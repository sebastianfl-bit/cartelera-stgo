# Cartelera Santiago

PWA estática que muestra la cartelera de cine de Santiago sobre un **eje horario
compartido**: todas las películas se dibujan sobre la misma línea de 11:00 a 02:00,
así se escanea verticalmente y se ve al tiro qué alcanzas a ver.

Sin backend. Un GitHub Action scrapea, commitea un JSON, y la página lo lee.

## Estado

| Cine | Estado | Cómo salen los datos |
|---|---|---|
| Cinemark (9 sedes) | ✅ | schema.org embebido en el flight de Next App Router |
| Cineplanet | ⬜ | por hacer |
| Cinehoyts | ⬜ | por hacer |
| Normandie | ⬜ | HTML plano, cheerio |
| Cineteca Nacional | ⬜ | HTML plano, cheerio |
| Cine UC | ⬜ | HTML plano, cheerio |

## Correr local

```bash
npm install
npm run scrape          # escribe data/cartelera.json
python3 -m http.server 8000
```

## Publicar

Settings → Pages → Deploy from a branch → `main` / root.
El Action corre 2× al día y commitea solo si el JSON cambió.

## Notas de implementación (leer antes de tocar el scraper)

**La fecha de Cinemark viene corrupta.** Serializan `2026-07-12T15:00:00.000Z-05:00`:
tiene `Z` *y* offset a la vez, y el `-05:00` ni siquiera es Chile (somos `-04:00` en
invierno). El literal `15:00` es la hora de pared local. `fechaCinemark()` bota el
sufijo y estampa el offset chileno real. **Si interpretas el `Z`, toda la cartelera
se corre 4 horas.**

**Cinemark solo publica funciones futuras.** El HTML va perdiendo las funciones ya
pasadas a medida que avanza el día. Por eso el cron corre temprano (07:00 y 12:00
hora Chile): un scrape nocturno dejaría el día casi vacío.

**Cinemark no publica idioma ni clasificación** en su schema.org. Ambos quedan como
`S/I` y el frontend los oculta. Si algún día importan, hay que sacarlos del detalle
de cada película.

**Trasnoche.** Una función de las 00:30 del sábado pertenece a la cartelera del
**viernes**, no del sábado. Cada función lleva su campo `dia` (≠ día calendario) y
el eje llega hasta las 26:00.

**Una sede sin funciones no es un error.** Devuelve `[]` y el build sigue. Solo
revienta si desaparece el flight de Next, que significaría que el sitio cambió y
el parser quedó obsoleto.

## Agregar un cine nuevo

1. Agrégalo al array `CINES` en `scripts/scrape.mjs`.
2. Si es una cadena nueva, escribe su adaptador: `async (cine) => Funcion[]`.
3. El resto (fusión de títulos entre cadenas, multi-día, normalización) ya está resuelto.

Shape de `Funcion`:

```js
{
  cineId, titulo, duracion, clasificacion, genero, poster,
  sala, formato, atributos, idioma,
  inicio,   // ISO 8601 CON offset de Chile. Nunca UTC a ciegas.
  url
}
```

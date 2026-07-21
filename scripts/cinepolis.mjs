/**
 * scripts/cinepolis.mjs — adaptador de Cinépolis / Cinehoyts
 *
 * FUENTE: vamosalcine.tri.cl (agregador de terceros), NO la API de Cinépolis.
 *
 * Por qué: la API oficial de Cinépolis está tras Cloudflare (bloqueo por TLS) y
 * además ignora el filtro de cine, devolviendo siempre la sede de la URL semilla.
 * Peleamos mucho con Playwright + Xvfb y quedó frágil. Vamosalcine ya scrapea
 * Cinépolis y publica la cartelera como HTML estático (Astro), con la sede real
 * en la URL y JSON embebido por función. Un simple fetch + cheerio lo resuelve.
 *
 * Trade-off: dependemos de que vamosalcine mantenga sus datos al día y no cambie
 * su HTML. Aceptable para Cinépolis (que de otro modo no tendríamos). Para las
 * demás cadenas seguimos usando sus fuentes directas.
 *
 * Estructura de vamosalcine.tri.cl/cine/<slug>:
 *   .movie-block
 *     .movie-title a         → título + /pelicula/<slug>
 *     .format-group
 *       .group-label         → "2D — SUB"
 *       .time-pill[data-time] → horario, con JSON {time,language,format} en x-show
 *
 * OJO: el HTML muestra la cartelera del DÍA por defecto; el filtro de fecha es
 * client-side (Alpine). Para varios días hay que pedir /cine/<slug>?date=YYYY-MM-DD.
 */

import * as cheerio from "cheerio";

const BASE = "https://vamosalcine.tri.cl";

// Sedes de Santiago en vamosalcine → id interno + comuna real.
// (slugs tomados del índice /ciudad/santiago-*). Ampliar acá si quieres más zonas.
const SEDES = [
  { slug: "cinepolis-parque-arauco",                 nombre: "Cinépolis Parque Arauco",        comuna: "Las Condes" },
  { slug: "cinepolis-mall-plaza-los-dominicos",      nombre: "Cinépolis Mall Plaza Los Dominicos", comuna: "Las Condes" },
  { slug: "cinepolis-los-dominicos",                 nombre: "Cinépolis Los Dominicos",        comuna: "Las Condes" },
  { slug: "cinepolis-la-reina",                      nombre: "Cinépolis La Reina",             comuna: "La Reina" },
  { slug: "cinepolis-casa-costanera",                nombre: "Cinépolis Casa Costanera",       comuna: "Vitacura" },
  { slug: "cinepolis-mallplaza-egana",               nombre: "Cinépolis Plaza Egaña",          comuna: "La Reina" },
  { slug: "cinepolis-paseo-los-trapenses",           nombre: "Cinépolis Paseo Los Trapenses",  comuna: "Lo Barnechea" },
];

const DIAS_A_PEDIR = 4;   // hoy + 3

/** Devuelve { cines, funciones } leyendo Cinépolis desde vamosalcine. */
export async function scrapeCinepolis({ limpiarTitulo }) {
  const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
  const hoy = fechaChile();
  const dias = [];
  for (let i = 0; i < DIAS_A_PEDIR; i++) dias.push(sumarDias(hoy, i));

  const funciones = [];
  const cinesOk = new Set();

  for (const sede of SEDES) {
    let algo = false;
    for (const dia of dias) {
      const url = `${BASE}/cine/${sede.slug}?date=${dia}`;
      let html;
      try {
        const r = await fetch(url, { headers: { "User-Agent": UA } });
        if (!r.ok) continue;
        html = await r.text();
      } catch { continue; }

      const fs = parsearCine(html, sede, dia, limpiarTitulo);
      if (fs.length) { funciones.push(...fs); algo = true; }
    }
    if (algo) cinesOk.add(sede.slug);
    if (process.env.DEBUG_CINEPOLIS) {
      const n = funciones.filter(f => f.cineId === `cinepolis-${sede.slug}`).length;
      console.error(`   (debug) ${sede.nombre}: ${n} funciones`);
    }
  }

  const cines = SEDES.filter(s => cinesOk.has(s.slug)).map(s => ({
    id: `cinepolis-${s.slug}`, nombre: s.nombre, cadena: "Cinépolis",
    tipo: "cadena", comuna: s.comuna,
  }));
  return { cines, funciones };
}

function parsearCine(html, sede, dia, limpiarTitulo) {
  const $ = cheerio.load(html);
  const out = [];

  $(".movie-block").each((_, block) => {
    const titulo = $(block).find(".movie-title").first().text().trim();
    if (!titulo) return;
    const poster = $(block).find("img.movie-poster").attr("src") || null;

    $(block).find(".time-pill").each((__, pill) => {
      const hora = ($(pill).attr("data-time") || "").match(/(\d{1,2}):(\d{2})/);
      if (!hora) return;

      // El x-show trae {"time","language","format"} de esta función.
      let idioma = "S/I", formato = "2D";
      const xshow = $(pill).attr("x-show") || "";
      const dec = xshow.replace(/&#34;|&quot;/g, '"');
      const mLang = dec.match(/"language"\s*:\s*"([^"]+)"/);
      const mFmt = dec.match(/"format"\s*:\s*"([^"]+)"/);
      if (mLang) idioma = normIdiomaVac(mLang[1]);
      if (mFmt) formato = mFmt[1].toUpperCase().includes("3D") ? "3D" : "2D";

      out.push({
        cineId: `cinepolis-${sede.slug}`,
        titulo: limpiarTitulo(titulo),
        duracion: 0,
        clasificacion: "S/I",
        genero: null,
        poster,
        sala: null,
        formato,
        atributos: [],
        idioma,
        inicio: `${dia}T${hora[1].padStart(2, "0")}:${hora[2]}:00${offsetChile(dia)}`,
        url: null,
      });
    });
  });
  return out;
}

function normIdiomaVac(v) {
  const s = String(v ?? "").toUpperCase();
  if (/DOB|ESP|SPA|CAST/.test(s)) return "DOB";
  if (/SUB|VOSE|ORIG/.test(s)) return "SUB";
  return "S/I";
}

/* --- helpers de fecha (duplicados mínimos para que el módulo sea autónomo) --- */
const TZ = "America/Santiago";
function fechaChile() { return new Date().toLocaleDateString("en-CA", { timeZone: TZ }); }
function sumarDias(f, n) {
  const d = new Date(`${f}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function offsetChile(fecha) {
  const d = new Date(`${fecha}T12:00:00Z`);
  const local = new Date(d.toLocaleString("en-US", { timeZone: TZ }));
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  const h = Math.round((local - utc) / 3600000);
  return `${h < 0 ? "-" : "+"}${String(Math.abs(h)).padStart(2, "0")}:00`;
}

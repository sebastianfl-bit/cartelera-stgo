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
 * Estructura de vamosalcine.tri.cl/cine/<slug> (confirmada por inspección real):
 *   La página lista TODOS los días próximos de una vez, agrupados así:
 *     <h2 class="date-heading">viernes, 17 de julio de 2026</h2>
 *     .movie-block (una o más, las de ese día)
 *       .movie-title a          → título + link a /pelicula/<slug>
 *       .time-pill[data-time]   → horario; x-show trae {time,language,format}
 *   El parámetro ?date= NO filtra nada server-side (confirmado): la página
 *   siempre devuelve el mismo HTML completo con todos los días. Por eso se pide
 *   UNA sola vez por sede, y la fecha real de cada función se lee del
 *   <h2 class="date-heading"> que la antecede en el documento.
 *
 * Además: /pelicula/<slug> trae sinopsis y duración en español, que usamos
 * para enriquecer cada función (cacheado por slug para no repetir fetches).
 */

import * as cheerio from "cheerio";

const BASE = "https://vamosalcine.tri.cl";

// Sedes de Santiago Oriente en vamosalcine → id interno + comuna real.
const SEDES = [
  { slug: "cinepolis-parque-arauco",            nombre: "Cinépolis Parque Arauco",            comuna: "Las Condes" },
  { slug: "cinepolis-mall-plaza-los-dominicos",  nombre: "Cinépolis Mall Plaza Los Dominicos",  comuna: "Las Condes" },
  { slug: "cinepolis-la-reina",                  nombre: "Cinépolis La Reina",                  comuna: "La Reina" },
  { slug: "cinepolis-casa-costanera",            nombre: "Cinépolis Casa Costanera",            comuna: "Vitacura" },
  { slug: "cinepolis-plaza-egana",               nombre: "Cinépolis Plaza Egaña",               comuna: "La Reina" },
  { slug: "cinepolis-paseo-los-trapenses",       nombre: "Cinépolis Paseo Los Trapenses",       comuna: "Lo Barnechea" },
];

/** Devuelve { cines, funciones } leyendo Cinépolis desde vamosalcine. */
const VENTANA_DIAS = 5;   // hoy + 4, igual que el resto de las cadenas

export async function scrapeCinepolis({ limpiarTitulo }) {
  const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
  const hoy = fechaChile();
  const limite = sumarDias(hoy, VENTANA_DIAS - 1);   // último día incluido

  const funciones = [];
  const cinesOk = new Set();
  const sinopsisPorSlug = new Map();   // slug de /pelicula/ → {sinopsis,duracion}, cacheado entre sedes

  for (const sede of SEDES) {
    let html;
    try {
      const r = await fetch(`${BASE}/cine/${sede.slug}`, { headers: { "User-Agent": UA } });
      if (!r.ok) {
        if (process.env.DEBUG_CINEPOLIS) console.error(`   (debug) ${sede.nombre}: HTTP ${r.status}`);
        continue;
      }
      html = await r.text();
    } catch (e) {
      if (process.env.DEBUG_CINEPOLIS) console.error(`   (debug) ${sede.nombre}: ${e.message.slice(0, 60)}`);
      continue;
    }

    const fs = await parsearCine(html, sede, limpiarTitulo, sinopsisPorSlug, UA, hoy, limite);
    if (fs.length) { funciones.push(...fs); cinesOk.add(sede.slug); }
    if (process.env.DEBUG_CINEPOLIS) console.error(`   (debug) ${sede.nombre}: ${fs.length} funciones`);
  }

  const cines = SEDES.filter(s => cinesOk.has(s.slug)).map(s => ({
    id: `cinepolis-${s.slug}`, nombre: s.nombre, cadena: "Cinépolis",
    tipo: "cadena", comuna: s.comuna,
  }));
  return { cines, funciones };
}

/** Parsea la página de un cine: recorre date-heading + movie-block en orden de documento. */
async function parsearCine(html, sede, limpiarTitulo, sinopsisPorSlug, UA, hoy, limite) {
  const $ = cheerio.load(html);
  const out = [];
  const vistos = new Set();   // dedup real: misma clave exacta repetida en el HTML

  let fechaActual = null;
  $("body").find("h2.date-heading, .movie-block").each((_, el) => {
    const $el = $(el);
    if ($el.hasClass("date-heading")) {
      fechaActual = parsearFechaLarga($el.text().trim());
      return;
    }
    if (!fechaActual) return;   // bloques antes del primer heading (no debería pasar)

    const titulo = $el.find(".movie-title").first().text().trim();
    if (!titulo) return;
    const poster = $el.find("img.movie-poster").attr("src") || null;
    const hrefPeli = $el.find(".movie-title a, .movie-poster-link").first().attr("href") || null;
    const slugPeli = hrefPeli ? hrefPeli.replace(/^\/pelicula\//, "").replace(/\/$/, "") : null;

    $el.find(".time-pill").each((__, pill) => {
      const hora = ($(pill).attr("data-time") || "").match(/(\d{1,2}):(\d{2})/);
      if (!hora) return;

      let idioma = "S/I", formato = "2D";
      const xshow = $(pill).attr("x-show") || "";
      const dec = xshow.replace(/&#34;|&quot;/g, '"');
      const mLang = dec.match(/"language"\s*:\s*"([^"]+)"/);
      const mFmt = dec.match(/"format"\s*:\s*"([^"]+)"/);
      if (mLang) idioma = normIdiomaVac(mLang[1]);
      if (mFmt) formato = mFmt[1].toUpperCase().includes("3D") ? "3D" : "2D";

      const clave = `${sede.slug}|${fechaActual}|${hora[1]}:${hora[2]}|${formato}|${idioma}|${titulo}`;
      if (vistos.has(clave)) return;
      vistos.add(clave);

      out.push({
        cineId: `cinepolis-${sede.slug}`,
        titulo: limpiarTitulo(titulo),
        _slugPeli: slugPeli,
        duracion: 0,
        clasificacion: "S/I",
        genero: null,
        poster,
        sala: null,
        formato,
        atributos: [],
        idioma,
        inicio: `${fechaActual}T${hora[1].padStart(2, "0")}:${hora[2]}:00${offsetChile(fechaActual)}`,
        url: `https://cinepolis.com/cl?cinema=${sede.slug}-santiago-oriente`,
      });
    });
  });

  // Descartar funciones fuera de la ventana de días de la app ANTES de pedir
  // sinopsis, para no gastar fetches en películas que igual no se van a mostrar.
  const dentroDeVentana = out.filter(f => {
    const dia = f.inicio.slice(0, 10);
    return dia >= hoy && dia <= limite;
  });

  // Enriquecer con sinopsis+duración desde /pelicula/<slug>, una vez por película.
  const slugsUnicos = [...new Set(dentroDeVentana.map(f => f._slugPeli).filter(Boolean))];
  for (const slugPeli of slugsUnicos) {
    if (sinopsisPorSlug.has(slugPeli)) continue;
    try {
      const r = await fetch(`${BASE}/pelicula/${slugPeli}`, { headers: { "User-Agent": UA } });
      sinopsisPorSlug.set(slugPeli, r.ok ? extraerFichaPelicula(await r.text()) : null);
    } catch {
      sinopsisPorSlug.set(slugPeli, null);
    }
  }
  for (const f of dentroDeVentana) {
    const ficha = f._slugPeli ? sinopsisPorSlug.get(f._slugPeli) : null;
    if (ficha) { f.duracion = ficha.duracion || 0; f.sinopsis = ficha.sinopsis || null; }
    delete f._slugPeli;
  }

  return dentroDeVentana;
}

/** "viernes, 17 de julio de 2026" → "2026-07-17" */
function parsearFechaLarga(txt) {
  const MESES = { enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,
    agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12 };
  const m = txt.match(/(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/i);
  if (!m) return null;
  const mes = MESES[m[2].toLowerCase()];
  if (!mes) return null;
  return `${m[3]}-${String(mes).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/** Extrae sinopsis y duración de la página /pelicula/<slug> de vamosalcine. */
function extraerFichaPelicula(html) {
  const $ = cheerio.load(html);
  const dur = $.text().match(/(\d{2,3})\s*min/);
  let sinopsis = null;
  $("p").each((_, p) => {
    const t = $(p).text().trim();
    if (!sinopsis && t.length > 60) sinopsis = t;
  });
  return { duracion: dur ? parseInt(dur[1], 10) : 0, sinopsis };
}

function normIdiomaVac(v) {
  const s = String(v ?? "").toUpperCase();
  if (/DOB|ESP|SPA|CAST/.test(s)) return "DOB";
  if (/SUB|VOSE|ORIG/.test(s)) return "SUB";
  return "S/I";
}

/* --- helpers de fecha (autónomos, sin depender de scrape.mjs) --- */
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

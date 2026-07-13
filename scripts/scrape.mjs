/**
 * scripts/scrape.mjs — construye data/cartelera.json
 * Corre en GitHub Actions (Node 20+). Server-side ⇒ sin CORS.
 *
 * ESTADO
 *   ✅ Cinemark  — funcionando (schema.org embebido en el flight de Next App Router)
 *   ⬜ Cineplanet, Cinehoyts — pendientes
 *   ⬜ Normandie, Cineteca, Cine UC — pendientes (HTML plano, cheerio)
 */

import { writeFile, mkdir } from "node:fs/promises";
import * as cheerio from "cheerio";

const TZ = "America/Santiago";
const HOY = fechaChile();
const DIAS_MAX = 4;               // cuántos días publicar

const CINES = [
  { id: "cinemark-alto-las-condes",    nombre: "Cinemark Alto Las Condes",    cadena: "Cinemark", tipo: "cadena", comuna: "Las Condes",   slug: "cinemark-alto-las-condes" },
  { id: "cinemark-la-dehesa",          nombre: "Cinemark La Dehesa",          cadena: "Cinemark", tipo: "cadena", comuna: "Lo Barnechea", slug: "cinemark-la-dehesa" },
  { id: "cinemark-portal-nunoa",       nombre: "Cinemark Portal Ñuñoa",       cadena: "Cinemark", tipo: "cadena", comuna: "Ñuñoa",        slug: "cinemark-portal-nunoa" },
  { id: "cinemark-mallplaza-vespucio", nombre: "Cinemark Mallplaza Vespucio", cadena: "Cinemark", tipo: "cadena", comuna: "La Florida",   slug: "cinemark-mallplaza-vespucio" },
  { id: "cinemark-mallplaza-tobalaba", nombre: "Cinemark Mallplaza Tobalaba", cadena: "Cinemark", tipo: "cadena", comuna: "Puente Alto",  slug: "cinemark-mallplaza-tobalaba" },
  { id: "cinemark-mallplaza-norte",    nombre: "Cinemark Mallplaza Norte",    cadena: "Cinemark", tipo: "cadena", comuna: "Huechuraba",   slug: "cinemark-mallplaza-norte" },
  { id: "cinemark-mallplaza-oeste",    nombre: "Cinemark Mallplaza Oeste",    cadena: "Cinemark", tipo: "cadena", comuna: "Cerrillos",    slug: "cinemark-mallplaza-oeste" },
  { id: "cinemark-mid-mall-maipu",     nombre: "Cinemark Mid Mall Maipú",     cadena: "Cinemark", tipo: "cadena", comuna: "Maipú",        slug: "cinemark-mid-mall-maipu" },
  { id: "cinemark-gran-avenida",       nombre: "Cinemark Gran Avenida",       cadena: "Cinemark", tipo: "cadena", comuna: "San Miguel",   slug: "cinemark-gran-avenida" },

  // Cineplanet se autodescubre: un solo request trae todas sus sedes.
  // Esta entrada dispara el adaptador; las sedes reales se agregan solas.
  { id: "__cineplanet__", nombre: "Cineplanet (todas las sedes)", cadena: "Cineplanet", tipo: "cadena", comuna: "—", virtual: true },

  { id: "normandie",         nombre: "Cine Arte Normandie", cadena: "Normandie", tipo: "arte", comuna: "Santiago Centro" },
  { id: "cineteca-nacional", nombre: "Cineteca Nacional",   cadena: "Cineteca",  tipo: "arte", comuna: "Santiago Centro" },
  { id: "cine-uc",           nombre: "Cine UC",             cadena: "Cine UC",   tipo: "arte", comuna: "Santiago Centro" },
];

const ALIAS = {
  // "titulo como lo escribe una cadena": "titulo canonico"
  "demon slayer": "kimetsu no yaiba",
};

/* ================================================================== */
/* CINEMARK                                                            */
/* ================================================================== */
/**
 * La cartelera viene como schema.org/MovieTheater con event[] de ScreeningEvent,
 * embebida (doblemente escapada) en los chunks self.__next_f.push([...]).
 * Trae 4 días de una. No hay idioma ni clasificación: Cinemark no los publica acá.
 */
async function cinemark(cine) {
  const html = await getHTML(`https://www.cinemark.cl/cartelera/${cine.slug}`);
  const teatro = extraerSchemaMovieTheater(html);

  // Sin schema.org PERO con chunks de Next ⇒ sede sin funciones cargadas (o slug malo).
  // No es error: devolvemos vacío y el build sigue. Si NO hay flight, el sitio cambió.
  if (!teatro) {
    if (html.includes("self.__next_f.push")) return [];
    throw new Error("Página inesperada: no hay flight de Next. ¿Cambió el sitio?");
  }

  return (teatro.event ?? [])
    .filter(e => e["@type"] === "ScreeningEvent" && e.startDate && e.workPresented?.name)
    .map(e => {
      const { formato, atributos } = parseFormatoCinemark(e.videoFormat);
      return {
        cineId: cine.id,
        titulo: limpiarTitulo(e.workPresented.name),
        duracion: parseDuracionISO(e.workPresented.duration),
        clasificacion: "S/I",                       // no viene en el payload
        genero: e.workPresented.genre || null,
        poster: e.workPresented.image || null,
        sala: parseSalaCinemark(e.location?.name, cine.nombre),
        formato,
        atributos,                                  // ["XD"] | ["DBOX"] | ["PREMIER"] | []
        idioma: "S/I",                              // no viene en el payload
        inicio: fechaCinemark(e.startDate),
        url: e.offers?.url ?? null,
      };
    })
    .filter(f => f.inicio);
}

/** Junta los chunks del flight de Next App Router y devuelve el objeto MovieTheater. */
function extraerSchemaMovieTheater(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[\d+\s*,\s*("(?:[^"\\]|\\[\s\S])*")\s*\]\)/g)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return ""; } });
  const texto = chunks.join("");

  const marca = '{"@context":"https://schema.org","@type":"MovieTheater"';
  const i = texto.indexOf(marca);
  if (i === -1) return null;
  const crudo = recortarObjeto(texto, i);
  if (!crudo) return null;
  try { return JSON.parse(crudo); } catch { return null; }
}

/** Recorta un objeto JSON balanceando llaves, ignorando las que van dentro de strings. */
function recortarObjeto(s, desde) {
  let prof = 0, enStr = false, esc = false;
  for (let i = desde; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { enStr = !enStr; continue; }
    if (enStr) continue;
    if (c === "{") prof++;
    else if (c === "}" && --prof === 0) return s.slice(desde, i + 1);
  }
  return null;
}

/**
 * OJO: Cinemark serializa mal la fecha → "2026-07-12T15:00:00.000Z-05:00".
 * Tiene Z y offset a la vez, y el -05:00 ni siquiera es Chile (somos -04:00 en invierno).
 * El literal 15:00 ES la hora de pared local. Botamos el sufijo y estampamos el offset real.
 * Si interpretaras el Z, toda la cartelera se te correría 4 horas.
 */
function fechaCinemark(v) {
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return `${m[1]}T${m[2]}:${m[3]}:00${offsetChile(m[1])}`;
}

/** "Cinemark Alto Las Condes - 6" → "Sala 6" */
function parseSalaCinemark(loc, nombreCine) {
  if (!loc) return null;
  const n = loc.replace(nombreCine, "").replace(/^[\s-]+/, "").trim();
  return n ? `Sala ${n}` : null;
}

/** "2D + XD" → { formato:"XD", atributos:["XD"] };  "2D + DBOX" → { formato:"2D", atributos:["DBOX"] } */
function parseFormatoCinemark(v) {
  const s = String(v ?? "2D").toUpperCase();
  const base = s.includes("3D") ? "3D" : "2D";
  const atributos = ["XD", "IMAX", "4DX", "SCREENX", "D-BOX", "DBOX", "PREMIER"]
    .filter(a => s.includes(a))
    .map(a => (a === "D-BOX" ? "DBOX" : a));
  const unicos = [...new Set(atributos)];
  // XD/IMAX/4DX son formato de proyección; PREMIER/DBOX son tipo de butaca.
  const proyeccion = unicos.find(a => ["XD", "IMAX", "4DX", "SCREENX"].includes(a));
  return { formato: proyeccion ?? base, atributos: unicos };
}

/** "PT1H55M" → 115 */
function parseDuracionISO(v) {
  const m = String(v ?? "").match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0, 10) * 60) + parseInt(m[2] || 0, 10);
}


/* ================================================================== */
/* CINEPLANET                                                          */
/* ================================================================== */
/**
 * SPA pura (React): no hay nada que scrapear en el HTML. Pero detrás hay una
 * API JSON limpia, protegida por Azure API Management. Tres endpoints:
 *
 *   cinemascache  → catálogo de cines (ID, nombre, comuna, lat/lng)
 *   moviescache   → catálogo de películas, con cinemas[].dates[].sessions[]
 *   sessioncache  → detalle de cada sesión (hora, formato, IDIOMA)
 *
 * Se necesitan DOS credenciales:
 *   1. ocp-apim-subscription-key → hardcodeada en su bundle JS (pública por diseño).
 *   2. cookie channel-token      → JWT que la home emite por Set-Cookie a cualquiera.
 *      Sin login. Expira en ~1 hora, así que se pide fresca en cada corrida.
 *
 * Ventaja sobre Cinemark: acá SÍ viene el idioma (SUB/DOB), la fecha viene bien
 * formada, y un solo request trae TODOS los cines de Chile (no hay que iterar sedes).
 */
const CP_API = "https://www.cineplanet.cl/v3/api/cache";
const CP_KEY_FALLBACK = "c6f97c336b60469189a010a5836fe891";

async function cineplanetDatos() {
  // La home nos regala el channel-token vía Set-Cookie. Sin login.
  const home = await fetch("https://www.cineplanet.cl/", { headers: { "User-Agent": UA } });
  const setCookie = home.headers.getSetCookie?.() ?? [];
  const token = setCookie.join(";").match(/channel-token=([^;]+)/)?.[1];
  if (!token) throw new Error("La home no entregó channel-token. ¿Cambió el flujo de auth?");

  const key = await keyCineplanet(await home.text());
  const headers = {
    "User-Agent": UA,
    "Accept": "application/json",
    "ocp-apim-subscription-key": key,
    "Cookie": `channel-token=${token}`,
  };

  const [cines, pelis, sesiones] = await Promise.all([
    getJSON(`${CP_API}/cinemascache`, headers),
    getJSON(`${CP_API}/moviescache`, headers),
    getJSON(`${CP_API}/sessioncache`, headers),
  ]);
  return { cines: cines.cinemas ?? [], pelis: pelis.movies ?? [], sesiones: sesiones.sessions ?? [] };
}

/** La subscription key vive en el bundle. Extraerla evita morir en silencio si la rotan. */
async function keyCineplanet(homeHtml) {
  try {
    const bundle = homeHtml.match(/\/main\.[a-f0-9]+\.js/)?.[0];
    if (!bundle) return CP_KEY_FALLBACK;
    const js = await getHTML("https://www.cineplanet.cl" + bundle);
    return js.match(/[a-f0-9]{32}/)?.[0] ?? CP_KEY_FALLBACK;
  } catch {
    return CP_KEY_FALLBACK;
  }
}

/** Cineplanet se resuelve de una sola pasada: devuelve funciones de TODAS sus sedes. */
async function cineplanet() {
  const { cines, pelis, sesiones } = await cineplanetDatos();

  // Solo cines de Santiago (la API trae todo Chile: Copiapó, Temuco, etc.)
  const idxCine = new Map();
  for (const c of cines) {
    if (!esSantiago(c.city)) continue;
    idxCine.set(c.ID, {
      id: `cineplanet-${c.formattedCinemaName}`,
      nombre: c.name,
      cadena: "Cineplanet",
      tipo: "cadena",
      comuna: c.city,
      lat: parseFloat(c.latitude) || undefined,
      lng: parseFloat(c.longitude) || undefined,
    });
  }
  // Registrar las sedes descubiertas para que el frontend sepa de ellas.
  for (const c of idxCine.values()) if (!CINES.some(x => x.id === c.id)) CINES.push(c);

  const idxSesion = new Map(sesiones.map(s => [s.id, s]));
  const out = [];

  for (const p of pelis) {
    for (const c of p.cinemas ?? []) {
      const cine = idxCine.get(c.cinemaId);
      if (!cine) continue;                          // fuera de Santiago
      for (const d of c.dates ?? []) {
        for (const sid of d.sessions ?? []) {
          const s = idxSesion.get(sid);
          if (!s?.showtime) continue;
          out.push({
            cineId: cine.id,
            titulo: limpiarTitulo(p.title),
            duracion: p.runTime || 0,
            clasificacion: p.ratingDescription && p.ratingDescription !== "TBC" ? p.ratingDescription : "S/I",
            genero: p.genre || null,
            poster: p.posterUrl || null,
            sala: null,                             // la API no expone el número de sala
            formato: formatoCineplanet(s.formats),
            atributos: [],
            idioma: idiomaCineplanet(s.languages),
            inicio: s.showtime,                     // ya viene con offset chileno correcto
            url: p.movieDetailsUrl ? `https://www.cineplanet.cl/pelicula/${p.movieDetailsUrl}` : null,
          });
        }
      }
    }
  }
  return out;
}

/** "CONV" es sala convencional, no un formato. Lo ignoramos. */
function formatoCineplanet(formats = []) {
  const f = formats.map(x => String(x).toUpperCase());
  for (const especial of ["IMAX", "4DX", "XTREME", "PRIME"]) if (f.includes(especial)) return especial;
  return f.includes("3D") ? "3D" : "2D";
}

/** "SUBTITULAD" / "DOBLADA" → SUB / DOB */
function idiomaCineplanet(languages = []) {
  const l = languages.join(" ").toUpperCase();
  if (l.includes("DOBLAD")) return "DOB";
  if (l.includes("SUBTITUL")) return "SUB";
  return "S/I";
}

/** La API trae todo Chile. Nos quedamos con la RM. */
function esSantiago(city) {
  return /santiago|providencia|las condes|maip|florida|nunoa|ñuñoa|quilicura|puente alto|san bernardo|estacion central|estación central|vitacura|la reina|penalolen|peñalolén|huechuraba|independencia|recoleta|renca|cerrillos|san miguel|la cisterna|quilin|quilín/i
    .test(String(city ?? ""));
}

/* ================================================================== */
/* CINE ARTE — pendientes (HTML plano, ajusta los selectores)          */
/* ================================================================== */
async function normandie(cine) {
  const html = await getHTML("https://REEMPLAZAR/cartelera");
  const $ = cheerio.load(html);
  const out = [];
  $(".pelicula").each((_, el) => {
    const titulo = $(el).find("h2").first().text().trim();
    $(el).find(".horario").each((__, h) => {
      const hora = $(h).text().match(/\d{1,2}:\d{2}/)?.[0];
      if (!titulo || !hora) return;
      out.push({
        cineId: cine.id, titulo: limpiarTitulo(titulo),
        duracion: num($(el).find(".duracion").text()) ?? 0,
        clasificacion: "S/I", genero: null, poster: null,
        sala: "Sala 1", formato: "2D", atributos: [],
        idioma: normIdioma($(h).text()),
        inicio: horaSuelta(HOY, hora), url: null,
      });
    });
  });
  return out;
}

async function cineteca() { throw new Error("Adaptador pendiente"); }
async function cineuc()   { throw new Error("Adaptador pendiente"); }

const ADAPTADORES = {
  Cinemark: cinemark,
  Cineplanet: cineplanet,
  Normandie: normandie,
  Cineteca: cineteca,
  "Cine UC": cineuc,
};

/* ================================================================== */
/* Utilidades                                                          */
/* ================================================================== */

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

async function getHTML(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.text();
}

async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.json();
}

function num(v) {
  const n = parseInt(String(v ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Cinemark grita en mayúsculas. "TOY STORY 5" → "Toy Story 5" */
function limpiarTitulo(t) {
  const s = t.trim().replace(/\s+/g, " ");
  if (s !== s.toUpperCase()) return s;                    // ya viene bien capitalizado
  const MINUS = new Set(["de", "del", "la", "el", "los", "las", "y", "a", "en", "con", "por", "the", "of", "and"]);
  return s.toLowerCase().split(" ")
    .map((w, i) => (i > 0 && MINUS.has(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normIdioma(v) {
  const s = String(v ?? "").toUpperCase();
  if (/DOBLAD|\bDOB\b/.test(s)) return "DOB";
  if (/SUBTITUL|\bSUB\b|VOSE/.test(s)) return "SUB";
  return "S/I";
}

const RUIDO = /\b(2d|3d|4dx|xd|imax|screenx|dbox|premier|premium|subtitulada|doblada|sub|dob|reestreno|preestreno)\b/gi;

function slug(titulo) {
  let t = titulo.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[()\[\]:;,.!?¡¿"'`´]/g, " ")
    .replace(RUIDO, " ")
    .replace(/\s+/g, " ").trim();
  if (ALIAS[t]) t = ALIAS[t];
  return t.replace(/\s/g, "-");
}

/** Offset real de Chile para esa fecha (-04:00 invierno / -03:00 verano). */
function offsetChile(fecha) {
  const d = new Date(`${fecha}T12:00:00Z`);
  const local = new Date(d.toLocaleString("en-US", { timeZone: TZ }));
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  const h = Math.round((local - utc) / 3600000);
  return `${h < 0 ? "-" : "+"}${String(Math.abs(h)).padStart(2, "0")}:00`;
}

/** "23:40" suelta sobre una fecha base. Trasnoche (<06:00) cae al día calendario siguiente. */
function horaSuelta(fecha, hhmm) {
  const [h, m] = hhmm.split(":");
  const real = parseInt(h, 10) < 6 ? sumarDias(fecha, 1) : fecha;
  return `${real}T${h.padStart(2, "0")}:${m}:00${offsetChile(fecha)}`;
}

function fechaChile() { return new Date().toLocaleDateString("en-CA", { timeZone: TZ }); }

function sumarDias(f, n) {
  const d = new Date(`${f}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Día de CARTELERA al que pertenece una función (≠ día calendario).
 * Una trasnoche de las 00:30 del sábado es, para el espectador, la del viernes.
 */
function diaCartelera(iso) {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})/);
  return parseInt(m[2], 10) < 6 ? sumarDias(m[1], -1) : m[1];
}

/* ================================================================== */
/* Orquestación                                                        */
/* ================================================================== */

async function main() {
  const resultados = await Promise.allSettled(
    CINES.map(async cine => {
      const fn = ADAPTADORES[cine.cadena];
      if (!fn) throw new Error(`Sin adaptador para ${cine.cadena}`);
      const fs = await fn(cine);
      console.log(`✓ ${cine.nombre.padEnd(28)} ${String(fs.length).padStart(4)} funciones`);
      return fs;
    })
  );

  const fallidos = [], funciones = [];
  resultados.forEach((r, i) => {
    if (r.status === "fulfilled") funciones.push(...r.value);
    else { fallidos.push(CINES[i].nombre); console.error(`✗ ${CINES[i].nombre}: ${r.reason.message}`); }
  });

  if (!funciones.length) throw new Error("Ningún adaptador devolvió funciones. No se publica.");

  const dias = [];
  for (let i = 0; i < DIAS_MAX; i++) dias.push(sumarDias(HOY, i));

  const porPeli = new Map();
  for (const f of funciones) {
    if (!f.titulo || !f.inicio) continue;
    const dia = diaCartelera(f.inicio);
    if (!dias.includes(dia)) continue;

    const id = slug(f.titulo);
    if (!porPeli.has(id)) {
      porPeli.set(id, {
        id, titulo: f.titulo, duracion: f.duracion || 0,
        clasificacion: f.clasificacion, genero: f.genero,
        poster: f.poster, funciones: [],
      });
    }
    const p = porPeli.get(id);
    if (!p.duracion && f.duracion) p.duracion = f.duracion;
    if (!p.poster && f.poster) p.poster = f.poster;
    if (p.clasificacion === "S/I" && f.clasificacion !== "S/I") p.clasificacion = f.clasificacion;

    p.funciones.push({
      cine: f.cineId, dia, sala: f.sala, formato: f.formato,
      atributos: f.atributos?.length ? f.atributos : undefined,
      idioma: f.idioma, inicio: f.inicio, url: f.url ?? undefined,
    });
  }

  const peliculas = [...porPeli.values()]
    .map(p => ({ ...p, funciones: p.funciones.sort((a, b) => a.inicio.localeCompare(b.inicio)) }))
    .sort((a, b) => b.funciones.length - a.funciones.length);

  const salida = {
    generado: new Date().toISOString(),
    fecha: HOY,
    dias,
    fallidos: fallidos.length ? fallidos : undefined,
    cines: CINES.filter(c => !c.virtual).map(({ slug: _s, virtual: _v, ...c }) => c),
    peliculas,
  };

  await mkdir("data", { recursive: true });
  await writeFile("data/cartelera.json", JSON.stringify(salida, null, 2) + "\n");

  const total = peliculas.reduce((a, p) => a + p.funciones.length, 0);
  console.log(`\n→ ${peliculas.length} películas · ${total} funciones · ${dias[0]} a ${dias.at(-1)}`);
  if (fallidos.length) console.log(`  (sin datos: ${fallidos.join(", ")})`);
}

main().catch(e => { console.error(e); process.exit(1); });

/**
 * scripts/cinepolis.mjs — adaptador de Cinépolis / Cinehoyts
 *
 * ENFOQUE: NO adivinar. El sitio dispara sus propias queries GraphQL; nosotros
 * las INTERCEPTAMOS (texto exacto, headers exactos, URL exacta) y las REENVIAMOS
 * cambiando solo el cine. Así nunca peleamos con el esquema ni con CORS: usamos
 * literalmente el request que Cloudflare ya aprobó.
 *
 * Por qué Playwright: api-g.cinepolis.com está tras Cloudflare, que bloquea por
 * fingerprint TLS. Un Chrome real es la única forma de pasar. Y como el reenvío
 * usa page.request (contexto del navegador), hereda TLS, cookies y origin válidos.
 *
 * Fragilidad: puede fallar en GitHub Actions (Cloudflare desconfía de IPs de
 * datacenter). Si falla, devuelve [] y el resto de la cartelera se publica igual.
 */

const HOME = "https://cinepolis.com/cl";
const SEMILLA = "https://cinepolis.com/cl?cinema=cinepolis-paseo-los-trapenses-santiago-oriente";

export async function scrapeCinepolis({ limpiarTitulo }) {
  let chromium;
  try { ({ chromium } = await import("playwright")); }
  catch { throw new Error("Playwright no instalado (npm i playwright)"); }

  const headless = !process.env.HEADFUL;
  const browser = await chromium.launch({
    headless,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({
    locale: "es-CL",
    timezoneId: "America/Santiago",
    viewport: { width: 1366, height: 900 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await ctx.newPage();

  // Guardamos el request COMPLETO de cada operación (no solo la respuesta):
  // necesitamos su url, headers y body para poder reenviarlo.
  const req = {};   // operationName -> { url, headers, postData }
  const res = {};   // operationName -> [ {variables, data} ]
  page.on("request", r => {
    const u = r.url();
    if (!u.includes("api-g.cinepolis.com")) return;
    try {
      const body = JSON.parse(r.postData() ?? "{}");
      if (body.operationName) req[body.operationName] = { url: u, headers: r.headers(), postData: r.postData() };
    } catch {}
  });
  page.on("response", async r => {
    const u = r.url();
    if (!u.includes("api-g.cinepolis.com")) return;
    try {
      const body = JSON.parse(r.request().postData() ?? "{}");
      if (!body.operationName) return;
      (res[body.operationName] ??= []).push({ variables: body.variables, data: await r.json() });
    } catch {}
  });

  try {
    // Primera carga: capturamos catálogo (Cities, Movies) y la plantilla de Billboard.
    await page.goto(SEMILLA, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitFor(() => res.Cities, 25000, "Cities");
    await waitFor(() => res.Movies, 25000, "Movies");
    await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
    await waitFor(() => req.Billboard, 25000, "Billboard", false);

    if (process.env.DEBUG_CINEPOLIS) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile("cinepolis-debug.json", JSON.stringify({ req, res }, null, 2));
    }

    const cines = extraerCines(res.Cities);
    const pelis = extraerPelis(res.Movies);
    const santiago = cines.filter(c => /santiago/i.test(c.cityId) || /santiago/i.test(c.slug));
    const idxPeli = new Map(pelis.map(p => [p.slug, p]));
    console.error(`   (debug) ${cines.length} cines Chile · ${santiago.length} en Santiago · ${pelis.length} películas`);
    if (!santiago.length) throw new Error("Ningún cine de Santiago en Cities.");

    const funciones = [];
    const cinesOk = [];

    // Plantilla del fetch: la sacamos del Billboard interceptado en la carga inicial.
    const plantilla = req.Billboard;
    if (!plantilla) throw new Error("No se interceptó la plantilla de Billboard.");

    for (const cine of santiago) {
      const urlCine = `${HOME}?cinema=${encodeURIComponent(cine.slug)}`;
      let data = null;
      try {
        // Navegar pone el Referer/estado correcto para este cine.
        await page.goto(urlCine, { waitUntil: "domcontentloaded", timeout: 45000 });
        // Ejecutar el fetch DENTRO de la página (indistinguible de Cloudflare),
        // pidiendo explícitamente ESTE cine.
        data = await fetchBillboard(page, plantilla, cine.slug);
      } catch (e) {
        if (process.env.DEBUG_CINEPOLIS) console.error(`   (debug) ${cine.nombre}: ${e.message.slice(0,60)}`);
        continue;
      }

      // Validar que la respuesta sea de este cine, no del anterior.
      if (!billboardEsDe(data, cine.slug)) {
        if (process.env.DEBUG_CINEPOLIS) {
          const got = (data?.data?.billboardByCinema ?? data?.data?.billboard)?.schedules?.[0]?.cinemaId ?? "vacío";
          console.error(`   (debug) ${cine.nombre}: respuesta de otro cine (${got})`);
        }
        continue;
      }

      const fs = aplanarBillboard(data, cine, idxPeli, limpiarTitulo);
      if (fs.length) {
        funciones.push(...fs);
        cinesOk.push(cine);
        if (process.env.DEBUG_CINEPOLIS) console.error(`   (debug) ${cine.nombre}: ${fs.length} funciones`);
      }
    }

    return {
      cines: cinesOk.map(c => ({
        id: `cinepolis-${c.slug}`, nombre: c.nombre, cadena: "Cinépolis",
        tipo: "cadena", comuna: zona(c.cityId),
      })),
      funciones,
    };
  } finally {
    await browser.close();
  }
}

/** Ejecuta el fetch de Billboard DENTRO de la página, pidiendo un cine específico. */
async function fetchBillboard(page, plantilla, cinemaSlug) {
  const body = JSON.parse(plantilla.postData);
  body.variables = { ...body.variables, cinemas: cinemaSlug, movieId: "" };

  const permitidos = ["content-type", "country-id", "language", "x-apikey", "accept"];
  const headers = {};
  for (const [k, v] of Object.entries(plantilla.headers)) {
    if (permitidos.includes(k.toLowerCase())) headers[k] = v;
  }

  const r = await page.evaluate(async ({ url, headers, body }) => {
    try {
      const resp = await fetch(url, { method: "POST", headers, body, credentials: "include" });
      return resp.ok ? { ok: true, json: await resp.json() } : { ok: false, status: resp.status };
    } catch (e) { return { ok: false, error: String(e) }; }
  }, { url: plantilla.url, headers, body: JSON.stringify(body) });

  if (!r.ok) throw new Error(r.status ? `HTTP ${r.status}` : r.error);
  return r.json;
}

/** billboard.schedules[].dates[].languages[].showtimes[] → funciones planas */
function aplanarBillboard(json, cine, idxPeli, limpiarTitulo) {
  const out = [];
  const bb = json?.data?.billboardByCinema ?? json?.data?.billboard;
  for (const s of bb?.schedules ?? []) {
    const peli = idxPeli.get(s.movieId);
    for (const d of s.dates ?? []) {
      for (const l of d.languages ?? []) {
        for (const st of l.showtimes ?? []) {
          if (!st.datetime) continue;
          out.push({
            cineId: `cinepolis-${cine.slug}`,
            titulo: limpiarTitulo(peli?.titulo ?? s.movieId),
            duracion: peli?.duracion ?? 0,
            clasificacion: peli?.clasificacion ?? "S/I",
            genero: peli?.genero ?? null,
            poster: peli?.poster ?? null,
            sala: st.screen ? `Sala ${st.screen}` : null,
            formato: (st.format?.name ?? "2D").toUpperCase().includes("3D") ? "3D" : "2D",
            atributos: st.experience?.name && !/tradicional/i.test(st.experience.name)
              ? [st.experience.name.toUpperCase()] : [],
            idioma: idioma(l.language ?? l.displayLanguage),
            inicio: st.datetime,                    // se le estampa offset en scrape.mjs
            url: null,
          });
        }
      }
    }
  }
  return out;
}

/** ¿La respuesta Billboard corresponde a este cine? */
function billboardEsDe(json, slug) {
  const bb = json?.data?.billboardByCinema ?? json?.data?.billboard;
  const sch = bb?.schedules ?? [];
  return sch.length > 0 && sch[0].cinemaId === slug;
}

/** Espera a que llegue una Billboard cuyo cinemaId sea EXACTAMENTE este cine. */
async function waitForBillboardDe(res, slug, ms) {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    if ((res.Billboard ?? []).some(b => billboardEsDe(b.data, slug))) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

function extraerCines(capturas) {
  const edges = capturas?.[0]?.data?.data?.cities?.edges ?? [];
  const out = [];
  for (const e of edges) {
    for (const c of e.node?.cinemas ?? []) {
      if (c.id && c.name) out.push({ slug: c.id, nombre: c.name, cityId: c.cityId ?? e.node.id ?? "" });
    }
  }
  return out;
}

function extraerPelis(capturas) {
  const edges = capturas?.[0]?.data?.data?.movies?.edges ?? [];
  return edges.map(e => e.node).filter(n => n?.id).map(n => ({
    slug: n.id,
    titulo: n.name ?? n.originalName ?? n.id,
    duracion: parseInt(String(n.length ?? "").replace(/\D/g, ""), 10) || 0,
    clasificacion: n.rating ?? "S/I",
    genero: Array.isArray(n.genre) ? n.genre[0] : (n.genre ?? null),
    poster: n.poster ?? n.image ?? null,
  }));
}

/** "santiago-oriente" → "Santiago Oriente" (Cinépolis usa zonas, no comunas) */
function zona(cityId) {
  return String(cityId ?? "").split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || "Santiago";
}

function idioma(v) {
  const s = String(v ?? "").toUpperCase();
  if (/DOBLAD|SPA|ESP/.test(s)) return "DOB";
  if (/SUBTITUL|SUB|ORIGINAL|ENG/.test(s)) return "SUB";
  return "S/I";
}

async function waitFor(cond, ms, nombre, obligatorio = true) {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  if (obligatorio) throw new Error(`Timeout esperando ${nombre} (${ms}ms). La intercepción es intermitente; reintenta.`);
  return false;
}

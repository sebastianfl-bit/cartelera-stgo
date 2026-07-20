// node test-referer.mjs
// Hipótesis: la API decide el cine por el Referer. No podemos falsearlo en fetch,
// pero si NAVEGAMOS a la URL del cine, el navegador pone el Referer correcto solo.
// Probamos: navegar a 2 cines distintos y, en cada uno, fetch SIN header referer.
import { chromium } from "playwright";

const KEY = "lQM6Mkvri1iHksKKCfpAiwGXq0YUZA7Nn6XAXRPr4i13LwXo";
const Q = `query Billboard($countryId:String!,$movieId:String!,$cinemas:String!,$timezone:String){billboardByCinema(countryId:$countryId,movieId:$movieId,cinemas:$cinemas,timezone:$timezone){schedules{cinemaId}}}`;

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ locale: "es-CL", timezoneId: "America/Santiago" });
const page = await ctx.newPage();

async function pedirEn(slug) {
  // Navegar de verdad al cine: el Referer del fetch será esta URL.
  await page.goto(`https://cinepolis.com/cl?cinema=${slug}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  return page.evaluate(async ({ KEY, Q, slug }) => {
    // fetch SIN referer manual: el navegador pone el de la página actual.
    const resp = await fetch("https://api-g.cinepolis.com/v1/billboards/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "country-id": "CL",
        "language": "es",
        "x-apikey": KEY,
      },
      body: JSON.stringify({
        operationName: "Billboard",
        variables: { countryId: "CL", movieId: "", cinemas: slug, timezone: "America/Santiago" },
        query: Q,
      }),
      credentials: "include",
    });
    const j = await resp.json();
    const sch = j?.data?.billboardByCinema?.schedules ?? [];
    return { status: resp.status, cine: sch[0]?.cinemaId || "vacío", n: sch.length };
  }, { KEY, Q, slug });
}

for (const slug of [
  "cinepolis-parque-arauco-santiago-oriente",
  "cinepolis-plaza-egana-santiago-oriente",
  "cinepolis-casa-costanera-santiago-oriente",
]) {
  const r = await pedirEn(slug);
  const ok = r.cine === slug ? "✓ CORRECTO" : "✗ devolvió otro";
  console.log(`pedí ${slug}\n   → HTTP ${r.status}, ${r.n} schedules, cine=${r.cine}  ${ok}\n`);
}

await browser.close();

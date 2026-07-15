// Subir este número obliga a los navegadores a descartar la caché vieja.
const CACHE = "cartelera-v2";
const SHELL = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

// Estrategia network-first para el HTML y el JSON: siempre buscamos la versión
// fresca, y sólo caemos a la caché si no hay red (modo offline). Esto evita que
// una versión vieja de index.html quede pegada tras cada actualización.
// El resto (CSS/JS/imágenes, si los hubiera) va cache-first por velocidad.
function esDocumento(req, url) {
  return req.mode === "navigate"
    || url.pathname.endsWith(".html")
    || url.pathname.endsWith("/")
    || url.pathname.endsWith("cartelera.json");
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (esDocumento(e.request, url)) {
    e.respondWith(
      fetch(e.request)
        .then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return r; })
        .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
    );
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

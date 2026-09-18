// Service worker de mar.ia movil.
//
// Solo cachea la CARCASA (html, css, js, iconos) para que la app abra sin red
// y se pueda instalar. Las peticiones al PC NUNCA se cachean: una respuesta
// vieja de mar.ia seria peor que un error honesto.

const CACHE = "maria-movil-v1";
const CARCASA = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CARCASA)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Todo lo que no sea esta misma web (es decir, el PC) va directo a la red.
  if (url.origin !== self.location.origin || e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copia = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html"))),
  );
});

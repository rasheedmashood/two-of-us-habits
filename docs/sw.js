// Offline support: the app shell is cached so the app opens without a connection.
// Your habit data itself is kept offline by Firestore and syncs when you're back online.
const CACHE = "two-of-us-v5";
const SHELL = ["./", "index.html", "firebase-config.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never cache Firebase auth or database traffic
  if (/googleapis\.com$/.test(url.hostname) && !url.hostname.startsWith("fonts.")) return;
  if (url.pathname.startsWith("/__/")) return;

  // Pages: network first, so updates show up right away; fall back to the cached copy offline
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put("index.html", copy)); return res; })
      .catch(() => caches.match("index.html")));
    return;
  }

  // Same-origin files, the Firebase SDK and fonts: serve from cache, refresh in the background
  const cacheable = url.origin === self.location.origin || url.hostname === "www.gstatic.com" || url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!cacheable) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(req);
    const net = fetch(req).then(res => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});

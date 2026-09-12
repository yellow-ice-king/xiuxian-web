'use strict';

const CACHE = 'xiuxian-network-v6';

function cacheOk(res) {
  return res && res.status === 200 && (res.type === 'basic' || res.type === 'cors');
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') {
    return;
  }
  const isShell =
    url.pathname === '/' || url.pathname === '/index.html' ||
    url.pathname === '/game.bundle.js' || url.pathname === '/runtime.js' ||
    url.pathname === '/manifest.webmanifest';
  const isAsset = url.pathname.startsWith('/assets/');
  if (!isShell && !isAsset) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (cacheOk(res)) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) {
            return cached;
          }
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return undefined;
        })
      )
  );
});

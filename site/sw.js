// This page used to be the app, with a service worker that keeps serving it from its
// cache. This one replaces it: it drops that cache, removes itself and reloads the
// open tabs, which then show the landing page. The app (app/) has its own.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const scope = self.registration.scope;
      for (const name of await caches.keys()) {
        if (name.endsWith(scope)) await caches.delete(name);
      }
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
    })(),
  );
});

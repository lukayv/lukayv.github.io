const CACHE_NAME = 'lifequest-ai-cache-v1';
const urlsToCache = [
  '/',
  'lifequest_ai.html',
  'manifest.json',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Press+Start+2P&family=Roboto+Mono:wght@400;700&family=MedievalSharp&display=swap'
];

// Instala o Service Worker e armazena os ficheiros em cache
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Cache aberta');
        return cache.addAll(urlsToCache);
      })
  );
});

// Interceta os pedidos de rede
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Se o recurso estiver na cache, retorna-o
        if (response) {
          return response;
        }
        // Caso contrário, vai à rede buscá-lo
        return fetch(event.request);
      }
    )
  );
});

// Remove caches antigos quando uma nova versão é ativada
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

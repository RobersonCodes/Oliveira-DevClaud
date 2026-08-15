/* Oliveira DevCloud PWA lifecycle worker.
 *
 * This worker deliberately has no fetch handler and opens no Cache Storage. Authenticated pages,
 * API responses, terminal streams and workspace content always remain network-only. Installation
 * therefore improves home-screen launch and lifecycle control without claiming offline execution.
 */
const WORKER_VERSION = 'odc-network-only-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// Keep the version observable in DevTools without adding mutable global state or cache behavior.
self.ODC_WORKER_VERSION = WORKER_VERSION;

/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';
const worker = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `scriptorium-shell-${version}`;
// Only public application assets and the empty offline shell. Never cache API,
// login, library HTML, cookies, or authenticated page data.
const assets = [...build, ...files, '/offline', '/offline/__data.json'];
worker.addEventListener('install', event => {
	event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(assets)));
});
worker.addEventListener('activate', event => {
	event.waitUntil((async () => {
		for (const key of await caches.keys()) if (key.startsWith('scriptorium-shell-') && key !== CACHE) await caches.delete(key);
		await worker.clients.claim();
	})());
});
worker.addEventListener('fetch', event => {
	const request = event.request;
	const url = new URL(request.url);
	if (request.method !== 'GET' || url.origin !== worker.location.origin) return;
	if (assets.includes(url.pathname)) {
		event.respondWith((async () => (await (await caches.open(CACHE)).match(url.pathname)) || fetch(request))());
	} else if (request.mode === 'navigate') {
		event.respondWith((async () => {
			try { const response = await fetch(request); if (response.status < 500) return response; } catch { /* unavailable */ }
			return Response.redirect(new URL('/offline', url.origin), 302);
		})());
	}
});

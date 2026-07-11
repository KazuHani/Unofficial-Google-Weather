/*
 * Service worker: cache-first for the static app shell (so the UI loads
 * instantly and works offline), network-first for weather/hazard APIs
 * (so conditions never appear "fresh" when they're actually old - the
 * runtime cache is only ever used as a fallback when the network fails).
 */

const SHELL_CACHE = "gweather-shell-v1";
const RUNTIME_CACHE = "gweather-runtime-v1";

const SHELL_FILES = [
    "./",
    "./index.html",
    "./styles.css",
    "./hazards.js",
    "./pwa.js",
    "./manifest.json",
    "./offline.html",
    "./images/cloud.png",
    "./images/icons/icon-192.png",
    "./images/icons/icon-512.png",
    "./images/icons/icon-maskable-512.png",
    "./Sounds/Amber Alert.mp3",
];

// Hosts whose responses must always be fetched live first - never served
// stale from cache unless the network request genuinely fails.
const NETWORK_FIRST_HOSTS = [
    "api.open-meteo.com",
    "air-quality-api.open-meteo.com",
    "api.openweathermap.org",
    "nominatim.openstreetmap.org",
    "ipapi.co",
    "earthquake.usgs.gov",
    "api.weather.gov",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then((cache) => cache.addAll(SHELL_FILES))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
                    .map((key) => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "GET") return;

    let url;
    try {
        url = new URL(request.url);
    } catch (e) {
        return;
    }

    // Network-first for weather/hazard data APIs.
    if (NETWORK_FIRST_HOSTS.includes(url.hostname)) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const clone = response.clone();
                    caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, clone));
                    return response;
                })
                .catch(() => caches.match(request))
        );
        return;
    }

    // Only handle same-origin app-shell requests below; let everything else
    // (Windy embed, Google Fonts, Font Awesome CDN, Tailwind CDN, Gemini API)
    // pass straight through to the network untouched.
    if (url.origin !== self.location.origin) return;

    // Cache-first for the app shell, with a background revalidation.
    event.respondWith(
        caches.match(request).then((cached) => {
            const networkFetch = fetch(request)
                .then((response) => {
                    const clone = response.clone();
                    caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
                    return response;
                })
                .catch(() => {
                    if (request.mode === "navigate") {
                        return caches.match("./offline.html");
                    }
                    return cached;
                });
            return cached || networkFetch;
        })
    );
});

/*
 * Service worker: cache-first for the static app shell (so the UI loads
 * instantly and works offline), network-first for weather/hazard APIs
 * (so conditions never appear "fresh" when they're actually old - the
 * runtime cache is only ever used as a fallback when the network fails).
 *
 * Also handles Periodic Background Sync (best-effort, Chromium-only,
 * installed PWAs with sufficient site engagement) to re-check hazards and
 * fire notifications without the page open - see notifications.js for the
 * registration side and the caveats around this.
 */

const SHELL_CACHE = "gweather-shell-v2";
const RUNTIME_CACHE = "gweather-runtime-v2";

const SHELL_FILES = [
    "./",
    "./index.html",
    "./styles.css",
    "./hazards.js",
    "./notifications.js",
    "./pwa.js",
    "./manifest.json",
    "./offline.html",
    "./images/cloud.png",
    "./images/icons/icon-192.png",
    "./images/icons/icon-512.png",
    "./images/icons/icon-maskable-512.png",
    "./Sounds/Amber Alert.mp3",
];

// hazards.js is plain function declarations with no top-level DOM access
// (guarded with `typeof document !== "undefined"`), so it's safe to import
// here to reuse evaluateHazardAlerts()/fetchNearbyEarthquakes()/
// fetchNWSAlerts() for the background check below instead of duplicating
// that logic.
try {
    importScripts("./hazards.js");
} catch (e) {
    console.warn("Service worker: failed to import hazards.js", e);
}

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

// --- Best-effort background hazard check (Periodic Background Sync) -------
// Reads the minimal state notifications.js mirrors into IndexedDB (the
// service worker has no access to the page's localStorage) and, if
// notifications + hazard alerts are enabled, re-evaluates hazards and fires
// any newly-active ones. See notifications.js for the registration side.

function idbGet(key) {
    return new Promise((resolve) => {
        try {
            const req = indexedDB.open("gweather-notify", 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains("state")) {
                    req.result.createObjectStore("state");
                }
            };
            req.onsuccess = () => {
                const db = req.result;
                try {
                    const tx = db.transaction("state", "readonly");
                    const getReq = tx.objectStore("state").get(key);
                    getReq.onsuccess = () => { resolve(getReq.result || null); db.close(); };
                    getReq.onerror = () => { resolve(null); db.close(); };
                } catch (e) {
                    resolve(null);
                }
            };
            req.onerror = () => resolve(null);
        } catch (e) {
            resolve(null);
        }
    });
}

function idbSetNotifiedTypes(types) {
    return new Promise((resolve) => {
        try {
            const req = indexedDB.open("gweather-notify", 1);
            req.onsuccess = () => {
                const db = req.result;
                idbGet("notify-state").then((state) => {
                    if (!state) { db.close(); resolve(); return; }
                    state.notifiedHazardTypes = types;
                    const tx = db.transaction("state", "readwrite");
                    tx.objectStore("state").put(state, "notify-state");
                    tx.oncomplete = () => { db.close(); resolve(); };
                    tx.onerror = () => { db.close(); resolve(); };
                });
            };
            req.onerror = () => resolve();
        } catch (e) {
            resolve();
        }
    });
}

async function runBackgroundHazardCheck() {
    if (typeof evaluateHazardAlerts !== "function") return;

    const state = await idbGet("notify-state");
    if (!state || typeof state.lat !== "number" || typeof state.lon !== "number") return;
    if (!state.settings || !state.settings.enabled || !state.settings.notifyHazards) return;

    try {
        const weatherRes = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${state.lat}&longitude=${state.lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,apparent_temperature,wind_gusts_10m&timezone=auto`
        );
        if (!weatherRes.ok) return;
        const weatherJson = await weatherRes.json();
        if (!weatherJson || !weatherJson.current) return;

        const data = {
            location: state.location || "your area",
            lat: state.lat,
            lon: state.lon,
            condition: mapWMOCodeStandalone(weatherJson.current.weather_code),
            conditionDesc: "",
            tempC: weatherJson.current.temperature_2m,
            apparentTempC: weatherJson.current.apparent_temperature,
            windKph: weatherJson.current.wind_speed_10m,
            windGustsKph: weatherJson.current.wind_gusts_10m,
        };

        const earthquakes = typeof fetchNearbyEarthquakes === "function"
            ? await fetchNearbyEarthquakes(state.lat, state.lon)
            : [];
        const nwsAlerts = typeof fetchNWSAlerts === "function"
            ? await fetchNWSAlerts(state.lat, state.lon)
            : [];

        const alerts = evaluateHazardAlerts(data, earthquakes, nwsAlerts);
        const notifiedTypes = Array.isArray(state.notifiedHazardTypes) ? state.notifiedHazardTypes : [];
        const newAlerts = alerts.filter((a) => !notifiedTypes.includes(a.type));

        for (const alert of newAlerts) {
            await self.registration.showNotification(alert.title, {
                body: `${alert.location}\n${alert.message}`,
                tag: `hazard-${alert.type}`,
                icon: "./images/icons/icon-192.png",
                badge: "./images/icons/icon-192.png",
                requireInteraction: alert.severity === "critical",
            });
        }

        await idbSetNotifiedTypes(alerts.map((a) => a.type));
    } catch (e) {
        console.warn("Background hazard check failed:", e);
    }
}

// Minimal standalone WMO weather-code mapper mirroring mapWMOToCondition()
// in index.html exactly (kept in sync manually - that function lives in the
// page script, not hazards.js, and isn't reachable from the service worker).
function mapWMOCodeStandalone(code) {
    if ([0].includes(code)) return "Sunny";
    if ([1, 2, 3, 45, 48].includes(code)) return "Cloudy";
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "Rainy";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snowy";
    if ([95, 96, 99].includes(code)) return "Stormy";
    return "Cloudy";
}

self.addEventListener("periodicsync", (event) => {
    if (event.tag === "weather-hazard-check") {
        event.waitUntil(runBackgroundHazardCheck());
    }
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ("focus" in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow("./index.html");
        })
    );
});

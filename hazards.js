/*
 * Dynamic hazard alert engine: heatwave, extreme cold, extreme wind,
 * severe storm, and nearby earthquakes. Alerts are always evaluated
 * against the user's currently resolved coordinates (data.lat/data.lon),
 * so they only ever reflect what's happening at the active location.
 *
 * Loaded via <script src="hazards.js"> before the main inline script in
 * index.html, which calls evaluateHazardAlerts()/renderHazardAlerts()
 * from within renderWeatherData(). References to stormAudio/isMuted/
 * initStormAudio() below resolve against the globals declared later in
 * that main script - safe because these functions only ever *run* after
 * both scripts have finished their top-level execution.
 */

const HAZARD_TYPES = {
    severe_storm: { id: "severe_storm", priority: 100, color: "red", icon: "fa-triangle-exclamation", title: "CRITICAL SEVERE WEATHER WARNING", playsSiren: true },
    extreme_wind: { id: "extreme_wind", priority: 90, color: "orange", icon: "fa-wind", title: "EXTREME WIND WARNING", playsSiren: true },
    heatwave: { id: "heatwave", priority: 70, color: "rose", icon: "fa-temperature-high", title: "EXTREME HEAT WARNING", playsSiren: false },
    extreme_cold: { id: "extreme_cold", priority: 70, color: "sky", icon: "fa-snowflake", title: "EXTREME COLD WARNING", playsSiren: false },
    earthquake: { id: "earthquake", priority: 100, color: "amber", icon: "fa-house-crack", title: "RECENT EARTHQUAKE ALERT", playsSiren: false },
};

// Fully-literal Tailwind class strings per hazard color so the Tailwind CDN's
// JIT class scanner picks them up (string-interpolated class names like
// `from-${color}-600` are not reliably detected).
const HAZARD_COLOR_CLASSES = {
    red: "from-red-600 via-rose-600 to-red-700 dark:from-red-950 dark:via-rose-950 dark:to-red-900 border-red-500/30",
    orange: "from-orange-600 via-amber-600 to-orange-700 dark:from-orange-950 dark:via-amber-950 dark:to-orange-900 border-orange-500/30",
    rose: "from-rose-600 via-pink-600 to-rose-700 dark:from-rose-950 dark:via-pink-950 dark:to-rose-900 border-rose-500/30",
    sky: "from-sky-600 via-blue-600 to-sky-700 dark:from-sky-950 dark:via-blue-950 dark:to-sky-900 border-sky-500/30",
    amber: "from-amber-600 via-yellow-600 to-amber-700 dark:from-amber-950 dark:via-yellow-950 dark:to-amber-900 border-amber-500/30",
};

const EARTHQUAKE_RADIUS_KM = 300;
const EARTHQUAKE_MIN_MAG = 4.5;
const EARTHQUAKE_MAJOR_MAG = 6.0;

// Rough bounding boxes (CONUS/Alaska/Hawaii) - good enough to gate an optional NWS lookup.
function isUsCoords(lat, lon) {
    const conus = lat >= 24.5 && lat <= 49.5 && lon >= -125 && lon <= -66.5;
    const alaska = lat >= 51 && lat <= 71.5 && lon >= -180 && lon <= -129;
    const hawaii = lat >= 18.5 && lat <= 22.5 && lon >= -160.5 && lon <= -154.5;
    return conus || alaska || hawaii;
}

function hazardAbortSignal(ms) {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        return AbortSignal.timeout(ms);
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}

// Isolated fetch: any failure (network, timeout, malformed JSON) resolves to []
// so a dead USGS endpoint can never break weather rendering.
async function fetchNearbyEarthquakes(lat, lon) {
    try {
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${lat}&longitude=${lon}&maxradiuskm=${EARTHQUAKE_RADIUS_KM}&minmagnitude=${EARTHQUAKE_MIN_MAG}&starttime=${since}&orderby=magnitude`;
        const res = await fetch(url, { signal: hazardAbortSignal(6000) });
        if (!res.ok) return [];
        const data = await res.json();
        if (!data || !Array.isArray(data.features)) return [];
        return data.features.map(f => ({
            mag: f.properties.mag,
            place: f.properties.place,
            time: f.properties.time,
            url: f.properties.url,
        })).filter(eq => typeof eq.mag === "number");
    } catch (e) {
        console.warn("Earthquake fetch failed (isolated, weather unaffected):", e);
        return [];
    }
}

// Isolated fetch of official NWS alerts (US coordinates only). Same error isolation as above.
async function fetchNWSAlerts(lat, lon) {
    if (!isUsCoords(lat, lon)) return [];
    try {
        const res = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lon}`, {
            headers: {
                "Accept": "application/geo+json",
                "User-Agent": "(unofficial-google-weather, contact: weather-app@example.com)"
            },
            signal: hazardAbortSignal(6000)
        });
        if (!res.ok) return [];
        const data = await res.json();
        if (!data || !Array.isArray(data.features)) return [];
        return data.features
            .filter(f => f.properties && (f.properties.severity === "Extreme" || f.properties.severity === "Severe"))
            .map(f => ({
                event: f.properties.event,
                headline: f.properties.headline,
                description: f.properties.description,
                instruction: f.properties.instruction,
                severity: f.properties.severity,
            }));
    } catch (e) {
        console.warn("NWS alert fetch failed (isolated, weather unaffected):", e);
        return [];
    }
}

/**
 * Pure function: evaluates all hazard thresholds against the current weather
 * snapshot plus any earthquake/NWS data, and returns active alerts sorted by
 * priority (highest first).
 */
function evaluateHazardAlerts(data, earthquakes, nwsAlerts) {
    if (!data) return [];
    earthquakes = Array.isArray(earthquakes) ? earthquakes : [];
    nwsAlerts = Array.isArray(nwsAlerts) ? nwsAlerts : [];
    const alerts = [];
    const location = data.location || "your area";

    if (data.condition === "Stormy") {
        alerts.push({
            type: "severe_storm",
            severity: "critical",
            title: HAZARD_TYPES.severe_storm.title,
            location: `Severe storm conditions active at ${location}`,
            message: `${data.conditionDesc || "A massive storm with hazardous conditions is active."} Extremely dangerous storm conditions pose a severe threat to life. Seek indoor shelter immediately.`,
            icon: HAZARD_TYPES.severe_storm.icon,
            color: HAZARD_TYPES.severe_storm.color,
            priority: HAZARD_TYPES.severe_storm.priority,
            playsSiren: true,
            source: "weather",
        });
    }

    const windGustsMph = data.windGustsKph != null ? data.windGustsKph * 0.621371 : null;
    const windMph = data.windKph != null ? data.windKph * 0.621371 : 0;
    const isExtremeWind = (windGustsMph != null && windGustsMph > 58) || windMph > 47;
    if (isExtremeWind && data.condition !== "Stormy") {
        alerts.push({
            type: "extreme_wind",
            severity: "warning",
            title: HAZARD_TYPES.extreme_wind.title,
            location: `Dangerous wind speeds active at ${location}`,
            message: `${windGustsMph ? `Gusts up to ${Math.round(windGustsMph)} mph` : `Sustained winds of ${Math.round(windMph)} mph`} pose a risk of falling trees, debris, and power outages. Avoid unnecessary travel and stay clear of large trees and structures.`,
            icon: HAZARD_TYPES.extreme_wind.icon,
            color: HAZARD_TYPES.extreme_wind.color,
            priority: HAZARD_TYPES.extreme_wind.priority,
            playsSiren: true,
            source: "weather",
        });
    }

    const apparentTemp = data.apparentTempC != null ? data.apparentTempC : data.tempC;
    if (apparentTemp != null && apparentTemp >= 39) {
        const critical = apparentTemp >= 46;
        alerts.push({
            type: "heatwave",
            severity: critical ? "critical" : "warning",
            title: HAZARD_TYPES.heatwave.title,
            location: `Extreme heat active at ${location}`,
            message: `Feels-like temperature of ${Math.round(apparentTemp)}°C${critical ? " — extreme danger of heat stroke." : "."} Stay hydrated, avoid direct sun, and check on vulnerable family members and pets.`,
            icon: HAZARD_TYPES.heatwave.icon,
            color: HAZARD_TYPES.heatwave.color,
            priority: HAZARD_TYPES.heatwave.priority,
            playsSiren: false,
            source: "weather",
        });
    }

    if (apparentTemp != null && apparentTemp <= -25) {
        const critical = apparentTemp <= -34;
        alerts.push({
            type: "extreme_cold",
            severity: critical ? "critical" : "warning",
            title: HAZARD_TYPES.extreme_cold.title,
            location: `Extreme cold active at ${location}`,
            message: `Feels-like temperature of ${Math.round(apparentTemp)}°C${critical ? " — frostbite can occur within minutes on exposed skin." : "."} Limit time outdoors, dress in layers, and watch for signs of hypothermia.`,
            icon: HAZARD_TYPES.extreme_cold.icon,
            color: HAZARD_TYPES.extreme_cold.color,
            priority: HAZARD_TYPES.extreme_cold.priority,
            playsSiren: false,
            source: "weather",
        });
    }

    if (earthquakes.length > 0) {
        const strongest = earthquakes.reduce((a, b) => (b.mag > a.mag ? b : a), earthquakes[0]);
        const critical = strongest.mag >= EARTHQUAKE_MAJOR_MAG;
        alerts.push({
            type: "earthquake",
            severity: critical ? "critical" : "warning",
            title: HAZARD_TYPES.earthquake.title,
            location: `Recent seismic activity near ${location}`,
            message: `Magnitude ${strongest.mag.toFixed(1)} earthquake reported ${strongest.place || "nearby"}. ${critical ? "Be prepared for aftershocks and check for structural damage." : "Minor tremors may be felt; stay alert for aftershocks."}`,
            icon: HAZARD_TYPES.earthquake.icon,
            color: HAZARD_TYPES.earthquake.color,
            priority: HAZARD_TYPES.earthquake.priority,
            playsSiren: false,
            source: "usgs",
        });
    }

    if (nwsAlerts.length > 0) {
        const top = nwsAlerts[0];
        const existingStorm = alerts.find(a => a.type === "severe_storm");
        if (existingStorm) {
            existingStorm.location = `${top.event || "Severe weather"} active at ${location}`;
            existingStorm.message = top.headline || top.description || existingStorm.message;
            existingStorm.source = "nws";
        } else {
            alerts.push({
                type: "severe_storm",
                severity: "critical",
                title: (top.event || HAZARD_TYPES.severe_storm.title).toUpperCase(),
                location: `${top.event || "Severe weather"} active at ${location}`,
                message: top.headline || top.description || "An official severe weather alert is active in this area. Take immediate safety precautions.",
                icon: HAZARD_TYPES.severe_storm.icon,
                color: HAZARD_TYPES.severe_storm.color,
                priority: HAZARD_TYPES.severe_storm.priority,
                playsSiren: true,
                source: "nws",
            });
        }
    }

    return alerts.sort((a, b) => b.priority - a.priority);
}

function buildHazardBannerHTML(alert) {
    const colorClasses = HAZARD_COLOR_CLASSES[alert.color] || HAZARD_COLOR_CLASSES.red;
    const sirenNote = alert.playsSiren
        ? `<span class="flex items-center gap-1.5"><i class="fa-solid fa-circle-check text-[9px] text-yellow-300"></i> Local alerts active (Siren playing)</span>`
        : `<span class="flex items-center gap-1.5"><i class="fa-solid fa-circle-check text-[9px] text-yellow-300"></i> Stay alert for updates</span>`;
    const muteButton = alert.playsSiren
        ? `<button type="button" data-mute-btn class="px-4 py-2.5 rounded-full bg-white text-slate-800 hover:bg-slate-50 font-google text-xs font-bold shadow-md transition-all flex items-center gap-2 active:scale-95">
                <i data-mute-icon class="fa-solid fa-volume-high text-xs"></i>
                <span data-mute-text>Mute Siren</span>
            </button>`
        : "";
    return `
        <div id="hazard-banner-${alert.type}" data-hazard-type="${alert.type}"
            class="anim-fade-in-down bg-gradient-to-r ${colorClasses} text-white rounded-5xl p-5 shadow-2xl relative overflow-hidden animate-pulse-glow">
            <div class="absolute -top-12 -left-12 w-32 h-32 bg-white/10 rounded-full blur-2xl"></div>
            <div class="relative z-10 flex flex-col md:flex-row items-center justify-between gap-4">
                <div class="flex items-start gap-4">
                    <div class="p-3 bg-white/20 rounded-2xl animate-bounce flex items-center justify-center flex-shrink-0">
                        <i class="fa-solid ${alert.icon} text-2xl text-yellow-300"></i>
                    </div>
                    <div class="text-left">
                        <h3 class="font-google font-extrabold text-base sm:text-lg tracking-tight text-white flex items-center gap-2">
                            ${alert.title}
                        </h3>
                        <p class="text-xs font-semibold text-white/90 mt-0.5">${alert.location}</p>
                        <p class="text-xs text-white/90 mt-2 leading-relaxed font-medium">${alert.message}</p>
                        <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-white/90">
                            <span class="flex items-center gap-1.5"><i class="fa-solid fa-phone text-[9px] text-yellow-300"></i> Emergency Services: Call 911 / 999 / 112 / 119</span>
                            ${sirenNote}
                        </div>
                    </div>
                </div>
                ${muteButton ? `<div class="flex items-center gap-2.5 flex-shrink-0 w-full md:w-auto justify-end">${muteButton}</div>` : ""}
            </div>
        </div>
    `;
}

/**
 * Renders the active alert list into #hazard-alerts-container, diffing
 * against what's already there so unrelated banners (and their audio state)
 * aren't torn down and rebuilt on every re-render. `data` (the weather
 * snapshot the alerts were evaluated from) is optional and only used to
 * forward newly-active alerts to the notification system.
 */
function renderHazardAlerts(alerts, data) {
    const container = document.getElementById("hazard-alerts-container");
    if (!container) return;

    if (typeof checkAndNotifyHazards === "function") {
        checkAndNotifyHazards(alerts, data).catch(e => console.warn("Hazard notification check failed:", e));
    }

    const nextTypes = new Set(alerts.map(a => a.type));

    // Remove banners whose alert has cleared, with a fade-out first.
    Array.from(container.children).forEach(child => {
        const type = child.dataset.hazardType;
        if (!nextTypes.has(type)) {
            child.classList.remove("anim-fade-in-down");
            child.classList.add("anim-fade-out-up");
            setTimeout(() => child.remove(), 480);
        }
    });

    alerts.forEach(alert => {
        const existing = document.getElementById(`hazard-banner-${alert.type}`);
        if (existing) {
            existing.querySelector("p.font-semibold").textContent = alert.location;
            existing.querySelectorAll("p")[1].textContent = alert.message;
        } else {
            container.insertAdjacentHTML("beforeend", buildHazardBannerHTML(alert));
        }
    });

    // Re-order DOM to match priority order.
    alerts.forEach(alert => {
        const el = document.getElementById(`hazard-banner-${alert.type}`);
        if (el) container.appendChild(el);
    });

    // Screen-edge glow: only while a critical, life-threatening hazard is active.
    const edgeGlow = document.getElementById("hazard-edge-glow");
    if (edgeGlow) {
        const hasCriticalThreat = alerts.some(a => a.severity === "critical" && (a.type === "severe_storm" || a.type === "earthquake"));
        edgeGlow.classList.toggle("hidden", !hasCriticalThreat);
    }

    // Siren: one shared audio instance, active while any siren-eligible alert is present.
    const sirenAlerts = alerts.filter(a => a.playsSiren);
    if (typeof initStormAudio === "function") {
        if (sirenAlerts.length > 0) {
            initStormAudio();
            if (typeof stormAudio !== "undefined" && stormAudio) {
                if (typeof isMuted !== "undefined" && isMuted) {
                    stormAudio.pause();
                } else {
                    stormAudio.play().catch(e => console.warn("Audio autoplay blocked, waiting for user interaction.", e));
                }
            }
        } else if (typeof stormAudio !== "undefined" && stormAudio) {
            stormAudio.pause();
        }
    }

    updateHazardMuteButtons();
}

function updateHazardMuteButtons() {
    if (typeof isMuted === "undefined") return;
    document.querySelectorAll("#hazard-alerts-container [data-mute-btn]").forEach(btn => {
        const icon = btn.querySelector("[data-mute-icon]");
        const text = btn.querySelector("[data-mute-text]");
        if (icon) icon.className = isMuted ? "fa-solid fa-volume-xmark text-xs" : "fa-solid fa-volume-high text-xs";
        if (text) text.textContent = isMuted ? "Unmute Siren" : "Mute Siren";
    });
}

// Event delegation for mute buttons: banners are created/destroyed dynamically,
// so a single listener on the container handles all of them. Guarded because
// this file is also imported into the service worker (sw.js, via
// importScripts) to reuse evaluateHazardAlerts()/fetchNearbyEarthquakes()/
// fetchNWSAlerts() for background checks - `document` doesn't exist there.
if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
        const container = document.getElementById("hazard-alerts-container");
        if (!container) return;
        container.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-mute-btn]");
            if (!btn) return;
            if (typeof isMuted === "undefined") return;
            isMuted = !isMuted;
            if (typeof stormAudio !== "undefined" && stormAudio) {
                if (isMuted) {
                    stormAudio.pause();
                } else {
                    stormAudio.play().catch(e2 => console.warn("Failed to play siren:", e2));
                }
            }
            updateHazardMuteButtons();
        });
    });
}

/*
 * Browser notifications: permission handling, hazard-triggered alerts,
 * and a daily briefing at a user-chosen time.
 *
 * Delivery uses ServiceWorkerRegistration.showNotification() (falls back to
 * the plain Notification constructor only when no service worker is
 * available) because Android Chrome does not support `new Notification()`
 * from a page context - the service-worker path is required for mobile.
 *
 * "Background" delivery beyond an open tab is best-effort: Periodic
 * Background Sync (Chrome/Android, installed PWA + site engagement only)
 * lets sw.js re-check hazards without the page open. There is no push
 * server in this project, so true delivery while the app is fully closed
 * on unsupported browsers (iOS Safari, Firefox, non-installed Chrome) is
 * not possible - the settings UI says so.
 *
 * Loaded via <script src="notifications.js"> after hazards.js and before
 * the main inline script, which calls checkAndSendDailyBriefing() from its
 * refresh/visibility hooks. hazards.js's renderHazardAlerts() calls
 * checkAndNotifyHazards() from here directly (safe cross-file reference -
 * see the note at the top of hazards.js about script execution timing).
 */

const NOTIF_KEYS = {
    enabled: "notifications_enabled",
    notifyHazards: "notify_hazards_enabled",
    notifyDaily: "notify_daily_enabled",
    dailyTime: "notify_daily_time",
    notifiedHazardTypes: "notified_hazard_types",
    dailyLastDate: "notify_daily_last_date",
};

function getNotificationSettings() {
    return {
        enabled: localStorage.getItem(NOTIF_KEYS.enabled) === "true",
        notifyHazards: localStorage.getItem(NOTIF_KEYS.notifyHazards) !== "false",
        notifyDaily: localStorage.getItem(NOTIF_KEYS.notifyDaily) === "true",
        dailyTime: localStorage.getItem(NOTIF_KEYS.dailyTime) || "08:00",
    };
}

function isNotificationSupported() {
    return typeof window !== "undefined" && "Notification" in window;
}

async function requestNotificationPermission() {
    if (!isNotificationSupported()) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    try {
        const result = await Notification.requestPermission();
        return result === "granted";
    } catch (e) {
        console.warn("Notification permission request failed:", e);
        return false;
    }
}

async function showLocalNotification(title, options = {}) {
    if (!isNotificationSupported() || Notification.permission !== "granted") return;
    const finalOptions = Object.assign({
        icon: "images/icons/icon-192.png",
        badge: "images/icons/icon-192.png",
    }, options);

    try {
        if ("serviceWorker" in navigator) {
            const reg = await navigator.serviceWorker.ready;
            await reg.showNotification(title, finalOptions);
            return;
        }
    } catch (e) {
        console.warn("Service-worker notification failed, falling back:", e);
    }

    // Desktop-only fallback for browsers without an active service worker.
    try {
        const n = new Notification(title, finalOptions);
        n.onclick = () => { window.focus(); n.close(); };
    } catch (e) {
        console.warn("Notification fallback failed:", e);
    }
}

async function enableNotifications() {
    const granted = await requestNotificationPermission();
    localStorage.setItem(NOTIF_KEYS.enabled, granted ? "true" : "false");
    if (granted) registerPeriodicSync();
    return granted;
}

function disableNotifications() {
    localStorage.setItem(NOTIF_KEYS.enabled, "false");
}

/**
 * Notifies on newly-active hazard alerts only (dedupes against the set of
 * types already notified while they remain active, so an ongoing alert
 * doesn't re-fire every 10-minute refresh - clearing and recurring later
 * notifies again).
 */
async function checkAndNotifyHazards(alerts, data) {
    const settings = getNotificationSettings();
    if (!settings.enabled || !settings.notifyHazards) return;
    if (!isNotificationSupported() || Notification.permission !== "granted") return;

    let notifiedTypes = [];
    try {
        notifiedTypes = JSON.parse(localStorage.getItem(NOTIF_KEYS.notifiedHazardTypes) || "[]");
    } catch (e) {
        notifiedTypes = [];
    }

    const currentTypes = alerts.map(a => a.type);
    const newAlerts = alerts.filter(a => !notifiedTypes.includes(a.type));

    for (const alert of newAlerts) {
        await showLocalNotification(alert.title, {
            body: `${alert.location}\n${alert.message}`,
            tag: `hazard-${alert.type}`,
            requireInteraction: alert.severity === "critical",
        });
    }

    localStorage.setItem(NOTIF_KEYS.notifiedHazardTypes, JSON.stringify(currentTypes));
    syncNotificationStateToSW(data);
}

/**
 * Sends one daily forecast summary near the user's chosen time. Checked on
 * every refresh/visibility tick (roughly every 10 minutes while the app is
 * open), so it fires within a ~10-minute window of the target time, once
 * per calendar day.
 */
async function checkAndSendDailyBriefing(data) {
    const settings = getNotificationSettings();
    if (!settings.enabled || !settings.notifyDaily) return;
    if (!isNotificationSupported() || Notification.permission !== "granted") return;
    if (!data) return;

    const now = new Date();
    const todayStr = now.toDateString();
    if (localStorage.getItem(NOTIF_KEYS.dailyLastDate) === todayStr) return;

    const [targetHour, targetMinute] = (settings.dailyTime || "08:00").split(":").map(Number);
    const targetMinutes = targetHour * 60 + targetMinute;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (Math.abs(nowMinutes - targetMinutes) > 10) return;

    const high = Math.round(data.highC);
    const low = Math.round(data.lowC);
    await showLocalNotification(`Today's Weather - ${data.location}`, {
        body: `${data.condition}, H:${high}° L:${low}°. ${data.conditionDesc || ""}`.trim(),
        tag: "daily-briefing",
    });

    localStorage.setItem(NOTIF_KEYS.dailyLastDate, todayStr);
    syncNotificationStateToSW(data);
}

// --- IndexedDB bridge: lets the (localStorage-less) service worker read the
// minimal state it needs to run a best-effort background hazard check. ---
function idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open("gweather-notify", 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains("state")) {
                req.result.createObjectStore("state");
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbSet(key, value) {
    try {
        const db = await idbOpen();
        await new Promise((resolve, reject) => {
            const tx = db.transaction("state", "readwrite");
            tx.objectStore("state").put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    } catch (e) {
        console.warn("Failed to write notification state to IndexedDB:", e);
    }
}

function syncNotificationStateToSW(data) {
    if (!data || typeof indexedDB === "undefined") return;
    const settings = getNotificationSettings();
    let notifiedHazardTypes = [];
    try {
        notifiedHazardTypes = JSON.parse(localStorage.getItem(NOTIF_KEYS.notifiedHazardTypes) || "[]");
    } catch (e) {
        notifiedHazardTypes = [];
    }
    idbSet("notify-state", {
        lat: data.lat,
        lon: data.lon,
        location: data.location,
        settings,
        notifiedHazardTypes,
        dailyLastDate: localStorage.getItem(NOTIF_KEYS.dailyLastDate) || "",
    });
}

/**
 * Best-effort: registers Periodic Background Sync so sw.js can re-check
 * hazards without the page open. Only works for installed PWAs with
 * sufficient site engagement in Chromium browsers - silently no-ops
 * everywhere else (iOS Safari, Firefox, non-installed Chrome).
 */
async function registerPeriodicSync() {
    if (!("serviceWorker" in navigator)) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        if (!("periodicSync" in reg)) return;
        const status = await navigator.permissions.query({ name: "periodic-background-sync" });
        if (status.state !== "granted") return;
        await reg.periodicSync.register("weather-hazard-check", {
            minInterval: 30 * 60 * 1000, // 30 minutes (browser may throttle further)
        });
    } catch (e) {
        // Unsupported or denied - foreground checks remain the reliable path.
        console.info("Periodic background sync unavailable:", e.message || e);
    }
}

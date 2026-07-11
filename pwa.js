/*
 * PWA glue: service worker registration + "Install App" button wiring
 * (beforeinstallprompt). Kept self-contained so it can be loaded with
 * `defer` independently of the main app script.
 */

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("sw.js").catch((err) => {
            console.warn("Service worker registration failed:", err);
        });
    });
}

let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const btn = document.getElementById("install-app-btn");
    if (btn) btn.classList.remove("hidden");
});

window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    const btn = document.getElementById("install-app-btn");
    if (btn) btn.classList.add("hidden");
});

document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("install-app-btn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        btn.classList.add("hidden");
    });
});

// PWA kurulum akışı ve Service Worker kaydı

import { $ } from "../state.js";

export function initPwa() {
  let deferredInstallPrompt = null;
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);

  if (!isStandalone && isIos) {
    $("installPwaBtn").textContent = "Ana Ekrana Ekle";
    $("installPwaBtn").classList.remove("hidden");
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (!isStandalone) {
      $("installPwaBtn").textContent = "Uygulamayı Yükle";
      $("installPwaBtn").classList.remove("hidden");
    }
  });

  $("installPwaBtn").addEventListener("click", async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      try {
        const { outcome } = await deferredInstallPrompt.userChoice;
        if (outcome === "accepted") $("installPwaBtn").classList.add("hidden");
      } catch (_) {}
      deferredInstallPrompt = null;
    } else if (isIos) {
      $("iosInstallHint").classList.toggle("hidden");
    }
  });

  $("closeIosHintBtn").addEventListener("click", () => {
    $("iosInstallHint").classList.add("hidden");
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    $("installPwaBtn").classList.add("hidden");
    $("iosInstallHint").classList.add("hidden");
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((err) => {
        console.warn("Service Worker kaydedilemedi:", err);
      });
    });
  }
}

// Screen Wake Lock ve 7/24 siyah ekran karartma katmanı

import { $, appState } from "../state.js";

export class WakeLockBlackout {
  constructor() {
    this.wakeLock = null;
    this.clockTimer = null;
    this.lastTap = 0;

    this._bindEvents();
  }

  _bindEvents() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && appState.activeRole === "camera") {
        this.requestWakeLock();
      }
    });

    $("blackoutBtn").addEventListener("click", () => {
      this.showBlackout();
    });

    $("blackoutOverlay").addEventListener("click", () => {
      const now = Date.now();
      if (now - this.lastTap < 350) {
        this.hideBlackout();
      }
      this.lastTap = now;
    });
  }

  async requestWakeLock() {
    if (!("wakeLock" in navigator)) {
      $("wakeLockBadge").textContent = "Ekran Kilidi: Desteklenmiyor";
      return;
    }
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
      $("wakeLockBadge").textContent = "Ekran: Uyanık";
      this.wakeLock.addEventListener("release", () => {
        $("wakeLockBadge").textContent = "Ekran: Serbest";
      });
    } catch (_) {
      $("wakeLockBadge").textContent = "Ekran Kilidi: Alınamadı";
    }
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }

  showBlackout() {
    this._updateClock();
    $("blackoutOverlay").classList.remove("hidden");
    if (!this.clockTimer) {
      this.clockTimer = setInterval(() => this._updateClock(), 1000);
    }
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  hideBlackout() {
    $("blackoutOverlay").classList.add("hidden");
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }

  _updateClock() {
    $("blackoutClock").textContent = new Date().toTimeString().slice(0, 5);
  }
}

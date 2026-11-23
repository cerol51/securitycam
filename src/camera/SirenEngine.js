// Kamera siren motoru (Web Audio API)

import { LIMITS } from "../config.js";
import { $, addAlarmLog } from "../state.js";

export class SirenEngine {
  constructor({ onMetaSync }) {
    this.onMetaSync = onMetaSync;
    this.audioCtx = null;
    this.isActive = false;
    this.nodes = null;
    this.autoStopTimer = null;

    $("sirenLocalBtn").addEventListener("click", () => {
      if (this.isActive) this.stop(false);
      else this.start(false);
    });
  }

  unlockAudio() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!this.audioCtx) this.audioCtx = new AudioCtx();
    if (this.audioCtx.state === "suspended") this.audioCtx.resume().catch(() => {});
  }

  start(isRemote = false) {
    if (this.isActive) return;
    try {
      this.unlockAudio();
      if (!this.audioCtx) throw new Error("Tarayıcı Web Audio desteklemiyor.");
      if (this.audioCtx.state === "suspended") this.audioCtx.resume().catch(() => {});

      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const lfo = this.audioCtx.createOscillator();
      const lfoGain = this.audioCtx.createGain();
      const masterGain = this.audioCtx.createGain();

      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(950, now);

      lfo.type = "sine";
      lfo.frequency.setValueAtTime(1.8, now);
      lfoGain.gain.setValueAtTime(350, now);

      masterGain.gain.setValueAtTime(0.85, now);

      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      osc.connect(masterGain);
      masterGain.connect(this.audioCtx.destination);

      osc.start(now);
      lfo.start(now);

      this.nodes = { osc, lfo, lfoGain, masterGain };
      this.isActive = true;

      $("sirenAlertBadge").classList.remove("hidden");
      $("sirenLocalBtn").textContent = "Sireni Sustur";
      $("sirenLocalBtn").className = "danger";

      const msg = isRemote
        ? "Alarm sireni uzaktan başlatıldı (60 sn)."
        : "Siren testi başlatıldı.";
      $("camStatus").textContent = msg;
      addAlarmLog(isRemote ? "Uzaktan komut: Siren çalıyor" : "Yerel siren testi başlatıldı");

      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = setTimeout(() => {
        this.stop(false, true);
      }, LIMITS.SIREN_MAX_DURATION_MS);

      this.onMetaSync({ lastEvent: msg, lastEventAt: Date.now() });
    } catch (err) {
      const errMsg = "Siren başlatılamadı: " + err.message;
      $("camStatus").textContent = errMsg;
      if (isRemote) this.onMetaSync({ lastEvent: errMsg, lastEventAt: Date.now() });
    }
  }

  stop(isRemote = false, isAutoTimeout = false) {
    clearTimeout(this.autoStopTimer);
    this.autoStopTimer = null;

    if (this.nodes) {
      try { this.nodes.osc.stop(); } catch (_) {}
      try { this.nodes.lfo.stop(); } catch (_) {}
      try { this.nodes.osc.disconnect(); } catch (_) {}
      try { this.nodes.lfo.disconnect(); } catch (_) {}
      try { this.nodes.lfoGain.disconnect(); } catch (_) {}
      try { this.nodes.masterGain.disconnect(); } catch (_) {}
      this.nodes = null;
    }

    const wasOn = this.isActive;
    this.isActive = false;
    $("sirenAlertBadge").classList.add("hidden");
    $("sirenLocalBtn").textContent = "Siren Testi";
    $("sirenLocalBtn").className = "secondary";

    if (wasOn) {
      const msg = isAutoTimeout
        ? "Alarm sireni 60 sn sonunda otomatik durdu."
        : isRemote
          ? "Alarm sireni uzaktan susturuldu."
          : "Alarm sireni susturuldu.";
      $("camStatus").textContent = msg;
      addAlarmLog(msg);
      this.onMetaSync({ lastEvent: msg, lastEventAt: Date.now() });
    }
  }

  dispose() {
    this.stop(false);
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }
}

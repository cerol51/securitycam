// Kamera cihazı sağlık telemetrisi (Pil yüzdesi, şarj durumu, elektrik kesintisi / düşük pil uyarısı)

import { TELEMETRY_CONFIG } from "../config.js";
import { $, appState, addAlarmLog } from "../state.js";
import { getTelegramCredentials, sendTelegramMessage } from "../services/telegram.js";

export class DeviceTelemetry {
  constructor({ onTelemetryChange }) {
    this.onTelemetryChange = onTelemetryChange;
    this.battery = null;
    this.batteryPct = null;
    this.charging = null;
    this.wasCharging = null;
    this.lowBatteryAlerted = false;
    this.syncTimer = null;
    this._boundUpdate = () => this._readBatteryState(true);
  }

  getSnapshot() {
    return {
      batteryPct: this.batteryPct,
      charging: this.charging
    };
  }

  async start() {
    this.stop();
    this.lowBatteryAlerted = false;
    this.wasCharging = null;

    const badge = $("batteryBadge");
    if (typeof navigator.getBattery !== "function") {
      if (badge) {
        badge.textContent = "Pil: Desteklenmiyor";
        badge.classList.add("hidden");
      }
      return;
    }

    try {
      this.battery = await navigator.getBattery();
      this.battery.addEventListener("levelchange", this._boundUpdate);
      this.battery.addEventListener("chargingchange", this._boundUpdate);
      this._readBatteryState(false);

      this.syncTimer = setInterval(() => {
        if (this.battery) this._readBatteryState(false);
      }, TELEMETRY_CONFIG.SYNC_INTERVAL_MS);
    } catch (_) {
      if (badge) badge.classList.add("hidden");
    }
  }

  stop() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.battery) {
      this.battery.removeEventListener("levelchange", this._boundUpdate);
      this.battery.removeEventListener("chargingchange", this._boundUpdate);
      this.battery = null;
    }
    this.batteryPct = null;
    this.charging = null;
    this.wasCharging = null;
    const badge = $("batteryBadge");
    if (badge) badge.classList.add("hidden");
  }

  _readBatteryState(fromEvent) {
    if (!this.battery) return;
    const pct = Math.round(this.battery.level * 100);
    const charging = Boolean(this.battery.charging);

    const prevCharging = this.wasCharging;
    this.batteryPct = pct;
    this.charging = charging;
    this.wasCharging = charging;

    this._renderBadge();
    if (this.onTelemetryChange) {
      this.onTelemetryChange(this.getSnapshot());
    }

    // Şarj tekrar gelirse düşük pil uyarısını yeniden kur
    if (charging || pct >= TELEMETRY_CONFIG.REARM_BATTERY_THRESHOLD) {
      this.lowBatteryAlerted = false;
    }

    // Şarjdan çıktıysa (olası elektrik kesintisi) uyar
    if (fromEvent && prevCharging === true && charging === false) {
      const msg = `⚡ ${appState.currentRoom.toUpperCase()} kamerası şarjdan ayrıldı (Pil: %${pct}). Elektrik kesintisi veya kablo kopması olabilir.`;
      addAlarmLog(`Şarj kesildi (Pil: %${pct})`);
      this._sendPowerAlert(msg);
    }

    // Pil kritik seviyeye indiyse (şarjda değilken) bir kez uyar
    if (!charging && pct <= TELEMETRY_CONFIG.LOW_BATTERY_THRESHOLD && !this.lowBatteryAlerted) {
      this.lowBatteryAlerted = true;
      const msg = `🪫 DÜŞÜK PİL UYARISI: ${appState.currentRoom.toUpperCase()} kamerası %${pct} pil seviyesinde (şarjda değil).`;
      addAlarmLog(`Düşük pil uyarısı (%${pct})`);
      this._sendPowerAlert(msg);
    }
  }

  _renderBadge() {
    const badge = $("batteryBadge");
    if (!badge || this.batteryPct === null) return;
    badge.classList.remove("hidden");
    const icon = this.charging ? "⚡" : this.batteryPct <= TELEMETRY_CONFIG.LOW_BATTERY_THRESHOLD ? "🪫" : "🔋";
    badge.textContent = `${icon} %${this.batteryPct}`;
    badge.style.color =
      !this.charging && this.batteryPct <= 20
        ? "#fca5a5"
        : this.charging
          ? "#86efac"
          : "";
  }

  async _sendPowerAlert(text) {
    const { token, chatId, configured } = getTelegramCredentials();
    if (!configured) return;
    try {
      const nowStr = new Date().toLocaleString("tr-TR");
      await sendTelegramMessage({
        token,
        chatId,
        text: `${text}\n🕒 ${nowStr}`
      });
    } catch (_) {}
  }
}

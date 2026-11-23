// Kare farkı hareket algılama, kalibrasyon ve Telegram alarm yöneticisi

import { MOTION_CONFIG } from "../config.js";
import { $, appState, addAlarmLog, captureStampedCanvas } from "../state.js";
import { getTelegramCredentials, sendTelegramPhoto } from "../services/telegram.js";

export class MotionDetector {
  constructor({ getStream, clipRecorder, onMetaSync }) {
    this.getStream = getStream;
    this.clipRecorder = clipRecorder;
    this.onMetaSync = onMetaSync;

    const totalPixels = MOTION_CONFIG.WIDTH * MOTION_CONFIG.HEIGHT;
    this.motionCanvas = document.createElement("canvas");
    this.motionCanvas.width = MOTION_CONFIG.WIDTH;
    this.motionCanvas.height = MOTION_CONFIG.HEIGHT;
    this.motionCtx = this.motionCanvas.getContext("2d", { willReadFrequently: true });

    // Çift buffer kullanarak GC baskısını azalt
    this.grayBufA = new Uint8Array(totalPixels);
    this.grayBufB = new Uint8Array(totalPixels);
    this.hasPrevFrame = false;

    this.enabled = false;
    this.timer = null;
    this.consecutiveHits = 0;
    this.muteUntil = 0;
    this.lastAlertSentAt = 0;
    this.isSendingPhoto = false;
    this.badgeTimeout = null;

    this._loadSettings();
    this._bindEvents();
  }

  _bindEvents() {
    ["tgTokenInput", "tgChatIdInput", "clipDurationSelect", "cooldownSelect"].forEach((id) => {
      $(id).addEventListener("change", () => this.saveSettings());
    });

    $("alarmModeSelect").addEventListener("change", () => {
      this._updateModeControls();
      this.saveSettings();
      if (this.enabled) this.updateUI(true);
      this.onMetaSync();
    });

    $("motionThresholdRange").addEventListener("input", () => {
      this._updateThresholdVisual();
      this.saveSettings();
    });

    $("toggleMotionBtn").addEventListener("click", () => {
      if (this.enabled) {
        this.stop(false);
        $("motionStatusMsg").textContent = "Hareket algılama durduruldu.";
      } else {
        this.start(false);
      }
    });

    $("testPhotoBtn").addEventListener("click", () => {
      this.saveSettings();
      this.captureAndSendPhoto(0, true, false);
    });

    $("testVideoBtn").addEventListener("click", () => {
      this.saveSettings();
      this.clipRecorder.recordAndSend(0, 5, true);
    });
  }

  _loadSettings() {
    $("tgTokenInput").value = localStorage.getItem("cam_tg_token") || "";
    $("tgChatIdInput").value = localStorage.getItem("cam_tg_chat_id") || "";
    $("alarmModeSelect").value = localStorage.getItem("cam_alarm_mode") || "hybrid";
    $("clipDurationSelect").value = localStorage.getItem("cam_clip_duration") || "10";
    $("motionThresholdRange").value = localStorage.getItem("cam_motion_threshold") || "4";
    $("cooldownSelect").value = localStorage.getItem("cam_motion_cooldown") || "30";
    const savedRoom = localStorage.getItem("cam_last_room");
    if (savedRoom) $("roomInput").value = savedRoom;
    this._updateThresholdVisual();
    this._updateModeControls();
  }

  saveSettings() {
    localStorage.setItem("cam_tg_token", $("tgTokenInput").value.trim());
    localStorage.setItem("cam_tg_chat_id", $("tgChatIdInput").value.trim());
    localStorage.setItem("cam_alarm_mode", $("alarmModeSelect").value);
    localStorage.setItem("cam_clip_duration", $("clipDurationSelect").value);
    localStorage.setItem("cam_motion_threshold", $("motionThresholdRange").value);
    localStorage.setItem("cam_motion_cooldown", $("cooldownSelect").value);
  }

  _updateModeControls() {
    $("clipDurationSelect").disabled = $("alarmModeSelect").value === "photo";
  }

  _updateThresholdVisual() {
    const val = parseFloat($("motionThresholdRange").value);
    $("thresholdValLabel").textContent = `%${val}`;
    const markerPct = Math.min(100, (val / 20) * 100);
    $("motionMeterThreshold").style.left = `${markerPct}%`;
  }

  pauseTemporarily(ms = 3000) {
    this.hasPrevFrame = false;
    this.consecutiveHits = 0;
    this.muteUntil = Date.now() + ms;
  }

  updateUI(active) {
    if (active) {
      const modeVal = $("alarmModeSelect").value;
      const modeLabel = modeVal === "hybrid" ? "Hibrit" : modeVal === "video" ? "Video" : "Fotoğraf";
      $("motionDot").className = "dot live";
      $("motionStateText").textContent = `Aktif (${modeLabel})`;
      $("toggleMotionBtn").textContent = "Hareket Algılamayı Durdur";
      $("toggleMotionBtn").className = "warn";
      $("blackoutMotionState").textContent = `Aktif (${modeLabel})`;
    } else {
      $("motionDot").className = "dot";
      $("motionStateText").textContent = "Pasif";
      $("toggleMotionBtn").textContent = "Hareket Algılamayı Başlat";
      $("toggleMotionBtn").className = "success";
      $("blackoutMotionState").textContent = "Pasif";
      $("motionMeterFill").style.width = "0%";
      $("liveMotionPct").textContent = "%0.0";
    }
  }

  start(isRemote = false) {
    if (this.enabled || !this.getStream()) return;
    this.saveSettings();
    this.enabled = true;
    this.pauseTemporarily(3000);
    this.updateUI(true);
    $("motionStatusMsg").textContent =
      "Kamera ışığı dengeleniyor (3 sn), ardından hareket takibi başlayacak...";
    this.timer = setInterval(() => this._analyzeFrame(), MOTION_CONFIG.CHECK_INTERVAL_MS);
    this.onMetaSync({
      lastEvent: isRemote
        ? "Hareket alarmı uzaktan açıldı."
        : "Hareket alarmı kamera cihazından açıldı.",
      lastEventAt: Date.now()
    });
  }

  stop(isRemote = false) {
    const wasEnabled = this.enabled;
    this.enabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.hasPrevFrame = false;
    this.consecutiveHits = 0;
    $("motionAlertBadge").classList.add("hidden");
    this.updateUI(false);
    if (wasEnabled) {
      this.onMetaSync({
        lastEvent: isRemote ? "Hareket alarmı uzaktan kapatıldı." : "Hareket alarmı kapatıldı.",
        lastEventAt: Date.now()
      });
    }
  }

  _analyzeFrame() {
    const video = $("localVideo");
    if (!this.enabled || !video || video.readyState < 2 || video.videoWidth === 0) return;

    const { WIDTH, HEIGHT, PIXEL_DIFF_LIMIT, REQUIRED_CONSECUTIVE } = MOTION_CONFIG;
    const totalPixels = WIDTH * HEIGHT;
    const now = Date.now();

    this.motionCtx.drawImage(video, 0, 0, WIDTH, HEIGHT);
    const pixels = this.motionCtx.getImageData(0, 0, WIDTH, HEIGHT).data;
    const currGray = this.grayBufA;
    const prevGray = this.grayBufB;

    for (let i = 0, p = 0; i < totalPixels; i++, p += 4) {
      currGray[i] = (pixels[p] + (pixels[p + 1] << 1) + pixels[p + 2]) >> 2;
    }

    if (now < this.muteUntil) {
      this._swapBuffers();
      this.hasPrevFrame = true;
      return;
    }

    if (!this.hasPrevFrame) {
      this._swapBuffers();
      this.hasPrevFrame = true;
      $("motionStatusMsg").textContent =
        "Hareket algılama devrede. Eşik aşılınca seçili Telegram bildirimi gönderilir.";
      return;
    }

    let changed = 0;
    for (let i = 0; i < totalPixels; i++) {
      if (Math.abs(currGray[i] - prevGray[i]) > PIXEL_DIFF_LIMIT) changed++;
    }
    this._swapBuffers();

    const changePct = (changed / totalPixels) * 100;
    const thresholdPct = parseFloat($("motionThresholdRange").value);

    $("liveMotionPct").textContent = `%${changePct.toFixed(1)}`;
    const fillWidth = Math.min(100, (changePct / 20) * 100);
    $("motionMeterFill").style.width = `${fillWidth}%`;
    $("motionMeterFill").style.background =
      changePct >= thresholdPct ? "var(--danger)" : "var(--success)";

    if (changePct >= thresholdPct) this.consecutiveHits++;
    else this.consecutiveHits = 0;

    if (this.consecutiveHits >= REQUIRED_CONSECUTIVE) {
      this.consecutiveHits = 0;
      this._handleTriggered(changePct);
    }
  }

  _swapBuffers() {
    const tmp = this.grayBufA;
    this.grayBufA = this.grayBufB;
    this.grayBufB = tmp;
  }

  _handleTriggered(changePct) {
    $("motionAlertBadge").classList.remove("hidden");
    clearTimeout(this.badgeTimeout);
    this.badgeTimeout = setTimeout(() => {
      $("motionAlertBadge").classList.add("hidden");
    }, 3000);

    if (this.clipRecorder.isRecording) return;

    const cooldownMs = parseInt($("cooldownSelect").value, 10) * 1000;
    const now = Date.now();
    if (now - this.lastAlertSentAt < cooldownMs) {
      const kalan = Math.ceil((cooldownMs - (now - this.lastAlertSentAt)) / 1000);
      $("motionStatusMsg").textContent = `Hareket (%${changePct.toFixed(1)}) görüldü; bekleme süresi nedeniyle bekleniyor (${kalan} sn).`;
      return;
    }

    const { configured } = getTelegramCredentials();
    if (!configured) {
      $("motionStatusMsg").textContent = `Hareket (%${changePct.toFixed(1)}) algılandı ancak Telegram Token/Chat ID girilmemiş.`;
      addAlarmLog(`Hareket (%${changePct.toFixed(1)}) - Telegram ayarı eksik`);
      this.lastAlertSentAt = now;
      return;
    }

    this.lastAlertSentAt = now;
    const mode = $("alarmModeSelect").value;
    const durationSec = parseInt($("clipDurationSelect").value, 10) || 10;

    if (mode === "hybrid") {
      this.captureAndSendPhoto(changePct, false, true);
      this.clipRecorder.recordAndSend(changePct, durationSec, false);
    } else if (mode === "photo") {
      this.captureAndSendPhoto(changePct, false, false);
    } else if (mode === "video") {
      this.clipRecorder.recordAndSend(changePct, durationSec, false);
    }
  }

  async captureAndSendPhoto(changePct, isTest = false, isHybrid = false) {
    if (this.isSendingPhoto) return;
    const { token, chatId, configured } = getTelegramCredentials();
    if (!configured) {
      $("motionStatusMsg").textContent = "Lütfen önce Telegram Bot Token ve Chat ID alanlarını doldur.";
      return;
    }

    this.isSendingPhoto = true;
    if (!isHybrid) {
      $("motionStatusMsg").textContent = isTest
        ? "Test fotoğrafı Telegram'a gönderiliyor..."
        : "Hareket algılandı! Anlık fotoğraf gönderiliyor...";
    }

    try {
      const room = appState.currentRoom;
      const stamped = captureStampedCanvas(
        $("localVideo"),
        room,
        1280,
        isTest ? "TEST" : `Hareket: %${changePct.toFixed(1)}`
      );
      if (!stamped) throw new Error("Kamera görüntüsü henüz hazır değil.");

      const blob = await new Promise((resolve) => stamped.canvas.toBlob(resolve, "image/jpeg", 0.82));
      if (!blob) throw new Error("Fotoğraf oluşturulamadı.");

      const caption = isTest
        ? `✅ [TEST] ${room.toUpperCase()} kamerası fotoğraf bağlantısı başarılı.\n🕒 ${stamped.nowStr}`
        : isHybrid
          ? `🚨 HAREKET ALGILANDI! (Video kaydediliyor...)\n📍 Oda: ${room.toUpperCase()}\n📊 Değişim: %${changePct.toFixed(1)}\n🕒 ${stamped.nowStr}`
          : `🚨 HAREKET ALGILANDI!\n📍 Oda: ${room.toUpperCase()}\n📊 Değişim: %${changePct.toFixed(1)}\n🕒 ${stamped.nowStr}`;

      await sendTelegramPhoto({
        token,
        chatId,
        blob,
        filename: `cam_${room}_${Date.now()}.jpg`,
        caption
      });

      const kb = Math.round(blob.size / 1024);
      const timeOnly = new Date().toTimeString().slice(0, 5);
      if (isTest) {
        $("motionStatusMsg").textContent = `Test fotoğrafı gönderildi (${kb} KB).`;
        addAlarmLog(`Test fotoğrafı gönderildi (${kb} KB)`);
      } else if (isHybrid) {
        addAlarmLog(`1/2 Anlık fotoğraf gönderildi (%${changePct.toFixed(1)} • ${kb} KB)`);
      } else {
        $("motionStatusMsg").textContent = `Alarm fotoğrafı gönderildi (${timeOnly} • %${changePct.toFixed(1)}).`;
        $("blackoutMotionState").textContent = `Aktif (Son Alarm: ${timeOnly})`;
        addAlarmLog(`Fotoğraf alarmı gönderildi (%${changePct.toFixed(1)} • ${kb} KB)`);
      }
    } catch (err) {
      if (!isHybrid) $("motionStatusMsg").textContent = "Telegram fotoğraf hatası: " + err.message;
      addAlarmLog("Fotoğraf hatası: " + err.message);
    } finally {
      this.isSendingPhoto = false;
    }
  }
}

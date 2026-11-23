// Kare farkı hareket algılama (ışık/pozlama normalizasyonu + 8×6 ROI bölge maskeleme)
// ve Telegram alarm yöneticisi

import { MOTION_CONFIG, STORAGE_KEYS } from "../config.js";
import { $, appState, addAlarmLog, captureStampedCanvas } from "../state.js";
import { getTelegramCredentials, sendTelegramPhoto } from "../services/telegram.js";

export class MotionDetector {
  constructor({ getStream, clipRecorder, onMetaSync }) {
    this.getStream = getStream;
    this.clipRecorder = clipRecorder;
    this.onMetaSync = onMetaSync;

    const { WIDTH, HEIGHT, ROI_COLS, ROI_ROWS } = MOTION_CONFIG;
    const totalPixels = WIDTH * HEIGHT;
    this.totalCells = ROI_COLS * ROI_ROWS;

    this.motionCanvas = document.createElement("canvas");
    this.motionCanvas.width = WIDTH;
    this.motionCanvas.height = HEIGHT;
    this.motionCtx = this.motionCanvas.getContext("2d", { willReadFrequently: true });

    // Çift buffer (GC baskısını azaltır)
    this.grayBufA = new Uint8Array(totalPixels);
    this.grayBufB = new Uint8Array(totalPixels);
    this.hasPrevFrame = false;

    // 8×6 ROI maskesi (1 = izle, 0 = hariç tut) ve piksel düzeyi önbellek
    this.roiCells = new Uint8Array(this.totalCells).fill(1);
    this.pixelMask = new Uint8Array(totalPixels).fill(1);
    this.activePixelCount = totalPixels;
    this.roiEditOpen = false;

    this.lightCompensation = true;
    this.enabled = false;
    this.timer = null;
    this.consecutiveHits = 0;
    this.muteUntil = 0;
    this.lastAlertSentAt = 0;
    this.isSendingPhoto = false;
    this.badgeTimeout = null;

    this._loadSettings();
    this._buildRoiGridUI();
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

    $("lightCompCheck").addEventListener("change", () => {
      this.lightCompensation = $("lightCompCheck").checked;
      localStorage.setItem(STORAGE_KEYS.LIGHT_COMP, this.lightCompensation ? "1" : "0");
    });

    $("toggleRoiEditBtn").addEventListener("click", () => {
      this.setRoiEditOpen(!this.roiEditOpen);
    });

    $("clearRoiBtn").addEventListener("click", () => {
      this.roiCells.fill(1);
      this._rebuildPixelMask();
      this._saveRoiMask();
      this._renderRoiGridUI();
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

    const savedLightComp = localStorage.getItem(STORAGE_KEYS.LIGHT_COMP);
    this.lightCompensation = savedLightComp !== "0";
    $("lightCompCheck").checked = this.lightCompensation;

    const savedRoi = localStorage.getItem(STORAGE_KEYS.ROI_MASK);
    if (savedRoi && savedRoi.length === this.totalCells) {
      for (let i = 0; i < this.totalCells; i++) {
        this.roiCells[i] = savedRoi[i] === "0" ? 0 : 1;
      }
    }
    this._rebuildPixelMask();

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

  _saveRoiMask() {
    let serialized = "";
    for (let i = 0; i < this.totalCells; i++) {
      serialized += this.roiCells[i] ? "1" : "0";
    }
    localStorage.setItem(STORAGE_KEYS.ROI_MASK, serialized);
  }

  _rebuildPixelMask() {
    const { WIDTH, HEIGHT, ROI_COLS, ROI_ROWS } = MOTION_CONFIG;
    const cellW = WIDTH / ROI_COLS;
    const cellH = HEIGHT / ROI_ROWS;
    let active = 0;

    for (let y = 0; y < HEIGHT; y++) {
      const r = Math.min(ROI_ROWS - 1, Math.floor(y / cellH));
      for (let x = 0; x < WIDTH; x++) {
        const c = Math.min(ROI_COLS - 1, Math.floor(x / cellW));
        const val = this.roiCells[r * ROI_COLS + c];
        this.pixelMask[y * WIDTH + x] = val;
        if (val) active++;
      }
    }
    this.activePixelCount = active;
  }

  _buildRoiGridUI() {
    const overlay = $("roiOverlay");
    if (!overlay) return;
    overlay.innerHTML = "";
    for (let idx = 0; idx < this.totalCells; idx++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "roi-cell";
      cell.dataset.idx = String(idx);
      cell.title = "Bölgeyi hareket algılamadan hariç tut / dahil et";
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        this.roiCells[idx] = this.roiCells[idx] ? 0 : 1;
        this._rebuildPixelMask();
        this._saveRoiMask();
        this._renderRoiGridUI();
      });
      overlay.appendChild(cell);
    }
    this._renderRoiGridUI();
  }

  _renderRoiGridUI() {
    const overlay = $("roiOverlay");
    let maskedCount = 0;
    if (overlay) {
      for (let idx = 0; idx < this.totalCells; idx++) {
        const isMasked = this.roiCells[idx] === 0;
        if (isMasked) maskedCount++;
        const cell = overlay.children[idx];
        if (cell) cell.classList.toggle("masked", isMasked);
      }
    }
    const summary = $("roiSummaryText");
    if (summary) {
      summary.textContent =
        maskedCount === 0
          ? "Tüm ekran izleniyor (0 bölge maskeli)"
          : `${maskedCount} / ${this.totalCells} bölge hariç tutuldu`;
    }
    $("clearRoiBtn").disabled = maskedCount === 0;
  }

  setRoiEditOpen(open) {
    this.roiEditOpen = Boolean(open);
    $("roiOverlay").classList.toggle("hidden", !this.roiEditOpen);
    $("toggleRoiEditBtn").textContent = this.roiEditOpen
      ? "Maske Düzenlemeyi Bitir"
      : "Bölge Maskesi (ROI)";
    $("toggleRoiEditBtn").className = this.roiEditOpen ? "warn compact" : "secondary compact";
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
    this.setRoiEditOpen(false);
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

    const activeCount = this.activePixelCount;
    if (activeCount === 0) {
      this._swapBuffers();
      $("liveMotionPct").textContent = "%0.0 (Maskeli)";
      $("motionMeterFill").style.width = "0%";
      return;
    }

    // Işık / oto-pozlama telafisi: aktif piksellerin ortalama parlaklık kaymasını çıkar
    let meanDelta = 0;
    if (this.lightCompensation) {
      let diffSum = 0;
      for (let i = 0; i < totalPixels; i++) {
        if (this.pixelMask[i]) {
          diffSum += currGray[i] - prevGray[i];
        }
      }
      meanDelta = diffSum / activeCount;
    }

    let changed = 0;
    for (let i = 0; i < totalPixels; i++) {
      if (!this.pixelMask[i]) continue;
      if (Math.abs((currGray[i] - prevGray[i]) - meanDelta) > PIXEL_DIFF_LIMIT) {
        changed++;
      }
    }
    this._swapBuffers();

    const changePct = (changed / activeCount) * 100;
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
      $("motionStatusMsg").textContent = `Hareket (%${changePct.toFixed(1)}) algılandı ancak Telegram ayarı (Proxy veya Token/Chat ID) yapılmamış.`;
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
      $("motionStatusMsg").textContent = "Lütfen önce Telegram Bot Token ve Chat ID alanlarını doldur (veya Proxy URL tanımla).";
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

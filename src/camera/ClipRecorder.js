// MediaRecorder video klip kaydı ve Telegram video gönderimi

import { LIMITS } from "../config.js";
import { $, appState, addAlarmLog } from "../state.js";
import { getTelegramCredentials, sendTelegramVideo } from "../services/telegram.js";

function getBestVideoMimeType(hasAudio) {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  const candidates = hasAudio
    ? [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4",
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp9,opus",
        "video/webm"
      ]
    : ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp8", "video/webm"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function createSafeRecorder(stream, mimeType) {
  const options = { videoBitsPerSecond: LIMITS.VIDEO_BITRATE_BPS };
  if (mimeType) options.mimeType = mimeType;
  try {
    return new MediaRecorder(stream, options);
  } catch (_) {
    return new MediaRecorder(stream);
  }
}

export class ClipRecorder {
  constructor({ getStream, onMetaSync, onRecordingFinished }) {
    this.getStream = getStream;
    this.onMetaSync = onMetaSync;
    this.onRecordingFinished = onRecordingFinished;

    this.isRecording = false;
    this.activeRecorder = null;
    this.abortFlag = false;
    this.countdownTimer = null;
  }

  abortIfActive() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    $("recAlertBadge").classList.add("hidden");
    if (this.activeRecorder && this.activeRecorder.state !== "inactive") {
      this.abortFlag = true;
      try { this.activeRecorder.stop(); } catch (_) {}
    }
  }

  async recordAndSend(changePct, durationSec = 10, isTest = false) {
    if (this.isRecording) {
      if (isTest) $("motionStatusMsg").textContent = "Şu anda başka bir video kaydı devam ediyor.";
      return;
    }

    const { token, chatId, configured } = getTelegramCredentials();
    if (!configured) {
      $("motionStatusMsg").textContent = "Lütfen önce Telegram Bot Token ve Chat ID alanlarını doldur.";
      return;
    }

    const stream = this.getStream();
    if (!stream || typeof MediaRecorder === "undefined") {
      $("motionStatusMsg").textContent = "Bu tarayıcı video kaydını (MediaRecorder) desteklemiyor.";
      addAlarmLog("Video hatası: MediaRecorder desteklenmiyor");
      return;
    }

    this.isRecording = true;
    this.abortFlag = false;
    $("testVideoBtn").disabled = true;
    this.onMetaSync();

    const hasAudio = stream.getAudioTracks().length > 0;
    const preferredMime = getBestVideoMimeType(hasAudio);

    try {
      const recorder = createSafeRecorder(stream, preferredMime);
      this.activeRecorder = recorder;
      const actualMime = recorder.mimeType || preferredMime || "video/webm";
      const isMp4 = actualMime.toLowerCase().includes("mp4");
      const ext = isMp4 ? "mp4" : "webm";
      const formatTag = isMp4 ? "MP4" : "WebM";

      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      let remaining = durationSec;
      $("recTimerText").textContent = `KAYIT: ${remaining} sn`;
      $("recAlertBadge").classList.remove("hidden");
      $("blackoutMotionState").textContent = `Kayıt alınıyor (${remaining} sn)...`;
      $("motionStatusMsg").textContent = isTest
        ? `Test videosu kaydediliyor (${durationSec} sn, ${formatTag})...`
        : `Hareket klibi kaydediliyor (${durationSec} sn, ${formatTag})...`;

      this.countdownTimer = setInterval(() => {
        remaining--;
        if (remaining > 0) {
          $("recTimerText").textContent = `KAYIT: ${remaining} sn`;
        } else {
          $("recTimerText").textContent = "YÜKLENİYOR...";
          clearInterval(this.countdownTimer);
          this.countdownTimer = null;
        }
      }, 1000);

      const clipBlob = await new Promise((resolve, reject) => {
        let stopTimer = null;
        recorder.onstop = () => {
          if (stopTimer) clearTimeout(stopTimer);
          if (this.abortFlag) {
            resolve(null);
            return;
          }
          resolve(new Blob(chunks, { type: actualMime }));
        };
        recorder.onerror = (e) => {
          if (stopTimer) clearTimeout(stopTimer);
          reject(e.error || new Error("Kayıt sırasında hata oluştu."));
        };

        recorder.start(1000);
        stopTimer = setTimeout(() => {
          if (recorder.state !== "inactive") recorder.stop();
        }, durationSec * 1000);
      });

      this.activeRecorder = null;
      if (this.countdownTimer) {
        clearInterval(this.countdownTimer);
        this.countdownTimer = null;
      }

      if (!clipBlob || this.abortFlag) return;
      if (clipBlob.size === 0) throw new Error("Boş video dosyası oluştu.");

      const sizeMb = (clipBlob.size / (1024 * 1024)).toFixed(2);
      $("motionStatusMsg").textContent = `Video Telegram'a yükleniyor (${sizeMb} MB, ${formatTag})...`;

      const videoEl = $("localVideo");
      const room = appState.currentRoom;
      const nowStr = new Date().toLocaleString("tr-TR");
      const caption = isTest
        ? `✅ [TEST] ${room.toUpperCase()} kamerası ${durationSec} sn video testi başarılı (${formatTag} • ${sizeMb} MB).\n🕒 ${nowStr}`
        : `🎥 HAREKET VİDEOSU (${durationSec} sn)\n📍 Oda: ${room.toUpperCase()}\n📊 Değişim: %${changePct.toFixed(1)}\n🕒 ${nowStr}`;

      await sendTelegramVideo({
        token,
        chatId,
        blob: clipBlob,
        filename: `cam_${room}_${Date.now()}.${ext}`,
        durationSec,
        width: videoEl?.videoWidth || 0,
        height: videoEl?.videoHeight || 0,
        caption
      });

      const timeOnly = new Date().toTimeString().slice(0, 5);
      if (isTest) {
        $("motionStatusMsg").textContent = `Test videosu gönderildi (${formatTag} • ${sizeMb} MB).`;
        addAlarmLog(`Test videosu gönderildi (${durationSec} sn • ${formatTag} • ${sizeMb} MB)`);
      } else {
        const prefix = $("alarmModeSelect").value === "hybrid" ? "2/2 " : "";
        $("motionStatusMsg").textContent = `Hareket videosu gönderildi (${timeOnly} • ${formatTag} • ${sizeMb} MB).`;
        $("blackoutMotionState").textContent = `Aktif (Son Alarm: ${timeOnly})`;
        addAlarmLog(`${prefix}Video gönderildi (${durationSec} sn • ${formatTag} • ${sizeMb} MB)`);
      }
    } catch (err) {
      $("motionStatusMsg").textContent = "Telegram video hatası: " + err.message;
      addAlarmLog("Video hatası: " + err.message);
    } finally {
      this.isRecording = false;
      this.activeRecorder = null;
      $("testVideoBtn").disabled = false;
      $("recAlertBadge").classList.add("hidden");
      this.onMetaSync();
      if (this.onRecordingFinished) this.onRecordingFinished();
    }
  }
}

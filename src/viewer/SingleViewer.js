// Tekli Büyük Ekran İzleyici, P2P DataChannel + RTDB Uzaktan Kontrol ve Snapshot Yöneticisi

import { DB_PATHS } from "../config.js";
import { $, appState } from "../state.js";
import { db, ref, push, onValue, serverTimestamp } from "../services/firebase.js";
import { ViewerPeerSession } from "../webrtc/ViewerPeerSession.js";

export class SingleViewer {
  constructor({ ptt }) {
    this.ptt = ptt;
    this.peerSession = null;
    this.activeSessionId = null;
    this.metaUnsub = null;
    this.snapUnsub = null;
    this.remoteMetaState = null;
    this.latestSnapshotDataUrl = null;
    this.latestSnapshotCapturedAt = 0;
    this.pendingP2pSnapshots = new Map();

    this._bindEvents();
  }

  _bindEvents() {
    $("reconnectBtn").addEventListener("click", () => {
      if (this.activeSessionId) this.connectToRoom(appState.currentRoom);
      else this.startWatchingRoom();
    });

    $("muteToggleBtn").addEventListener("click", () => {
      const vid = $("remoteVideo");
      vid.muted = !vid.muted;
      $("muteToggleBtn").textContent = vid.muted ? "Sesi Aç (Sessizde)" : "Sesi Kapat (Sesli)";
      vid.play().catch(() => {});
    });

    $("fullscreenBtn").addEventListener("click", () => {
      const vid = $("remoteVideo");
      if (vid.requestFullscreen) vid.requestFullscreen();
      else if (vid.webkitEnterFullscreen) vid.webkitEnterFullscreen();
    });

    $("remoteMotionBtn").addEventListener("click", () => {
      if (!this.remoteMetaState?.online) return;
      const nextState = !this.remoteMetaState.motionEnabled;
      this._sendRemoteCommand(
        { type: "set_motion", value: nextState },
        nextState
          ? "Hareket alarmını açma komutu gönderiliyor..."
          : "Hareket alarmını kapatma komutu gönderiliyor..."
      );
    });

    $("remoteSirenBtn").addEventListener("click", () => {
      if (!this.remoteMetaState?.online) return;
      const nextState = !this.remoteMetaState.sirenOn;
      this._sendRemoteCommand(
        { type: "set_siren", value: nextState },
        nextState ? "Siren çalma komutu gönderiliyor..." : "Sireni susturma komutu gönderiliyor..."
      );
    });

    $("remoteTorchBtn").addEventListener("click", () => {
      if (!this.remoteMetaState?.online || !this.remoteMetaState.torchSupported) return;
      const nextState = !this.remoteMetaState.torchOn;
      this._sendRemoteCommand(
        { type: "set_torch", value: nextState },
        nextState ? "Flaş açma komutu gönderiliyor..." : "Flaş kapatma komutu gönderiliyor..."
      );
    });

    $("remoteSnapshotBtn").addEventListener("click", () => {
      if (!this.remoteMetaState?.online) return;
      $("remoteSnapshotBtn").disabled = true;
      setTimeout(() => {
        if (this.remoteMetaState?.online) $("remoteSnapshotBtn").disabled = false;
      }, 2500);
      this._sendRemoteCommand(
        { type: "take_snapshot", sendTelegram: $("remoteSnapTelegramCheck").checked },
        "Anlık fotoğraf isteniyor..."
      );
    });

    $("downloadSnapshotBtn").addEventListener("click", () => {
      if (!this.latestSnapshotDataUrl) return;
      const a = document.createElement("a");
      a.href = this.latestSnapshotDataUrl;
      a.download = `kamera_${appState.currentRoom}_${this.latestSnapshotCapturedAt || Date.now()}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });

    $("hideSnapshotBtn").addEventListener("click", () => {
      $("remoteSnapshotBox").classList.add("hidden");
    });
  }

  setUIState(type, title, detail) {
    $("viewDot").className = "dot " + type;
    $("viewStateText").textContent = title;
    if (detail) $("viewStatus").textContent = detail;
  }

  resetSnapshotUI() {
    this.latestSnapshotDataUrl = null;
    this.latestSnapshotCapturedAt = 0;
    this.pendingP2pSnapshots.clear();
    $("remoteSnapshotBox").classList.add("hidden");
  }

  _displaySnapshot({ dataUrl, capturedAt, room, sentToTelegram, viaP2p = false }) {
    if (!dataUrl) return;
    this.latestSnapshotDataUrl = dataUrl;
    this.latestSnapshotCapturedAt = capturedAt || Date.now();
    $("remoteSnapshotImg").src = dataUrl;
    const timeStr = new Date(this.latestSnapshotCapturedAt).toLocaleTimeString("tr-TR");
    const viaTag = viaP2p ? " • P2P" : "";
    const tgTag = sentToTelegram ? " • Telegram'a da gönderildi" : "";
    $("remoteSnapshotMeta").textContent =
      `${(room || appState.currentRoom).toUpperCase()} Fotoğrafı • ${timeStr}${viaTag}${tgTag}`;
    $("remoteSnapshotBox").classList.remove("hidden");
  }

  _handleDataChannelMessage(msg) {
    if (!msg || msg.type !== "snap_chunk") return;
    const { id, index, total, data, meta } = msg;
    if (!id || typeof index !== "number" || typeof total !== "number" || total <= 0) return;

    let entry = this.pendingP2pSnapshots.get(id);
    if (!entry) {
      // Bellek sızıntısını önlemek için en fazla 3 yarım transfer tut
      if (this.pendingP2pSnapshots.size >= 3) {
        const oldestKey = this.pendingP2pSnapshots.keys().next().value;
        this.pendingP2pSnapshots.delete(oldestKey);
      }
      entry = { parts: new Array(total), received: 0, total, meta: null };
      this.pendingP2pSnapshots.set(id, entry);
    }

    if (meta) entry.meta = meta;
    if (entry.parts[index] === undefined) {
      entry.parts[index] = data;
      entry.received++;
    }

    if (entry.received === entry.total) {
      this.pendingP2pSnapshots.delete(id);
      const dataUrl = entry.parts.join("");
      this._displaySnapshot({
        dataUrl,
        capturedAt: entry.meta?.capturedAt || Date.now(),
        room: entry.meta?.room || appState.currentRoom,
        sentToTelegram: Boolean(entry.meta?.sentToTelegram),
        viaP2p: true
      });
    }
  }

  _updateChannelBadge(isOpen) {
    const badge = $("remoteChannelBadge");
    if (!badge) return;
    if (isOpen) {
      badge.textContent = "Kanal: P2P";
      badge.style.color = "#86efac";
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  updateRemoteControlUI(meta) {
    this.remoteMetaState = meta;
    const isOnline = Boolean(meta && meta.online);

    $("remoteMotionBtn").disabled = !isOnline;
    $("remoteSirenBtn").disabled = !isOnline;
    $("remoteSnapshotBtn").disabled = !isOnline;

    const batBadge = $("remoteBatteryBadge");

    if (!isOnline) {
      $("remoteMotionDot").className = "dot";
      $("remoteMotionBadgeText").textContent = "Alarm: Çevrimdışı";
      $("remoteSirenDot").className = "dot";
      $("remoteSirenBadgeText").textContent = "Siren: --";
      $("remoteTorchBadge").textContent = "Flaş: --";
      if (batBadge) batBadge.classList.add("hidden");
      $("remoteMotionBtn").textContent = "Hareket Alarmını Aç";
      $("remoteMotionBtn").className = "success";
      $("remoteSirenBtn").textContent = "Alarm Sirenini Çal";
      $("remoteSirenBtn").className = "secondary";
      $("remoteTorchBtn").textContent = "Flaşı Aç";
      $("remoteTorchBtn").disabled = true;
      $("remoteCtrlStatus").textContent =
        "Kamera çevrimiçi olduğunda uzaktan komutlar aktifleşir.";
      return;
    }

    const mOn = Boolean(meta.motionEnabled);
    $("remoteMotionDot").className = mOn ? "dot live" : "dot";
    $("remoteMotionBadgeText").textContent = mOn ? "Alarm: Aktif" : "Alarm: Pasif";
    $("remoteMotionBtn").textContent = mOn ? "Hareket Alarmını Kapat" : "Hareket Alarmını Aç";
    $("remoteMotionBtn").className = mOn ? "warn" : "success";

    const sOn = Boolean(meta.sirenOn);
    $("remoteSirenDot").className = sOn ? "dot err" : "dot";
    $("remoteSirenBadgeText").textContent = sOn ? "Siren: Çalıyor" : "Siren: Kapalı";
    $("remoteSirenBtn").textContent = sOn ? "Sireni Sustur" : "Alarm Sirenini Çal";
    $("remoteSirenBtn").className = sOn ? "danger" : "secondary";

    const tSupported = Boolean(meta.torchSupported);
    const tOn = Boolean(meta.torchOn);
    if (!tSupported) {
      $("remoteTorchBadge").textContent = "Flaş: Yok";
      $("remoteTorchBtn").textContent = "Flaş Desteklenmiyor";
      $("remoteTorchBtn").className = "secondary";
      $("remoteTorchBtn").disabled = true;
    } else {
      $("remoteTorchBadge").textContent = tOn ? "Flaş: Açık" : "Flaş: Kapalı";
      $("remoteTorchBtn").textContent = tOn ? "Flaşı Kapat" : "Flaşı Aç";
      $("remoteTorchBtn").className = tOn ? "warn" : "secondary";
      $("remoteTorchBtn").disabled = false;
    }

    if (batBadge) {
      if (typeof meta.batteryPct === "number") {
        const icon = meta.charging ? "⚡" : meta.batteryPct <= 15 ? "🪫" : "🔋";
        batBadge.textContent = `${icon} %${meta.batteryPct}`;
        batBadge.style.color =
          !meta.charging && meta.batteryPct <= 20
            ? "#fca5a5"
            : meta.charging
              ? "#86efac"
              : "";
        batBadge.classList.remove("hidden");
      } else {
        batBadge.classList.add("hidden");
      }
    }

    if (meta.lastEvent) {
      const timeTag = meta.lastEventAt
        ? ` (${new Date(meta.lastEventAt).toLocaleTimeString("tr-TR")})`
        : "";
      $("remoteCtrlStatus").textContent = `Kamera: ${meta.lastEvent}${timeTag}`;
    }
  }

  async _sendRemoteCommand(payload, pendingMsg) {
    if (!this.remoteMetaState || !this.remoteMetaState.online || !appState.currentUser) return;
    $("remoteCtrlStatus").textContent = pendingMsg;

    // 1) Öncelik: P2P RTCDataChannel (milisaniye gecikme, sıfır RTDB yazma)
    if (this.peerSession?.sendDataMessage(payload)) {
      return;
    }

    // 2) Yedek: Firebase RTDB komut kuyruğu
    try {
      await push(ref(db, DB_PATHS.roomCommands(appState.currentUser.uid, appState.currentRoom)), {
        ...payload,
        requestedBy: appState.currentUser.email || "izleyici",
        createdAt: serverTimestamp()
      });
    } catch (err) {
      $("remoteCtrlStatus").textContent = "Komut gönderilemedi: " + err.message;
    }
  }

  startWatchingRoom() {
    this._stopRoomListeners();
    this.activeSessionId = null;
    if (!appState.currentUser) return;

    const uid = appState.currentUser.uid;
    const watchedRoom = appState.currentRoom;

    this.metaUnsub = onValue(ref(db, DB_PATHS.roomMeta(uid, watchedRoom)), (snap) => {
      if (
        appState.activeRole !== "viewer" ||
        appState.viewerMode !== "single" ||
        appState.currentRoom !== watchedRoom
      ) {
        return;
      }
      const meta = snap.val();
      this.updateRemoteControlUI(meta);

      if (!meta || !meta.online) {
        this.disconnectPeer();
        this.activeSessionId = null;
        this.setUIState(
          "warn",
          "Kamera Çevrimdışı",
          `${watchedRoom} kamerası yayına geçtiğinde bağlantı otomatik kurulacak...`
        );
        return;
      }

      if (meta.sessionId !== this.activeSessionId) {
        this.activeSessionId = meta.sessionId;
        this.connectToRoom(watchedRoom);
      }
    });

    this.snapUnsub = onValue(ref(db, DB_PATHS.roomSnapshot(uid, watchedRoom)), (snap) => {
      if (
        appState.activeRole !== "viewer" ||
        appState.viewerMode !== "single" ||
        appState.currentRoom !== watchedRoom
      ) {
        return;
      }
      const data = snap.val();
      if (!data || !data.dataUrl) return;
      this._displaySnapshot({
        dataUrl: data.dataUrl,
        capturedAt: data.capturedAt,
        room: watchedRoom,
        sentToTelegram: Boolean(data.sentToTelegram),
        viaP2p: false
      });
    });
  }

  async connectToRoom(targetRoom = appState.currentRoom) {
    await this.disconnectPeer();
    if (
      !appState.currentUser ||
      appState.activeRole !== "viewer" ||
      appState.viewerMode !== "single" ||
      appState.currentRoom !== targetRoom
    ) {
      return;
    }

    this.setUIState("warn", "Bağlanıyor...", `${targetRoom} kamerası ile şifreli P2P tüneli kuruluyor...`);

    const peerSession = new ViewerPeerSession({
      roomName: targetRoom,
      uid: appState.currentUser.uid,
      idPrefix: "v",
      profile: "single",
      onStream: (stream) => {
        const remoteVideo = $("remoteVideo");
        if (remoteVideo.srcObject !== stream) {
          remoteVideo.srcObject = stream;
          remoteVideo.play().catch(() => {});
        }
      },
      onRemoteOfferApplied: async (pc) => {
        await this.ptt.attachToPeer(pc);
      },
      onDataChannelState: (isOpen) => {
        this._updateChannelBadge(isOpen);
      },
      onDataMessage: (msg) => {
        this._handleDataChannelMessage(msg);
      },
      onIceStateChange: (st) => {
        if (st === "connected" || st === "completed") {
          this.setUIState("live", "Canlı", `${targetRoom} kamerasına bağlantı aktif.`);
          this.ptt.onConnectionLive();
        } else if (st === "disconnected") {
          this.ptt.onConnectionLost();
          this.setUIState("warn", "Kesinti", "Bağlantı zayıfladı, toparlanma bekleniyor...");
        } else if (st === "failed") {
          this.ptt.onConnectionLost();
          this.setUIState(
            "err",
            "Bağlantı Hatası",
            "Otomatik yeniden bağlanma başarısız oldu. Mobil veride CGNAT engeli olabilir; Kurulum ekranından TURN sunucusu ekleyip tekrar deneyin."
          );
        }
      },
      onStatsReady: (stats) => {
        const rttTag = stats.rttMs !== null ? ` • ${stats.rttMs} ms` : "";
        const modeDesc =
          stats.mode === "TURN"
            ? "TURN aktarmalı (CGNAT aşımı aktif)"
            : "doğrudan P2P";
        this.setUIState(
          "live",
          `Canlı (${stats.mode}${rttTag})`,
          `${targetRoom} kamerasına ${modeDesc} bağlantı aktif.`
        );
      },
      onReconnecting: (attempt, maxRetries) => {
        this.ptt.onConnectionLost();
        this.setUIState(
          "warn",
          `Yeniden Bağlanıyor (${attempt}/${maxRetries})...`,
          `${targetRoom} kamerası ile bağlantı kesildi; otomatik yeniden kuruluyor...`
        );
      },
      onRejected: (errObj) => {
        this.ptt.onConnectionLost();
        const detail = errObj?.message || "Maksimum izleyici sınırına ulaşıldı.";
        this.setUIState("err", "Oda Dolu", detail);
      },
      onError: (err) => {
        this.setUIState("err", "El Sıkışma Hatası", err.message);
      }
    });

    this.peerSession = peerSession;
    await peerSession.connect();
  }

  _stopRoomListeners() {
    if (this.metaUnsub) {
      this.metaUnsub();
      this.metaUnsub = null;
    }
    if (this.snapUnsub) {
      this.snapUnsub();
      this.snapUnsub = null;
    }
  }

  async disconnectPeer() {
    this.ptt.detachSender();
    this._updateChannelBadge(false);
    this.pendingP2pSnapshots.clear();
    $("remoteVideo").srcObject = null;
    if (this.peerSession) {
      const session = this.peerSession;
      this.peerSession = null;
      await session.disconnect();
    }
  }

  async stop() {
    this._stopRoomListeners();
    this.activeSessionId = null;
    this.remoteMetaState = null;
    await this.disconnectPeer();
  }

  removeOnUnload() {
    this.peerSession?.removeOnUnload();
  }
}

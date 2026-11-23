// Kamera (Yayıncı) Modu — 1-to-N P2P, .info/connected otomatik kurtarma, oda çakışma koruması,
// MAX_VIEWERS dolu bildirimi, flaş, kamera değişimi ve uzaktan komutlar

import { LIMITS, VIDEO_PROFILES, DATACHANNEL_CONFIG, DB_PATHS } from "../config.js";
import { $, appState, sanitizeRoom, showSection, addAlarmLog, captureStampedCanvas } from "../state.js";
import {
  db,
  ref,
  set,
  update,
  push,
  remove,
  onValue,
  onChildAdded,
  onChildRemoved,
  onDisconnect,
  serverTimestamp
} from "../services/firebase.js";
import { getRtcConfig } from "../services/iceConfig.js";
import { getTelegramCredentials, sendTelegramPhoto } from "../services/telegram.js";
import { SirenEngine } from "./SirenEngine.js";
import { WakeLockBlackout } from "./WakeLockBlackout.js";
import { ClipRecorder } from "./ClipRecorder.js";
import { MotionDetector } from "./MotionDetector.js";
import { DeviceTelemetry } from "./DeviceTelemetry.js";

export class CameraController {
  constructor() {
    this.localStream = null;
    this.activeSessionId = null;
    this.activeUid = null;
    this.activeRoom = null;
    this.isNetworkOffline = false;
    this.sessionTakenOver = false;

    this.facingMode = "environment";
    this.torchOn = false;
    this.torchSupported = false;
    this.unsubs = [];
    this.peers = new Map();

    this.wakeLockBlackout = new WakeLockBlackout();
    this.siren = new SirenEngine({
      onMetaSync: (extra) => this.syncMeta(extra)
    });
    this.clipRecorder = new ClipRecorder({
      getStream: () => this.localStream,
      onMetaSync: (extra) => this.syncMeta(extra),
      onRecordingFinished: () => {
        if (this.motion.enabled && $("blackoutMotionState").textContent.startsWith("Kayıt")) {
          this.motion.updateUI(true);
        }
      }
    });
    this.motion = new MotionDetector({
      getStream: () => this.localStream,
      clipRecorder: this.clipRecorder,
      onMetaSync: (extra) => this.syncMeta(extra)
    });
    this.telemetry = new DeviceTelemetry({
      onTelemetryChange: () => this.syncMeta()
    });

    this._bindEvents();
  }

  _bindEvents() {
    $("startCameraBtn").addEventListener("click", () => this.start());
    $("stopCameraBtn").addEventListener("click", async () => {
      await this.stop();
      appState.activeRole = null;
      showSection("setupView");
    });
    $("switchCamBtn").addEventListener("click", () => this.switchCamera());
    $("torchBtn").addEventListener("click", () => this.setTorchState(!this.torchOn, false));
  }

  async _getCameraStream(withAudio = $("audioCheck").checked) {
    const is720 = $("qualitySelect").value === "720p";
    const constraints = {
      video: {
        facingMode: { ideal: this.facingMode },
        width: { ideal: is720 ? 1280 : 854 },
        height: { ideal: is720 ? 720 : 480 },
        frameRate: { ideal: 12, max: 15 }
      },
      audio: withAudio
        ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        : false
    };
    return await navigator.mediaDevices.getUserMedia(constraints);
  }

  _updateTorchAvailability() {
    const videoTrack = this.localStream?.getVideoTracks()[0];
    const caps = videoTrack?.getCapabilities ? videoTrack.getCapabilities() : {};
    this.torchSupported = Boolean(caps.torch);
    this.torchOn = false;
    if (this.torchSupported) {
      $("torchBtn").classList.remove("hidden");
      $("torchBtn").textContent = "Flaş: Kapalı";
    } else {
      $("torchBtn").classList.add("hidden");
    }
  }

  syncDirectory() {
    if (
      appState.activeRole !== "camera" ||
      this.sessionTakenOver ||
      !this.activeSessionId ||
      !this.activeUid ||
      !this.activeRoom
    ) {
      return;
    }
    const { batteryPct, charging } = this.telemetry.getSnapshot();
    update(ref(db, DB_PATHS.roomDir(this.activeUid, this.activeRoom)), {
      room: this.activeRoom,
      online: true,
      quality: $("qualitySelect").value,
      motionEnabled: this.motion.enabled,
      sirenOn: this.siren.isActive,
      viewerCount: this.peers.size,
      batteryPct,
      charging,
      updatedAt: serverTimestamp()
    }).catch(() => {});
  }

  syncMeta(extra = {}) {
    if (
      appState.activeRole !== "camera" ||
      this.sessionTakenOver ||
      !this.activeSessionId ||
      !this.activeUid ||
      !this.activeRoom
    ) {
      return;
    }
    const { batteryPct, charging } = this.telemetry.getSnapshot();
    update(ref(db, DB_PATHS.roomMeta(this.activeUid, this.activeRoom)), {
      motionEnabled: this.motion.enabled,
      torchOn: this.torchOn,
      torchSupported: this.torchSupported,
      sirenOn: this.siren.isActive,
      isRecording: this.clipRecorder.isRecording,
      alarmMode: $("alarmModeSelect").value,
      batteryPct,
      charging,
      updatedAt: serverTimestamp(),
      ...extra
    }).catch(() => {});
    this.syncDirectory();
  }

  _updateViewerCountUI() {
    const count = this.peers.size;
    $("viewerCount").textContent = String(count);
    $("blackoutViewers").textContent = String(count);
    this.syncDirectory();
  }

  async _publishPresence({ isReconnect = false } = {}) {
    const uid = this.activeUid;
    const room = this.activeRoom;
    const sessionId = this.activeSessionId;
    if (!uid || !room || !sessionId || this.sessionTakenOver || appState.activeRole !== "camera") {
      return;
    }

    const metaRef = ref(db, DB_PATHS.roomMeta(uid, room));
    const viewersRef = ref(db, DB_PATHS.roomViewers(uid, room));
    const commandsRef = ref(db, DB_PATHS.roomCommands(uid, room));
    const snapshotRef = ref(db, DB_PATHS.roomSnapshot(uid, room));
    const dirRef = ref(db, DB_PATHS.roomDir(uid, room));

    // Her bağlantıda sunucu tarafı onDisconnect kancalarını tazele
    await Promise.all([
      onDisconnect(metaRef).remove(),
      onDisconnect(viewersRef).remove(),
      onDisconnect(commandsRef).remove(),
      onDisconnect(snapshotRef).remove(),
      onDisconnect(dirRef).remove()
    ]);

    if (sessionId !== this.activeSessionId || this.sessionTakenOver) return;

    const { batteryPct, charging } = this.telemetry.getSnapshot();
    await Promise.all([
      set(metaRef, {
        online: true,
        sessionId,
        quality: $("qualitySelect").value,
        motionEnabled: this.motion.enabled,
        torchOn: this.torchOn,
        torchSupported: this.torchSupported,
        sirenOn: this.siren.isActive,
        isRecording: this.clipRecorder.isRecording,
        alarmMode: $("alarmModeSelect").value,
        batteryPct,
        charging,
        lastEvent: isReconnect
          ? "Ağ kesintisi sonrası kamera otomatik yeniden bağlandı."
          : "Kamera yayına başladı.",
        lastEventAt: Date.now(),
        updatedAt: serverTimestamp()
      }),
      set(dirRef, {
        room,
        online: true,
        quality: $("qualitySelect").value,
        motionEnabled: this.motion.enabled,
        sirenOn: this.siren.isActive,
        viewerCount: this.peers.size,
        batteryPct,
        charging,
        updatedAt: serverTimestamp()
      })
    ]);
  }

  async _cancelOnDisconnectHooks(uid, room) {
    if (!uid || !room) return;
    await Promise.all([
      onDisconnect(ref(db, DB_PATHS.roomMeta(uid, room))).cancel().catch(() => {}),
      onDisconnect(ref(db, DB_PATHS.roomViewers(uid, room))).cancel().catch(() => {}),
      onDisconnect(ref(db, DB_PATHS.roomCommands(uid, room))).cancel().catch(() => {}),
      onDisconnect(ref(db, DB_PATHS.roomSnapshot(uid, room))).cancel().catch(() => {}),
      onDisconnect(ref(db, DB_PATHS.roomDir(uid, room))).cancel().catch(() => {})
    ]);
  }

  async _handleSessionTakenOver(room) {
    if (this.sessionTakenOver) return;
    this.sessionTakenOver = true;

    const uid = this.activeUid;
    // Eski cihaz kapanırken yeni cihazın RTDB kaydını silmesin diye onDisconnect kancalarını iptal et
    await this._cancelOnDisconnectHooks(uid, room);
    await this.stop({ skipDbCleanup: true });
    appState.activeRole = null;

    $("camDot").className = "dot err";
    $("camStatus").textContent =
      `Oda çakışması: "${room}" odası başka bir cihaz tarafından devralındı; bu cihazdaki yayın durduruldu.`;
    addAlarmLog(`Oda "${room}" başka cihazdan açıldığı için bu yayın durduruldu`);
  }

  async start() {
    if (!appState.currentUser) return;
    this.siren.unlockAudio();

    const uid = appState.currentUser.uid;
    const room = sanitizeRoom($("roomInput").value);
    appState.currentRoom = room;
    $("roomInput").value = room;
    localStorage.setItem("cam_last_room", room);
    appState.activeRole = "camera";

    this.activeUid = uid;
    this.activeRoom = room;
    this.isNetworkOffline = false;
    this.sessionTakenOver = false;

    showSection("cameraView");
    $("camRoomLabel").textContent = "Oda: " + room;
    $("blackoutRoomName").textContent = "Oda: " + room;
    $("camDot").className = "dot warn";
    $("camStatus").textContent = "Kamera başlatılıyor...";

    try {
      this.localStream = await this._getCameraStream();
      $("localVideo").srcObject = this.localStream;
      this._updateTorchAvailability();
      await this.wakeLockBlackout.requestWakeLock();
      await this.telemetry.start();

      const viewersRef = ref(db, DB_PATHS.roomViewers(uid, room));
      const commandsRef = ref(db, DB_PATHS.roomCommands(uid, room));
      const snapshotRef = ref(db, DB_PATHS.roomSnapshot(uid, room));

      await Promise.all([remove(viewersRef), remove(commandsRef), remove(snapshotRef)]);

      const mySessionId = "s_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      this.activeSessionId = mySessionId;

      await this._publishPresence({ isReconnect: false });

      $("camDot").className = "dot live";
      $("camStatus").textContent =
        "Yayın aktif. Oda otomatik listelendi; izleyiciler ve komutlar dinleniyor.";

      // 1) .info/connected — kısa internet kesintisi sonrası 7/24 otomatik kurtarma
      const unsubConn = onValue(ref(db, DB_PATHS.CONNECTED), async (snap) => {
        if (this.activeSessionId !== mySessionId || this.sessionTakenOver) return;
        const connected = Boolean(snap.val());

        if (!connected) {
          if (!this.isNetworkOffline) {
            this.isNetworkOffline = true;
            $("camDot").className = "dot warn";
            $("camStatus").textContent =
              "İnternet bağlantısı koptu. Ağ geri geldiğinde yayın otomatik olarak yenilenecek...";
            addAlarmLog("İnternet bağlantısı kesildi — otomatik yeniden bağlantı bekleniyor");
          }
          return;
        }

        // İlk açılışta _publishPresence zaten çalıştı; yalnızca kesinti sonrası geri dönüşte yeniden kaydet
        if (!this.isNetworkOffline) return;

        try {
          for (const [vId, entry] of Array.from(this.peers.entries())) {
            const st = entry.pc.iceConnectionState;
            if (st === "failed" || st === "closed" || st === "disconnected") {
              this._closePeerForViewer(vId, { removeFromDb: true });
            }
          }
          await this._publishPresence({ isReconnect: true });
          if (this.activeSessionId !== mySessionId || this.sessionTakenOver) return;
          this.isNetworkOffline = false;
          $("camDot").className = "dot live";
          $("camStatus").textContent =
            "Ağ bağlantısı geri geldi. Oda kaydı ve yayın otomatik olarak yenilendi.";
          addAlarmLog("Ağ yeniden bağlandı; kamera dizine tekrar kaydedildi");
        } catch (reconnErr) {
          $("camStatus").textContent = "Yeniden kayıt hatası: " + reconnErr.message;
        }
      });

      // 2) Oda çakışma (split-brain / session takeover) koruması
      const unsubSession = onValue(ref(db, DB_PATHS.roomSessionId(uid, room)), (snap) => {
        if (this.activeSessionId !== mySessionId || this.sessionTakenOver) return;
        const remoteSessionId = snap.val();
        if (remoteSessionId && remoteSessionId !== mySessionId) {
          this._handleSessionTakenOver(room);
        }
      });

      // 3) İzleyici eklenme / ayrılma dinleyicileri
      const unsubAdd = onChildAdded(viewersRef, (snap) => {
        const vId = snap.key;
        if (!vId || this.peers.has(vId)) return;
        if (this.peers.size >= LIMITS.MAX_VIEWERS) {
          const msg = `Maksimum izleyici sınırına (${LIMITS.MAX_VIEWERS}/${LIMITS.MAX_VIEWERS}) ulaşıldı.`;
          $("camStatus").textContent = msg;
          set(ref(db, `${DB_PATHS.roomViewer(uid, room, vId)}/error`), {
            code: "room_full",
            message: msg
          }).catch(() => {});
          return;
        }
        const viewerVal = snap.val() || {};
        const profile = viewerVal.profile === "grid" ? "grid" : "single";
        this._createPeerForViewer(vId, profile);
      });

      const unsubRemove = onChildRemoved(viewersRef, (snap) => {
        this._closePeerForViewer(snap.key, { removeFromDb: false });
      });

      // 4) Uzaktan komut kuyruğu
      const unsubCmd = onChildAdded(commandsRef, async (snap) => {
        const cmd = snap.val();
        remove(snap.ref).catch(() => {});
        if (!cmd || !cmd.type) return;
        await this._handleRemoteCommand(cmd);
      });

      this.unsubs.push(unsubConn, unsubSession, unsubAdd, unsubRemove, unsubCmd);
    } catch (err) {
      $("camStatus").textContent = "Kamera başlatılamadı: " + err.message;
      $("camDot").className = "dot err";
    }
  }

  async _applyVideoEncodingProfile(sender, profile = "single") {
    if (!sender || typeof sender.getParameters !== "function") return;
    const quality = $("qualitySelect").value === "480p" ? "480p" : "720p";
    const preset = (VIDEO_PROFILES[profile] || VIDEO_PROFILES.single)[quality];
    if (!preset) return;

    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = preset.maxBitrate;
      params.encodings[0].scaleResolutionDownBy = preset.scaleResolutionDownBy;
      params.encodings[0].maxFramerate = preset.maxFramerate;
      await sender.setParameters(params);
    } catch (_) {
      // Eski/kısıtlı tarayıcılarda yalnızca maxBitrate ile güvenli düşüş
      try {
        const fallbackParams = sender.getParameters();
        if (!fallbackParams.encodings || fallbackParams.encodings.length === 0) {
          fallbackParams.encodings = [{}];
        }
        fallbackParams.encodings[0].maxBitrate = preset.maxBitrate;
        await sender.setParameters(fallbackParams);
      } catch (__) {}
    }
  }

  async _createPeerForViewer(vId, profile = "single") {
    const uid = this.activeUid;
    const room = this.activeRoom;
    const sessionId = this.activeSessionId;
    if (!uid || !room || !this.localStream) return;

    const { rtcConfig } = await getRtcConfig();
    if (
      this.activeSessionId !== sessionId ||
      this.sessionTakenOver ||
      !this.localStream ||
      this.peers.has(vId)
    ) {
      return;
    }

    const pc = new RTCPeerConnection(rtcConfig);
    const candidateQueue = [];
    const unsubs = [];

    const remoteAudioEl = document.createElement("audio");
    remoteAudioEl.autoplay = true;
    remoteAudioEl.playsInline = true;
    remoteAudioEl.style.display = "none";
    document.body.appendChild(remoteAudioEl);

    let dataChannel = null;
    if (profile === "single") {
      dataChannel = pc.createDataChannel(DATACHANNEL_CONFIG.LABEL, { ordered: true });
      dataChannel.onmessage = async (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const cmd = JSON.parse(ev.data);
          if (cmd && cmd.type) {
            await this._handleRemoteCommand(cmd, { dataChannel });
          }
        } catch (_) {}
      };
    }

    this.peers.set(vId, { pc, profile, dataChannel, unsubs, candidateQueue, remoteAudioEl });
    this._updateViewerCountUI();

    const basePath = DB_PATHS.roomViewer(uid, room, vId);
    const offerRef = ref(db, `${basePath}/offer`);
    const answerRef = ref(db, `${basePath}/answer`);
    const camCandRef = ref(db, `${basePath}/cameraCandidates`);
    const viewCandRef = ref(db, `${basePath}/viewerCandidates`);

    let videoSender = null;
    this.localStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, this.localStream);
      if (track.kind === "video") videoSender = sender;
    });
    if (this.localStream.getAudioTracks().length === 0) {
      pc.addTransceiver("audio", { direction: "recvonly" });
    }
    if (videoSender) {
      await this._applyVideoEncodingProfile(videoSender, profile);
    }

    pc.ontrack = (event) => {
      if (event.track && event.track.kind === "audio") {
        remoteAudioEl.srcObject = event.streams[0] || new MediaStream([event.track]);
        remoteAudioEl.play().catch(() => {});
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) push(camCandRef, event.candidate.toJSON()).catch(() => {});
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
        this._closePeerForViewer(vId, { removeFromDb: true });
      }
    };

    const unsubAns = onValue(answerRef, async (snap) => {
      const answer = snap.val();
      if (!answer || pc.currentRemoteDescription) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        while (candidateQueue.length > 0) {
          const c = candidateQueue.shift();
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
      } catch (err) {
        console.error("Answer işlenemedi:", err);
      }
    });

    const unsubCand = onChildAdded(viewCandRef, async (snap) => {
      const cand = snap.val();
      if (!cand) return;
      if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
      } else {
        candidateQueue.push(cand);
      }
    });

    unsubs.push(unsubAns, unsubCand);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await set(offerRef, { type: offer.type, sdp: offer.sdp });
    } catch (err) {
      console.error("Offer oluşturulamadı:", err);
      this._closePeerForViewer(vId, { removeFromDb: true });
    }
  }

  _closePeerForViewer(vId, { removeFromDb = false } = {}) {
    const entry = this.peers.get(vId);
    if (!entry) return;
    entry.unsubs.forEach((fn) => fn());
    if (entry.dataChannel) {
      try { entry.dataChannel.close(); } catch (_) {}
    }
    try { entry.pc.close(); } catch (_) {}
    if (entry.remoteAudioEl) {
      entry.remoteAudioEl.srcObject = null;
      entry.remoteAudioEl.remove();
    }
    this.peers.delete(vId);
    this._updateViewerCountUI();

    if (removeFromDb && this.activeUid && this.activeRoom && !this.sessionTakenOver) {
      remove(ref(db, DB_PATHS.roomViewer(this.activeUid, this.activeRoom, vId))).catch(() => {});
    }
  }

  async setTorchState(targetState, isRemote = false) {
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (!videoTrack || !this.torchSupported) {
      if (isRemote) {
        this.syncMeta({
          lastEvent: "Bu kamera cihazı flaş kontrolünü desteklemiyor.",
          lastEventAt: Date.now()
        });
      } else {
        $("camStatus").textContent = "Flaş bu cihazda kontrol edilemiyor.";
      }
      return;
    }

    this.motion.pauseTemporarily(3000);
    try {
      await videoTrack.applyConstraints({ advanced: [{ torch: targetState }] });
      this.torchOn = targetState;
      $("torchBtn").textContent = this.torchOn ? "Flaş: Açık" : "Flaş: Kapalı";
      const msg = this.torchOn
        ? isRemote ? "Flaş uzaktan açıldı." : "Flaş açıldı."
        : isRemote ? "Flaş uzaktan kapatıldı." : "Flaş kapatıldı.";
      $("camStatus").textContent = msg;
      if (isRemote) addAlarmLog(`Uzaktan komut: ${msg}`);
      this.syncMeta({ lastEvent: msg, lastEventAt: Date.now() });
    } catch (err) {
      const errMsg = "Flaş değiştirilemedi: " + err.message;
      $("camStatus").textContent = errMsg;
      if (isRemote) this.syncMeta({ lastEvent: errMsg, lastEventAt: Date.now() });
    }
  }

  async switchCamera() {
    if (!this.localStream) return;
    if (this.clipRecorder.isRecording) {
      $("camStatus").textContent = "Video kaydı tamamlanana kadar kamera değiştirilemez.";
      return;
    }

    const prevFacing = this.facingMode;
    this.facingMode = this.facingMode === "environment" ? "user" : "environment";
    $("camStatus").textContent = "Kamera değiştiriliyor...";
    this.motion.pauseTemporarily(3500);

    try {
      const oldVideoTracks = this.localStream.getVideoTracks();
      oldVideoTracks.forEach((t) => t.stop());

      let newVideoStream;
      try {
        newVideoStream = await this._getCameraStream(false);
      } catch (innerErr) {
        this.facingMode = prevFacing;
        try {
          const restoredStream = await this._getCameraStream(false);
          const restoredTrack = restoredStream.getVideoTracks()[0];
          if (restoredTrack) await this._replaceVideoTrack(restoredTrack);
        } catch (_) {}
        throw innerErr;
      }

      const newVideoTrack = newVideoStream.getVideoTracks()[0];
      await this._replaceVideoTrack(newVideoTrack);
      this._updateTorchAvailability();
      this.syncMeta({ lastEvent: "Kamera yönü değiştirildi.", lastEventAt: Date.now() });
      $("camStatus").textContent =
        "Kamera değiştirildi (" + (this.facingMode === "environment" ? "Arka" : "Ön") + ").";
    } catch (err) {
      $("camStatus").textContent = "Kamera değiştirilemedi: " + err.message;
    }
  }

  async _replaceVideoTrack(newVideoTrack) {
    const oldAudioTracks = this.localStream.getAudioTracks();
    this.localStream = new MediaStream([newVideoTrack, ...oldAudioTracks]);
    $("localVideo").srcObject = this.localStream;

    for (const { pc, profile } of this.peers.values()) {
      const videoTransceiver = pc
        .getTransceivers()
        .find((tr) => tr.sender?.track?.kind === "video" || tr.receiver?.track?.kind === "video");
      if (videoTransceiver?.sender) {
        await videoTransceiver.sender.replaceTrack(newVideoTrack);
        await this._applyVideoEncodingProfile(videoTransceiver.sender, profile);
      }
    }
  }

  _sendSnapshotOverDataChannel(dataChannel, { dataUrl, capturedAt, room, sentToTelegram }) {
    if (!dataChannel || dataChannel.readyState !== "open") return false;
    try {
      const chunkSize = DATACHANNEL_CONFIG.CHUNK_SIZE;
      const total = Math.ceil(dataUrl.length / chunkSize);
      const id = "sn_" + capturedAt + "_" + Math.random().toString(36).slice(2, 6);

      for (let index = 0; index < total; index++) {
        const slice = dataUrl.slice(index * chunkSize, (index + 1) * chunkSize);
        const packet = {
          type: "snap_chunk",
          id,
          index,
          total,
          data: slice
        };
        if (index === 0) {
          packet.meta = { capturedAt, room, sentToTelegram };
        }
        dataChannel.send(JSON.stringify(packet));
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  async _handleRemoteSnapshotRequest(sendToTelegram = true, { dataChannel = null } = {}) {
    const uid = this.activeUid;
    const room = this.activeRoom;
    if (!uid || !room) return;

    try {
      const preview = captureStampedCanvas($("localVideo"), room, 800, "ANLIK");
      if (!preview) {
        this.syncMeta({
          lastEvent: "Kamera görüntüsü hazır olmadığı için fotoğraf çekilemedi.",
          lastEventAt: Date.now()
        });
        return;
      }

      const dataUrl = preview.canvas.toDataURL("image/jpeg", 0.74);
      const capturedAt = Date.now();

      let tgNote = "";
      const { token, chatId, configured } = getTelegramCredentials();
      if (sendToTelegram && configured) {
        const full = captureStampedCanvas($("localVideo"), room, 1280, "UZAKTAN İSTEK");
        const fullBlob = full
          ? await new Promise((resolve) => full.canvas.toBlob(resolve, "image/jpeg", 0.84))
          : null;
        if (fullBlob && full) {
          try {
            const caption = `📸 ANLIK FOTOĞRAF (Uzaktan İstek)\n📍 Oda: ${room.toUpperCase()}\n🕒 ${full.nowStr}`;
            await sendTelegramPhoto({
              token,
              chatId,
              blob: fullBlob,
              filename: `cam_${room}_${Date.now()}.jpg`,
              caption
            });
            tgNote = " + Telegram'a iletildi";
          } catch (tgErr) {
            tgNote = " (Telegram hatası: " + tgErr.message + ")";
          }
        }
      }

      const sentToTelegram = tgNote.includes("iletildi");
      const sentViaP2p = this._sendSnapshotOverDataChannel(dataChannel, {
        dataUrl,
        capturedAt,
        room,
        sentToTelegram
      });

      // DataChannel açık değilse (veya RTDB komutundan geldiyse) RTDB yedeğine yaz
      if (!sentViaP2p) {
        await set(ref(db, DB_PATHS.roomSnapshot(uid, room)), {
          dataUrl,
          capturedAt,
          room,
          sentToTelegram
        });
      }

      const viaTag = sentViaP2p ? " (P2P)" : "";
      addAlarmLog(`Uzaktan anlık fotoğraf çekildi${viaTag}${tgNote}`);
      this.syncMeta({
        lastEvent: `Anlık fotoğraf çekildi${viaTag}${tgNote}.`,
        lastEventAt: Date.now()
      });
    } catch (err) {
      addAlarmLog("Uzaktan fotoğraf hatası: " + err.message);
      this.syncMeta({ lastEvent: "Fotoğraf çekme hatası: " + err.message, lastEventAt: Date.now() });
    }
  }

  async _handleRemoteCommand(cmd, context = {}) {
    if (appState.activeRole !== "camera" || this.sessionTakenOver) return;
    if (cmd.type === "set_motion") {
      if (cmd.value) {
        this.motion.start(true);
        addAlarmLog("Uzaktan komut: Hareket alarmı açıldı");
      } else {
        this.motion.stop(true);
        addAlarmLog("Uzaktan komut: Hareket alarmı kapatıldı");
      }
    } else if (cmd.type === "set_torch") {
      await this.setTorchState(Boolean(cmd.value), true);
    } else if (cmd.type === "set_siren") {
      if (cmd.value) this.siren.start(true);
      else this.siren.stop(true);
    } else if (cmd.type === "take_snapshot") {
      await this._handleRemoteSnapshotRequest(Boolean(cmd.sendTelegram), context);
    }
  }

  async stop({ skipDbCleanup = false } = {}) {
    const uidToClean = this.activeUid;
    const roomToClean = this.activeRoom;

    this.activeSessionId = null;
    this.isNetworkOffline = false;

    this.telemetry.stop();
    this.motion.stop(false);
    this.siren.dispose();
    this.clipRecorder.abortIfActive();
    this.unsubs.forEach((fn) => fn());
    this.unsubs = [];

    for (const vId of Array.from(this.peers.keys())) {
      this._closePeerForViewer(vId, { removeFromDb: false });
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }

    this.torchOn = false;
    this.torchSupported = false;
    $("localVideo").srcObject = null;
    this.wakeLockBlackout.releaseWakeLock();
    this.wakeLockBlackout.hideBlackout();

    this.activeUid = null;
    this.activeRoom = null;

    if (!skipDbCleanup && uidToClean && roomToClean) {
      await this._cancelOnDisconnectHooks(uidToClean, roomToClean);
      await Promise.all([
        remove(ref(db, DB_PATHS.roomMeta(uidToClean, roomToClean))).catch(() => {}),
        remove(ref(db, DB_PATHS.roomViewers(uidToClean, roomToClean))).catch(() => {}),
        remove(ref(db, DB_PATHS.roomCommands(uidToClean, roomToClean))).catch(() => {}),
        remove(ref(db, DB_PATHS.roomSnapshot(uidToClean, roomToClean))).catch(() => {}),
        remove(ref(db, DB_PATHS.roomDir(uidToClean, roomToClean))).catch(() => {})
      ]);
    }
  }
}

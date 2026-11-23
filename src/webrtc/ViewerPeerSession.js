// Tekli ve 2×2 Grid izleyicileri için ortak WebRTC P2P oturum yöneticisi
// Özellikler: Dinamik TURN/STUN, profil bildirimi (single/grid), yarış durumu koruması,
// oda dolu algılama, exponential backoff otomatik yeniden bağlanma ve P2P/TURN istatistik okuması

import { LIMITS, DB_PATHS } from "../config.js";
import {
  db,
  ref,
  set,
  push,
  remove,
  onValue,
  onChildAdded,
  onDisconnect,
  serverTimestamp
} from "../services/firebase.js";
import { getRtcConfig, inspectActiveConnectionStats } from "../services/iceConfig.js";

export class ViewerPeerSession {
  constructor({
    roomName,
    uid,
    idPrefix = "v",
    profile = "single",
    onStream = () => {},
    onIceStateChange = () => {},
    onStatsReady = () => {},
    onRemoteOfferApplied = null,
    onReconnecting = () => {},
    onRejected = () => {},
    onError = () => {}
  }) {
    this.roomName = roomName;
    this.uid = uid;
    this.idPrefix = idPrefix;
    this.profile = profile === "grid" ? "grid" : "single";
    this.onStream = onStream;
    this.onIceStateChange = onIceStateChange;
    this.onStatsReady = onStatsReady;
    this.onRemoteOfferApplied = onRemoteOfferApplied;
    this.onReconnecting = onReconnecting;
    this.onRejected = onRejected;
    this.onError = onError;

    this.pc = null;
    this.viewerId = null;
    this.unsubs = [];
    this.candidateQueue = [];
    this.seq = 0;

    this.retryCount = 0;
    this.retryTimer = null;
    this.disconnectGraceTimer = null;
    this.statsTimer = null;
    this.isDisposed = false;
  }

  async connect({ isRetry = false } = {}) {
    if (this.isDisposed) return;
    if (!isRetry) this.retryCount = 0;

    this._clearTimers();
    const mySeq = ++this.seq;
    await this._cleanupInternal();
    if (mySeq !== this.seq || this.isDisposed) return;

    const { rtcConfig } = await getRtcConfig();
    if (mySeq !== this.seq || this.isDisposed) return;

    const localViewerId = `${this.idPrefix}_${this.uid.slice(0, 6)}_${Math.random().toString(36).slice(2, 8)}`;
    this.viewerId = localViewerId;

    const basePath = DB_PATHS.roomViewer(this.uid, this.roomName, localViewerId);
    const viewerRef = ref(db, basePath);
    const offerRef = ref(db, `${basePath}/offer`);
    const answerRef = ref(db, `${basePath}/answer`);
    const errorRef = ref(db, `${basePath}/error`);
    const camCandRef = ref(db, `${basePath}/cameraCandidates`);
    const viewCandRef = ref(db, `${basePath}/viewerCandidates`);

    const pc = new RTCPeerConnection(rtcConfig);
    this.pc = pc;
    this.candidateQueue = [];

    pc.ontrack = (event) => {
      if (mySeq !== this.seq) return;
      const stream = event.streams[0] || new MediaStream([event.track]);
      this.onStream(stream);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && mySeq === this.seq) {
        push(viewCandRef, event.candidate.toJSON()).catch(() => {});
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (mySeq !== this.seq || !this.pc || this.isDisposed) return;
      const st = pc.iceConnectionState;

      if (st === "connected" || st === "completed") {
        this._clearTimers();
        this.retryCount = 0;
        this.onIceStateChange(st);
        this._readConnectionStats(pc, mySeq);
        return;
      }

      if (st === "disconnected") {
        this.onIceStateChange(st);
        this._scheduleDisconnectRecovery(mySeq);
        return;
      }

      if (st === "failed") {
        this._attemptAutoReconnect(mySeq);
        return;
      }

      this.onIceStateChange(st);
    };

    await onDisconnect(viewerRef).remove();
    if (mySeq !== this.seq || this.isDisposed) {
      remove(viewerRef).catch(() => {});
      try { pc.close(); } catch (_) {}
      return;
    }

    const unsubErr = onValue(errorRef, async (snap) => {
      const errObj = snap.val();
      if (mySeq !== this.seq || !errObj) return;
      this._clearTimers();
      this.seq++;
      await this._cleanupInternal();
      this.onRejected(errObj);
    });

    const unsubOffer = onValue(offerRef, async (snap) => {
      const offer = snap.val();
      if (mySeq !== this.seq || !offer || pc.currentRemoteDescription) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        if (mySeq !== this.seq) return;

        if (this.onRemoteOfferApplied) {
          await this.onRemoteOfferApplied(pc);
          if (mySeq !== this.seq) return;
        }

        while (this.candidateQueue.length > 0) {
          const c = this.candidateQueue.shift();
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (mySeq === this.seq) {
          await set(answerRef, { type: answer.type, sdp: answer.sdp });
        }
      } catch (err) {
        if (mySeq === this.seq) this.onError(err);
      }
    });

    const unsubCamCand = onChildAdded(camCandRef, async (snap) => {
      const cand = snap.val();
      if (mySeq !== this.seq || !cand) return;
      if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
      } else {
        this.candidateQueue.push(cand);
      }
    });

    this.unsubs.push(unsubErr, unsubOffer, unsubCamCand);
    await set(viewerRef, {
      joinedAt: serverTimestamp(),
      profile: this.profile
    });
  }

  _readConnectionStats(pc, expectedSeq) {
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = setTimeout(async () => {
      this.statsTimer = null;
      if (expectedSeq !== this.seq || this.isDisposed || this.pc !== pc) return;
      const stats = await inspectActiveConnectionStats(pc);
      if (stats && expectedSeq === this.seq && !this.isDisposed) {
        this.onStatsReady(stats);
      }
    }, 900);
  }

  _scheduleDisconnectRecovery(expectedSeq) {
    if (this.disconnectGraceTimer) return;
    this.disconnectGraceTimer = setTimeout(() => {
      this.disconnectGraceTimer = null;
      if (expectedSeq !== this.seq || this.isDisposed || !this.pc) return;
      if (this.pc.iceConnectionState === "disconnected" || this.pc.iceConnectionState === "failed") {
        this._attemptAutoReconnect(expectedSeq);
      }
    }, LIMITS.VIEWER_DISCONNECT_GRACE_MS);
  }

  _attemptAutoReconnect(expectedSeq) {
    this._clearTimers();
    if (expectedSeq !== this.seq || this.isDisposed) return;

    if (this.retryCount >= LIMITS.VIEWER_MAX_AUTO_RETRIES) {
      this.onIceStateChange("failed");
      return;
    }

    this.retryCount++;
    const delayMs = 2000 * Math.pow(2, this.retryCount - 1);
    this.onReconnecting(this.retryCount, LIMITS.VIEWER_MAX_AUTO_RETRIES);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (expectedSeq !== this.seq || this.isDisposed) return;
      this.connect({ isRetry: true });
    }, delayMs);
  }

  _clearTimers() {
    if (this.disconnectGraceTimer) {
      clearTimeout(this.disconnectGraceTimer);
      this.disconnectGraceTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.statsTimer) {
      clearTimeout(this.statsTimer);
      this.statsTimer = null;
    }
  }

  async disconnect() {
    this.isDisposed = true;
    this._clearTimers();
    this.seq++;
    await this._cleanupInternal();
  }

  removeOnUnload() {
    if (this.viewerId) {
      remove(ref(db, DB_PATHS.roomViewer(this.uid, this.roomName, this.viewerId)));
    }
  }

  async _cleanupInternal() {
    this.unsubs.forEach((fn) => fn());
    this.unsubs = [];
    this.candidateQueue = [];

    if (this.pc) {
      try { this.pc.close(); } catch (_) {}
      this.pc = null;
    }

    if (this.viewerId) {
      const oldId = this.viewerId;
      this.viewerId = null;
      await remove(ref(db, DB_PATHS.roomViewer(this.uid, this.roomName, oldId))).catch(() => {});
    }
  }
}

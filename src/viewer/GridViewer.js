// 2×2 Çoklu Ekran (Grid) İzleyici Yöneticisi

import { LIMITS, DB_PATHS } from "../config.js";
import { $, appState } from "../state.js";
import { db, ref, onValue } from "../services/firebase.js";
import { ViewerPeerSession } from "../webrtc/ViewerPeerSession.js";

export class GridViewer {
  constructor({ onExpandRoom }) {
    this.onExpandRoom = onExpandRoom;
    this.tiles = new Map(); // roomName -> tileState

    this._bindEvents();
  }

  _bindEvents() {
    $("gridDensityBtn").addEventListener("click", () => {
      const container = $("cameraGridContainer");
      const forced = container.classList.toggle("force-two-col");
      $("gridDensityBtn").textContent = forced ? "Mobil: Alt Alta" : "Mobil: 2 Sütun";
    });

    $("gridReconnectAllBtn").addEventListener("click", () => {
      for (const tile of this.tiles.values()) {
        if (tile.sessionId) this._connectTile(tile);
      }
    });
  }

  syncConnections() {
    if (appState.activeRole !== "viewer" || appState.viewerMode !== "grid") return;

    const allKeys = Object.keys(appState.activeRoomsMap).sort();
    const desiredKeys = allKeys.slice(0, LIMITS.MAX_GRID_CAMERAS);

    if (allKeys.length > LIMITS.MAX_GRID_CAMERAS) {
      $("gridOverflowNote").textContent =
        `Toplam ${allKeys.length} aktif kamera var. 2×2 ekranda ilk ${LIMITS.MAX_GRID_CAMERAS} oda gösteriliyor; diğer odalar için üstteki listeden seçim yapabilirsin.`;
      $("gridOverflowNote").classList.remove("hidden");
    } else {
      $("gridOverflowNote").classList.add("hidden");
    }

    if (desiredKeys.length === 0) {
      $("gridEmptyState").classList.remove("hidden");
      $("gridStatusText").textContent = "Yayında aktif kamera bekleniyor...";
    } else {
      $("gridEmptyState").classList.add("hidden");
      $("gridStatusText").textContent =
        `${desiredKeys.length} aktif kamera 2×2 çoklu ekranda izleniyor. Kontroller için kameraya dokun.`;
    }

    for (const existingRoom of Array.from(this.tiles.keys())) {
      if (!desiredKeys.includes(existingRoom)) {
        this._removeTile(existingRoom);
      }
    }

    desiredKeys.forEach((roomName) => {
      if (!this.tiles.has(roomName)) {
        this._addTile(roomName);
      }
    });
  }

  _addTile(roomName) {
    if (!appState.currentUser) return;
    const uid = appState.currentUser.uid;

    const tileEl = document.createElement("div");
    tileEl.className = "grid-tile";

    // Üst başlık
    const head = document.createElement("div");
    head.className = "grid-tile-head";

    const titleWrap = document.createElement("div");
    titleWrap.className = "grid-tile-title";
    const dotEl = document.createElement("span");
    dotEl.className = "dot warn";
    const titleText = document.createElement("span");
    titleText.textContent = roomName;
    titleWrap.append(dotEl, titleText);

    const badgesEl = document.createElement("div");
    badgesEl.className = "row";
    badgesEl.style.gap = "4px";
    head.append(titleWrap, badgesEl);

    // Video alanı
    const videoWrap = document.createElement("div");
    videoWrap.className = "grid-video-wrap";
    videoWrap.title = "Tam ekran ve uzaktan kontroller için dokun";

    const videoEl = document.createElement("video");
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = true;

    const stateEl = document.createElement("div");
    stateEl.className = "grid-state-chip";
    stateEl.textContent = "Bağlanıyor...";

    videoWrap.append(videoEl, stateEl);
    videoWrap.addEventListener("click", () => this.onExpandRoom(roomName));

    // Alt kontrol çubuğu
    const foot = document.createElement("div");
    foot.className = "grid-tile-foot";

    const leftBtns = document.createElement("div");
    leftBtns.className = "row";
    leftBtns.style.gap = "6px";

    const muteBtn = document.createElement("button");
    muteBtn.type = "button";
    muteBtn.className = "secondary compact";
    muteBtn.textContent = "Sesi Aç";

    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "secondary compact";
    retryBtn.textContent = "Yenile";

    leftBtns.append(muteBtn, retryBtn);

    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "compact";
    expandBtn.textContent = "Büyüt & Yönet";

    foot.append(leftBtns, expandBtn);
    tileEl.append(head, videoWrap, foot);
    $("cameraGridContainer").appendChild(tileEl);

    const tile = {
      roomName,
      el: tileEl,
      videoEl,
      dotEl,
      stateEl,
      badgesEl,
      muteBtn,
      sessionId: null,
      metaUnsub: null,
      peerSession: null
    };

    muteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willUnmute = videoEl.muted;
      if (willUnmute) {
        for (const other of this.tiles.values()) {
          if (other !== tile) {
            other.videoEl.muted = true;
            other.muteBtn.textContent = "Sesi Aç";
            other.muteBtn.className = "secondary compact";
          }
        }
      }
      videoEl.muted = !willUnmute;
      muteBtn.textContent = videoEl.muted ? "Sesi Aç" : "Ses Açık";
      muteBtn.className = videoEl.muted ? "secondary compact" : "success compact";
      videoEl.play().catch(() => {});
    });

    retryBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (tile.sessionId) this._connectTile(tile);
    });

    expandBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onExpandRoom(roomName);
    });

    this.tiles.set(roomName, tile);

    tile.metaUnsub = onValue(ref(db, DB_PATHS.roomMeta(uid, roomName)), (snap) => {
      if (!this.tiles.has(roomName) || appState.activeRole !== "viewer" || appState.viewerMode !== "grid") {
        return;
      }
      const meta = snap.val();
      this._updateMetaBadges(tile, meta);

      if (!meta || !meta.online) {
        tile.sessionId = null;
        tile.dotEl.className = "dot warn";
        tile.stateEl.textContent = "Çevrimdışı";
        this._disconnectTile(tile);
        return;
      }

      if (meta.sessionId !== tile.sessionId) {
        tile.sessionId = meta.sessionId;
        this._connectTile(tile);
      }
    });
  }

  _updateMetaBadges(tile, meta) {
    tile.badgesEl.innerHTML = "";
    tile.el.classList.toggle("siren-active", Boolean(meta && meta.sirenOn));
    if (!meta || !meta.online) return;

    if (meta.sirenOn) {
      const sTag = document.createElement("span");
      sTag.className = "pill-meta siren";
      sTag.textContent = "SİREN";
      tile.badgesEl.appendChild(sTag);
    }
    if (meta.motionEnabled) {
      const aTag = document.createElement("span");
      aTag.className = "pill-meta alarm";
      aTag.textContent = "Alarm";
      tile.badgesEl.appendChild(aTag);
    }
    if (meta.quality) {
      const qTag = document.createElement("span");
      qTag.className = "pill-meta";
      qTag.textContent = meta.quality;
      tile.badgesEl.appendChild(qTag);
    }
  }

  async _connectTile(tile) {
    await this._disconnectTile(tile);
    if (
      !appState.currentUser ||
      !this.tiles.has(tile.roomName) ||
      appState.activeRole !== "viewer" ||
      appState.viewerMode !== "grid"
    ) {
      return;
    }

    tile.dotEl.className = "dot warn";
    tile.stateEl.textContent = "Bağlanıyor...";

    const peerSession = new ViewerPeerSession({
      roomName: tile.roomName,
      uid: appState.currentUser.uid,
      idPrefix: "vg",
      profile: "grid",
      onStream: (stream) => {
        if (tile.videoEl.srcObject !== stream) {
          tile.videoEl.srcObject = stream;
          tile.videoEl.play().catch(() => {});
        }
      },
      onIceStateChange: (st) => {
        if (!this.tiles.has(tile.roomName)) return;
        if (st === "connected" || st === "completed") {
          tile.dotEl.className = "dot live";
          tile.stateEl.textContent = "Canlı";
        } else if (st === "disconnected") {
          tile.dotEl.className = "dot warn";
          tile.stateEl.textContent = "Kesinti...";
        } else if (st === "failed") {
          tile.dotEl.className = "dot err";
          tile.stateEl.textContent = "Bağlantı Hatası";
        }
      },
      onStatsReady: (stats) => {
        if (!this.tiles.has(tile.roomName)) return;
        tile.stateEl.textContent = stats.mode === "TURN" ? "Canlı (TURN)" : "Canlı (P2P)";
      },
      onReconnecting: (attempt, maxRetries) => {
        if (!this.tiles.has(tile.roomName)) return;
        tile.dotEl.className = "dot warn";
        tile.stateEl.textContent = `Yeniden (${attempt}/${maxRetries})...`;
      },
      onRejected: () => {
        if (!this.tiles.has(tile.roomName)) return;
        tile.dotEl.className = "dot err";
        tile.stateEl.textContent = "Oda Dolu";
      },
      onError: () => {
        tile.dotEl.className = "dot err";
        tile.stateEl.textContent = "Hata";
      }
    });

    tile.peerSession = peerSession;
    await peerSession.connect();
  }

  async _disconnectTile(tile) {
    tile.videoEl.srcObject = null;
    if (tile.peerSession) {
      const session = tile.peerSession;
      tile.peerSession = null;
      await session.disconnect();
    }
  }

  async _removeTile(roomName) {
    const tile = this.tiles.get(roomName);
    if (!tile) return;
    if (tile.metaUnsub) {
      tile.metaUnsub();
      tile.metaUnsub = null;
    }
    this.tiles.delete(roomName);
    tile.el.remove();
    await this._disconnectTile(tile);
  }

  async cleanupAll() {
    const rooms = Array.from(this.tiles.keys());
    await Promise.all(rooms.map((r) => this._removeTile(r)));
    $("cameraGridContainer").innerHTML = "";
  }

  removeAllOnUnload() {
    for (const tile of this.tiles.values()) {
      tile.peerSession?.removeOnUnload();
    }
  }
}

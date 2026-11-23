// Çoklu oda dizini (users/<uid>/directory) dinleyici ve oda listesi arayüzü

import { DB_PATHS } from "../config.js";
import { $, appState } from "../state.js";
import { db, ref, onValue } from "./firebase.js";

export class RoomDirectory {
  constructor({ onSelectFromSetup, onSelectFromViewer, onRoomsUpdated }) {
    this.onSelectFromSetup = onSelectFromSetup;
    this.onSelectFromViewer = onSelectFromViewer;
    this.onRoomsUpdated = onRoomsUpdated;
    this.unsub = null;
  }

  start() {
    if (this.unsub || !appState.currentUser) return;
    const uid = appState.currentUser.uid;
    this.unsub = onValue(ref(db, DB_PATHS.directory(uid)), (snap) => {
      const val = snap.val() || {};
      const cleaned = {};
      for (const [roomKey, info] of Object.entries(val)) {
        if (info && info.online) {
          cleaned[roomKey] = info;
        }
      }
      appState.activeRoomsMap = cleaned;
      this.render();
      if (this.onRoomsUpdated) this.onRoomsUpdated(cleaned);
    });
  }

  stop() {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    appState.activeRoomsMap = {};
    this.render();
  }

  render() {
    const roomKeys = Object.keys(appState.activeRoomsMap).sort();
    const activeCount = roomKeys.length;

    // 1) Kurulum ekranındaki aktif oda listesi
    $("setupActiveCount").textContent = `${activeCount} Aktif`;
    const setupList = $("setupActiveRooms");
    setupList.innerHTML = "";
    if (activeCount === 0) {
      $("setupEmptyRooms").classList.remove("hidden");
    } else {
      $("setupEmptyRooms").classList.add("hidden");
      roomKeys.forEach((rk) => {
        const el = this._createRoomPill(rk, appState.activeRoomsMap[rk], {
          isActive: false,
          onClick: (selectedRoom) => this.onSelectFromSetup(selectedRoom)
        });
        setupList.appendChild(el);
      });
    }

    // 2) İzleyici ekranındaki hızlı geçiş çubuğu
    $("viewerActiveCount").textContent = `${activeCount} Kamera`;
    const viewerBar = $("viewerRoomBar");
    viewerBar.innerHTML = "";

    const displayKeys = [...roomKeys];
    if (
      appState.activeRole === "viewer" &&
      appState.viewerMode === "single" &&
      appState.currentRoom &&
      !displayKeys.includes(appState.currentRoom)
    ) {
      displayKeys.unshift(appState.currentRoom);
    }

    if (displayKeys.length === 0) {
      const emptyNote = document.createElement("span");
      emptyNote.className = "empty-rooms";
      emptyNote.textContent = "Aktif kamera bekleniyor...";
      viewerBar.appendChild(emptyNote);
    } else {
      displayKeys.forEach((rk) => {
        const el = this._createRoomPill(rk, appState.activeRoomsMap[rk] || null, {
          isActive:
            appState.activeRole === "viewer" &&
            appState.viewerMode === "single" &&
            rk === appState.currentRoom,
          onClick: (selectedRoom) => this.onSelectFromViewer(selectedRoom)
        });
        viewerBar.appendChild(el);
      });
    }
  }

  _createRoomPill(roomName, info, options = {}) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "room-pill";
    if (options.isActive) btn.classList.add("active");
    if (!info) btn.classList.add("offline");
    if (info && info.sirenOn) btn.classList.add("siren-ringing");

    const dot = document.createElement("span");
    dot.className = "dot " + (info ? (info.sirenOn ? "err" : "live") : "warn");
    btn.appendChild(dot);

    const label = document.createElement("span");
    label.textContent = roomName;
    btn.appendChild(label);

    if (info) {
      if (info.sirenOn) {
        const sirenTag = document.createElement("span");
        sirenTag.className = "pill-meta siren";
        sirenTag.textContent = "SİREN";
        btn.appendChild(sirenTag);
      } else if (info.motionEnabled) {
        const alarmTag = document.createElement("span");
        alarmTag.className = "pill-meta alarm";
        alarmTag.textContent = "Alarm";
        btn.appendChild(alarmTag);
      }

      const countTag = document.createElement("span");
      countTag.className = "pill-meta";
      countTag.textContent = `${info.quality || "720p"} • ${info.viewerCount || 0} izleyici`;
      btn.appendChild(countTag);
    } else {
      const offTag = document.createElement("span");
      offTag.className = "pill-meta";
      offTag.textContent = "Çevrimdışı";
      btn.appendChild(offTag);
    }

    btn.addEventListener("click", () => options.onClick(roomName));
    return btn;
  }
}

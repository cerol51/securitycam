// İzleyici Modu Koordinatörü (Tekli Görünüm ↔ 2×2 Çoklu Ekran)

import { $, appState, sanitizeRoom, showSection } from "../state.js";
import { PushToTalk } from "./PushToTalk.js";
import { GridViewer } from "./GridViewer.js";
import { SingleViewer } from "./SingleViewer.js";

export class ViewerController {
  constructor({ onRenderDirectory }) {
    this.onRenderDirectory = onRenderDirectory;

    this.ptt = new PushToTalk();
    this.single = new SingleViewer({ ptt: this.ptt });
    this.grid = new GridViewer({
      onExpandRoom: (roomName) => this.switchToSingleMode(roomName)
    });

    this._bindEvents();
  }

  _bindEvents() {
    $("startViewerBtn").addEventListener("click", () => {
      this.openSingleForRoom($("roomInput").value);
    });
    $("openGridFromSetupBtn").addEventListener("click", () => this.openGridMode());
    $("startGridViewerBtn").addEventListener("click", () => this.openGridMode());

    $("modeSingleBtn").addEventListener("click", () => {
      if (appState.viewerMode === "grid") this.switchToSingleMode();
    });
    $("modeGridBtn").addEventListener("click", () => {
      if (appState.viewerMode === "single") this.switchToGridMode();
    });

    $("stopViewerBtn").addEventListener("click", async () => {
      await this.stop();
      appState.activeRole = null;
      showSection("setupView");
      this.onRenderDirectory();
    });
  }

  _updateModeUI() {
    const isGrid = appState.viewerMode === "grid";
    $("modeSingleBtn").classList.toggle("active", !isGrid);
    $("modeGridBtn").classList.toggle("active", isGrid);
    $("singleViewerArea").classList.toggle("hidden", isGrid);
    $("singleStatusBadges").classList.toggle("hidden", isGrid);
    $("gridViewerArea").classList.toggle("hidden", !isGrid);
    $("mainContainer").classList.toggle("wide-grid", isGrid);
    $("roomBarTitle").textContent = isGrid
      ? "Aktif Odalar (Herhangi bir odaya dokunup tam kontrolle büyüt)"
      : "Aktif Odalar (Hızlı Geçiş)";
  }

  openSingleForRoom(roomName) {
    this.ptt.ensureDummyAudio();
    const room = sanitizeRoom(roomName);
    appState.currentRoom = room;
    $("roomInput").value = room;
    localStorage.setItem("cam_last_room", room);
    appState.activeRole = "viewer";
    appState.viewerMode = "single";

    showSection("viewerView");
    this._updateModeUI();
    $("viewRoomLabel").textContent = "Oda: " + room;
    this.single.resetSnapshotUI();
    this.onRenderDirectory();
    this.single.startWatchingRoom();
  }

  openGridMode() {
    this.ptt.ensureDummyAudio();
    appState.activeRole = "viewer";
    appState.viewerMode = "grid";

    showSection("viewerView");
    this._updateModeUI();
    this.onRenderDirectory();
    this.grid.syncConnections();
  }

  async switchToGridMode() {
    if (appState.activeRole !== "viewer" || appState.viewerMode === "grid") return;
    await this.single.stop();

    appState.viewerMode = "grid";
    this._updateModeUI();
    this.onRenderDirectory();
    this.grid.syncConnections();
  }

  async switchToSingleMode(roomName) {
    if (appState.activeRole !== "viewer") return;
    const activeKeys = Object.keys(appState.activeRoomsMap).sort();
    const fallback = activeKeys.includes(appState.currentRoom)
      ? appState.currentRoom
      : activeKeys[0] || appState.currentRoom || "salon";
    const target = sanitizeRoom(roomName || fallback);

    await this.grid.cleanupAll();

    appState.viewerMode = "single";
    appState.currentRoom = target;
    $("roomInput").value = target;
    localStorage.setItem("cam_last_room", target);
    $("viewRoomLabel").textContent = "Oda: " + target;
    this.single.resetSnapshotUI();

    this._updateModeUI();
    this.single.updateRemoteControlUI(null);
    this.onRenderDirectory();
    this.single.startWatchingRoom();
  }

  async switchRoom(targetRoom) {
    const clean = sanitizeRoom(targetRoom);
    if (
      appState.activeRole !== "viewer" ||
      appState.viewerMode !== "single" ||
      clean === appState.currentRoom
    ) {
      return;
    }

    await this.single.stop();
    this.single.resetSnapshotUI();

    appState.currentRoom = clean;
    $("roomInput").value = clean;
    localStorage.setItem("cam_last_room", clean);
    $("viewRoomLabel").textContent = "Oda: " + clean;
    this.single.updateRemoteControlUI(null);
    this.single.setUIState("warn", "Oda Değiştiriliyor...", `${clean} kamerasına bağlanılıyor...`);
    this.onRenderDirectory();
    this.single.startWatchingRoom();
  }

  handleRoomSelectionFromBar(roomName) {
    if (appState.viewerMode === "grid") this.switchToSingleMode(roomName);
    else this.switchRoom(roomName);
  }

  onDirectoryUpdated() {
    if (appState.activeRole === "viewer" && appState.viewerMode === "grid") {
      this.grid.syncConnections();
    }
  }

  async stop() {
    await Promise.all([this.single.stop(), this.grid.cleanupAll()]);
    this.ptt.releaseAll();
    $("mainContainer").classList.remove("wide-grid");
  }

  removeAllOnUnload() {
    this.single.removeOnUnload();
    this.grid.removeAllOnUnload();
  }
}

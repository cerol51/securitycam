// Uygulama giriş noktası (Composition Root)

import { $, appState, showSection } from "./state.js";
import {
  auth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "./services/firebase.js";
import { initPwa } from "./services/pwa.js";
import { RoomDirectory } from "./services/directory.js";
import { CameraController } from "./camera/CameraController.js";
import { ViewerController } from "./viewer/ViewerController.js";

// 1. PWA kurulumu ve Service Worker kaydı
initPwa();

// 2. Modül örneklerini oluştur ve birbirine bağla
let directory;

const cameraController = new CameraController();
const viewerController = new ViewerController({
  onRenderDirectory: () => directory.render()
});

directory = new RoomDirectory({
  onSelectFromSetup: (roomName) => viewerController.openSingleForRoom(roomName),
  onSelectFromViewer: (roomName) => viewerController.handleRoomSelectionFromBar(roomName),
  onRoomsUpdated: () => viewerController.onDirectoryUpdated()
});

async function cleanupAll() {
  if (appState.activeRole === "camera") await cameraController.stop();
  if (appState.activeRole === "viewer") await viewerController.stop();
  appState.activeRole = null;
}

// 3. Kimlik doğrulama yaşam döngüsü
onAuthStateChanged(auth, (user) => {
  appState.currentUser = user;
  if (user) {
    $("userEmailBadge").textContent = user.email;
    $("userHeader").classList.remove("hidden");
    directory.start();
    if (!appState.activeRole) showSection("setupView");
  } else {
    directory.stop();
    cleanupAll();
    $("userHeader").classList.add("hidden");
    showSection("loginView");
  }
});

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").classList.add("hidden");
  $("loginBtn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $("emailInput").value.trim(), $("passwordInput").value);
  } catch (err) {
    $("loginError").textContent = "Giriş başarısız: " + err.message;
    $("loginError").classList.remove("hidden");
  } finally {
    $("loginBtn").disabled = false;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  directory.stop();
  await cleanupAll();
  await signOut(auth);
});

// 4. Sayfa kapanırken aktif izleyici düğümlerini temizle
window.addEventListener("pagehide", () => {
  if (appState.activeRole === "viewer") {
    viewerController.removeAllOnUnload();
  }
});

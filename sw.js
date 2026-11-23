const CACHE_NAME = "ev-kamera-pwa-v5";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./styles/main.css",
  "./src/main.js",
  "./src/config.js",
  "./src/state.js",
  "./src/services/firebase.js",
  "./src/services/iceConfig.js",
  "./src/services/networkSettingsUI.js",
  "./src/services/directory.js",
  "./src/services/telegram.js",
  "./src/services/pwa.js",
  "./src/webrtc/ViewerPeerSession.js",
  "./src/camera/DeviceTelemetry.js",
  "./src/camera/SirenEngine.js",
  "./src/camera/WakeLockBlackout.js",
  "./src/camera/ClipRecorder.js",
  "./src/camera/MotionDetector.js",
  "./src/camera/CameraController.js",
  "./src/viewer/PushToTalk.js",
  "./src/viewer/GridViewer.js",
  "./src/viewer/SingleViewer.js",
  "./src/viewer/ViewerController.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // POST isteklerini (Telegram fotoğraf/video) ve dış servisleri (Firebase/Worker vb.) tamamen bypass et
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Aynı alan adındaki arayüz ve modül dosyaları için Network-First
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

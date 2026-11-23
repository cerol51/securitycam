// Merkezi uygulama durumu ve paylaşılan DOM/yardımcı fonksiyonlar

export const $ = (id) => document.getElementById(id);

export const appState = {
  currentUser: null,
  activeRole: null,     // 'camera' | 'viewer' | null
  viewerMode: "single", // 'single' | 'grid'
  currentRoom: "salon",
  activeRoomsMap: {}
};

export function sanitizeRoom(name) {
  let clean = (name || "salon")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[_-]+/, "")
    .slice(0, 40);
  if (!clean || clean === "directory") clean = "salon";
  return clean;
}

export function showSection(sectionId) {
  const sections = ["loginView", "setupView", "cameraView", "viewerView"];
  sections.forEach((id) => {
    const el = $(id);
    if (el) el.classList.toggle("hidden", id !== sectionId);
  });
  if (sectionId !== "viewerView") {
    $("mainContainer")?.classList.remove("wide-grid");
  }
}

export function addAlarmLog(text) {
  const list = $("alarmLogList");
  if (!list) return;
  list.classList.remove("hidden");
  const li = document.createElement("li");
  const timeStr = new Date().toLocaleTimeString("tr-TR");
  li.textContent = `[${timeStr}] ${text}`;
  list.prepend(li);
  while (list.children.length > 10) {
    list.removeChild(list.lastChild);
  }
}

/**
 * Kamera videosundan tarih/saat ve oda damgalı bir kare yakalar.
 * Her çağrıda lokal canvas oluşturur (eşzamanlı çağrılarda yarış durumunu önler).
 */
export function captureStampedCanvas(videoEl, roomName, maxWidth, stampSuffix) {
  if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return null;

  const scale = Math.min(1, maxWidth / videoEl.videoWidth);
  const w = Math.round(videoEl.videoWidth * scale);
  const h = Math.round(videoEl.videoHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, w, h);

  const nowStr = new Date().toLocaleString("tr-TR");
  const stampText = `${roomName.toUpperCase()} | ${nowStr}${stampSuffix ? " | " + stampSuffix : ""}`;
  ctx.font = `bold ${Math.max(13, Math.round(w / 48))}px sans-serif`;
  const textW = ctx.measureText(stampText).width;
  const barH = Math.max(24, Math.round(w / 28));
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.fillRect(10, h - barH - 10, textW + 20, barH);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(stampText, 20, h - 10 - Math.round(barH * 0.28));

  return { canvas, nowStr, w, h };
}

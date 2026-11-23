// Gelişmiş Ağ (TURN & Telegram Proxy) ayarları arayüz denetleyicisi

import { $ } from "../state.js";
import {
  getNetworkSettings,
  saveNetworkSettings,
  testIceConfiguration
} from "./iceConfig.js";

export function syncTelegramProxyBadge() {
  const { proxyBaseUrl } = getNetworkSettings();
  const badge = $("tgProxyModeHint");
  if (!badge) return;
  if (proxyBaseUrl) {
    badge.textContent = "Proxy Modu Aktif (Token sunucuda saklanır; aşağıdaki Token/Chat ID opsiyoneldir).";
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

export function initNetworkSettingsUI() {
  const proxyInput = $("proxyUrlInput");
  const turnUrlsInput = $("turnUrlsInput");
  const turnUserInput = $("turnUserInput");
  const turnPassInput = $("turnPassInput");
  const statusEl = $("networkSettingsStatus");
  const summaryBadge = $("turnStatusBadge");

  function refreshBadge() {
    const { proxyBaseUrl, turnUrlsRaw } = getNetworkSettings();
    if (proxyBaseUrl) {
      summaryBadge.textContent = "Proxy + TURN Aktif";
      summaryBadge.style.color = "#86efac";
    } else if (turnUrlsRaw) {
      summaryBadge.textContent = "Manuel TURN";
      summaryBadge.style.color = "#86efac";
    } else {
      summaryBadge.textContent = "Yalnızca STUN";
      summaryBadge.style.color = "";
    }
    syncTelegramProxyBadge();
  }

  function load() {
    const s = getNetworkSettings();
    proxyInput.value = s.proxyBaseUrl;
    turnUrlsInput.value = s.turnUrlsRaw;
    turnUserInput.value = s.turnUsername;
    turnPassInput.value = s.turnCredential;
    refreshBadge();
  }

  function save() {
    saveNetworkSettings({
      proxyBaseUrl: proxyInput.value,
      turnUrlsRaw: turnUrlsInput.value,
      turnUsername: turnUserInput.value,
      turnCredential: turnPassInput.value
    });
    refreshBadge();
    statusEl.textContent = "Ağ ayarları bu cihaza kaydedildi.";
  }

  $("saveNetworkBtn").addEventListener("click", save);

  $("clearNetworkBtn").addEventListener("click", () => {
    proxyInput.value = "";
    turnUrlsInput.value = "";
    turnUserInput.value = "";
    turnPassInput.value = "";
    save();
    statusEl.textContent = "Özel ağ ayarları temizlendi; varsayılan Google STUN kullanılacak.";
  });

  $("testTurnBtn").addEventListener("click", async () => {
    save();
    const btn = $("testTurnBtn");
    btn.disabled = true;
    statusEl.textContent = "ICE / TURN adayları test ediliyor (~4 sn)...";
    try {
      const res = await testIceConfiguration();
      if (res.hasRelay) {
        statusEl.textContent = `Başarılı: TURN aktarma (relay) adayı doğrulandı! (Kaynak: ${res.turnSource}, Adaylar: ${res.types.join(", ")})`;
      } else if (res.turnSource === "none") {
        statusEl.textContent = `STUN çalışıyor (${res.types.join(", ") || "host"}). Mobil CGNAT aşımı için Proxy URL veya TURN bilgisi girin.`;
      } else {
        statusEl.textContent = `Uyarı: TURN yapılandırıldı (${res.turnSource}) ancak relay adayı alınamadı (Adaylar: ${res.types.join(", ") || "yok"}). Kimlik bilgilerini veya CORS/Worker ayarını kontrol edin.`;
      }
    } catch (err) {
      statusEl.textContent = "Test hatası: " + err.message;
    } finally {
      btn.disabled = false;
    }
  });

  load();
}

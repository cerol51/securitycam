// Telegram Bot API bildirim servisi
// İki modu destekler:
// 1) Proxy Modu (Önerilen): Proxy URL tanımlıysa Firebase ID Token ile sunucuya gönderir (Bot token tarayıcıda tutulmaz)
// 2) Doğrudan Mod: Proxy URL boşsa cihazdaki Bot Token + Chat ID ile api.telegram.org'a gönderir

import { auth } from "./firebase.js";
import { getNetworkSettings } from "./iceConfig.js";

export function getTelegramCredentials() {
  const { proxyBaseUrl } = getNetworkSettings();
  const token = document.getElementById("tgTokenInput")?.value.trim() || "";
  const chatId = document.getElementById("tgChatIdInput")?.value.trim() || "";

  if (proxyBaseUrl) {
    return {
      mode: "proxy",
      proxyBaseUrl,
      token,
      chatId,
      configured: true
    };
  }

  return {
    mode: "direct",
    proxyBaseUrl: "",
    token,
    chatId,
    configured: Boolean(token && chatId)
  };
}

async function postToEndpoint(url, formData, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: formData
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    throw new Error(result.description || result.error || `HTTP ${response.status}`);
  }
  return result;
}

export async function sendTelegramPhoto({ token, chatId, blob, filename, caption }) {
  const { proxyBaseUrl } = getNetworkSettings();

  const formData = new FormData();
  formData.append("photo", blob, filename);
  formData.append("caption", caption);

  if (proxyBaseUrl) {
    const user = auth.currentUser;
    if (!user) throw new Error("Proxy için yetkili oturum gerekli.");
    const idToken = await user.getIdToken();
    if (chatId) formData.append("chat_id", chatId);
    return await postToEndpoint(`${proxyBaseUrl}/telegram/sendPhoto`, formData, {
      Authorization: `Bearer ${idToken}`
    });
  }

  if (!token || !chatId) throw new Error("Telegram Token/Chat ID eksik.");
  formData.append("chat_id", chatId);
  return await postToEndpoint(`https://api.telegram.org/bot${token}/sendPhoto`, formData);
}

export async function sendTelegramVideo({
  token,
  chatId,
  blob,
  filename,
  durationSec,
  width,
  height,
  caption
}) {
  const { proxyBaseUrl } = getNetworkSettings();

  const formData = new FormData();
  formData.append("video", blob, filename);
  formData.append("duration", String(durationSec));
  formData.append("supports_streaming", "true");
  if (width > 0 && height > 0) {
    formData.append("width", String(width));
    formData.append("height", String(height));
  }
  formData.append("caption", caption);

  if (proxyBaseUrl) {
    const user = auth.currentUser;
    if (!user) throw new Error("Proxy için yetkili oturum gerekli.");
    const idToken = await user.getIdToken();
    if (chatId) formData.append("chat_id", chatId);
    return await postToEndpoint(`${proxyBaseUrl}/telegram/sendVideo`, formData, {
      Authorization: `Bearer ${idToken}`
    });
  }

  if (!token || !chatId) throw new Error("Telegram Token/Chat ID eksik.");
  formData.append("chat_id", chatId);
  return await postToEndpoint(`https://api.telegram.org/bot${token}/sendVideo`, formData);
}

export async function sendTelegramMessage({ token, chatId, text }) {
  const { proxyBaseUrl } = getNetworkSettings();

  const formData = new FormData();
  formData.append("text", text);

  if (proxyBaseUrl) {
    const user = auth.currentUser;
    if (!user) throw new Error("Proxy için yetkili oturum gerekli.");
    const idToken = await user.getIdToken();
    if (chatId) formData.append("chat_id", chatId);
    return await postToEndpoint(`${proxyBaseUrl}/telegram/sendMessage`, formData, {
      Authorization: `Bearer ${idToken}`
    });
  }

  if (!token || !chatId) throw new Error("Telegram Token/Chat ID eksik.");
  formData.append("chat_id", chatId);
  return await postToEndpoint(`https://api.telegram.org/bot${token}/sendMessage`, formData);
}

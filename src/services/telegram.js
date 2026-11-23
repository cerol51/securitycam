// Telegram Bot API bildirim servisi

export function getTelegramCredentials() {
  const token = document.getElementById("tgTokenInput")?.value.trim() || "";
  const chatId = document.getElementById("tgChatIdInput")?.value.trim() || "";
  return { token, chatId, configured: Boolean(token && chatId) };
}

export async function sendTelegramPhoto({ token, chatId, blob, filename, caption }) {
  if (!token || !chatId) throw new Error("Telegram Token/Chat ID eksik.");

  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("photo", blob, filename);
  formData.append("caption", caption);

  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    body: formData
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `HTTP ${response.status}`);
  }
  return result;
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
  if (!token || !chatId) throw new Error("Telegram Token/Chat ID eksik.");

  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("video", blob, filename);
  formData.append("duration", String(durationSec));
  formData.append("supports_streaming", "true");
  if (width > 0 && height > 0) {
    formData.append("width", String(width));
    formData.append("height", String(height));
  }
  formData.append("caption", caption);

  const response = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: "POST",
    body: formData
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `HTTP ${response.status}`);
  }
  return result;
}

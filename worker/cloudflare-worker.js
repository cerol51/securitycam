/**
 * Ev Güvenlik Kamerası — Cloudflare Worker (Ephemeral TURN + Güvenli Telegram Proxy)
 *
 * Gerekli Wrangler Secret / Env Değişkenleri:
 * - FIREBASE_WEB_API_KEY   : Firebase projenizin Web API anahtarı (ID Token doğrulama için)
 * - ALLOWED_ORIGIN         : İzin verilen frontend origin (örn: https://cerol51.github.io)
 * - ALLOWED_UIDS           : (Opsiyonel) Virgülle ayrılmış izinli Firebase UID listesi
 * - TELEGRAM_BOT_TOKEN     : (Telegram Proxy için) BotFather token'ı
 * - TELEGRAM_CHAT_ID       : (Telegram Proxy için) Varsayılan Chat ID
 * - CF_TURN_KEY_ID         : (Cloudflare Calls TURN için) TURN Token ID
 * - CF_TURN_API_TOKEN      : (Cloudflare Calls TURN için) TURN API Token
 */

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "*").trim();
  const allowOrigin =
    allowed === "*" || origin === allowed ? origin || allowed : allowed;

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

async function verifyFirebaseUser(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw { status: 401, message: "Yetkilendirme başlığı (Bearer token) eksik." };
  }
  if (!env.FIREBASE_WEB_API_KEY) {
    throw { status: 500, message: "Sunucuda FIREBASE_WEB_API_KEY tanımlı değil." };
  }

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: match[1] })
    }
  );
  const data = await res.json().catch(() => ({}));
  const user = data?.users?.[0];
  if (!res.ok || !user?.localId) {
    throw { status: 401, message: "Geçersiz veya süresi dolmuş Firebase oturumu." };
  }

  if (env.ALLOWED_UIDS) {
    const allowedSet = new Set(
      env.ALLOWED_UIDS.split(",").map((s) => s.trim()).filter(Boolean)
    );
    if (allowedSet.size > 0 && !allowedSet.has(user.localId)) {
      throw { status: 403, message: "Bu hesap bu proxy servisini kullanma yetkisine sahip değil." };
    }
  }

  return user;
}

async function handleTurnCredentials(env, headers) {
  if (!env.CF_TURN_KEY_ID || !env.CF_TURN_API_TOKEN) {
    return jsonResponse(
      { error: "Cloudflare TURN yapılandırılmamış.", iceServers: [] },
      501,
      headers
    );
  }

  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ttl: 3600 })
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return jsonResponse(
      { error: data?.errors?.[0]?.message || `Cloudflare TURN HTTP ${res.status}` },
      502,
      headers
    );
  }

  return jsonResponse({ iceServers: data.iceServers || [] }, 200, headers);
}

async function handleTelegramProxy(request, env, methodName, headers) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return jsonResponse({ ok: false, error: "Sunucuda TELEGRAM_BOT_TOKEN tanımlı değil." }, 501, headers);
  }

  const incoming = await request.formData();
  const outbound = new FormData();
  let hasChatId = false;

  for (const [key, value] of incoming.entries()) {
    if (key === "chat_id" && String(value).trim()) hasChatId = true;
    outbound.append(key, value);
  }

  if (!hasChatId) {
    if (!env.TELEGRAM_CHAT_ID) {
      return jsonResponse({ ok: false, error: "chat_id sağlanmadı ve TELEGRAM_CHAT_ID tanımlı değil." }, 400, headers);
    }
    outbound.set("chat_id", env.TELEGRAM_CHAT_ID);
  }

  const tgRes = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${methodName}`,
    { method: "POST", body: outbound }
  );
  const tgJson = await tgRes.json().catch(() => ({ ok: false, description: `HTTP ${tgRes.status}` }));
  return jsonResponse(tgJson, tgRes.status, headers);
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({
        ok: true,
        turnConfigured: Boolean(env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN),
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN)
      }, 200, headers);
    }

    try {
      await verifyFirebaseUser(request, env);

      if (url.pathname === "/turn-credentials" && request.method === "GET") {
        return await handleTurnCredentials(env, headers);
      }
      if (url.pathname === "/telegram/sendPhoto" && request.method === "POST") {
        return await handleTelegramProxy(request, env, "sendPhoto", headers);
      }
      if (url.pathname === "/telegram/sendVideo" && request.method === "POST") {
        return await handleTelegramProxy(request, env, "sendVideo", headers);
      }
      if (url.pathname === "/telegram/sendMessage" && request.method === "POST") {
        return await handleTelegramProxy(request, env, "sendMessage", headers);
      }

      return jsonResponse({ error: "Bilinmeyen endpoint." }, 404, headers);
    } catch (err) {
      const status = err?.status || 500;
      const message = err?.message || "Beklenmeyen sunucu hatası.";
      return jsonResponse({ ok: false, error: message }, status, headers);
    }
  }
};

// Dinamik WebRTC ICE / TURN yapılandırma yöneticisi ve bağlantı istatistik okuyucu

import { DEFAULT_ICE_SERVERS, RTC_BASE_CONFIG, LIMITS, STORAGE_KEYS } from "../config.js";
import { auth } from "./firebase.js";

let cachedTurnServers = null;
let cachedTurnExpiresAt = 0;

export function getNetworkSettings() {
  const proxyBaseUrl = (localStorage.getItem(STORAGE_KEYS.PROXY_URL) || "").trim().replace(/\/+$/, "");
  const turnUrlsRaw = (localStorage.getItem(STORAGE_KEYS.TURN_URLS) || "").trim();
  const turnUsername = (localStorage.getItem(STORAGE_KEYS.TURN_USER) || "").trim();
  const turnCredential = (localStorage.getItem(STORAGE_KEYS.TURN_PASS) || "").trim();
  return { proxyBaseUrl, turnUrlsRaw, turnUsername, turnCredential };
}

export function saveNetworkSettings({ proxyBaseUrl, turnUrlsRaw, turnUsername, turnCredential }) {
  localStorage.setItem(STORAGE_KEYS.PROXY_URL, (proxyBaseUrl || "").trim().replace(/\/+$/, ""));
  localStorage.setItem(STORAGE_KEYS.TURN_URLS, (turnUrlsRaw || "").trim());
  localStorage.setItem(STORAGE_KEYS.TURN_USER, (turnUsername || "").trim());
  localStorage.setItem(STORAGE_KEYS.TURN_PASS, (turnCredential || "").trim());
  invalidateTurnCache();
}

export function invalidateTurnCache() {
  cachedTurnServers = null;
  cachedTurnExpiresAt = 0;
}

function parseManualTurnServers({ turnUrlsRaw, turnUsername, turnCredential }) {
  if (!turnUrlsRaw) return [];
  const urls = turnUrlsRaw
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter(Boolean);
  if (urls.length === 0) return [];

  const entry = { urls };
  if (turnUsername) entry.username = turnUsername;
  if (turnCredential) entry.credential = turnCredential;
  return [entry];
}

async function fetchEphemeralTurnServers(proxyBaseUrl) {
  if (!proxyBaseUrl) return [];
  if (cachedTurnServers && Date.now() < cachedTurnExpiresAt) {
    return cachedTurnServers;
  }

  const user = auth.currentUser;
  if (!user) return [];

  const idToken = await user.getIdToken();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${proxyBaseUrl}/turn-credentials`, {
      method: "GET",
      headers: { Authorization: `Bearer ${idToken}` },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`TURN HTTP ${res.status}`);
    const data = await res.json();
    const servers = Array.isArray(data.iceServers)
      ? data.iceServers
      : data.iceServers
        ? [data.iceServers]
        : [];
    if (servers.length > 0) {
      cachedTurnServers = servers;
      cachedTurnExpiresAt = Date.now() + LIMITS.TURN_CACHE_TTL_MS;
    }
    return servers;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Aktif ICE sunucularını döndürür (Öncelik: Ephemeral Worker TURN -> Manuel TURN -> Varsayılan STUN).
 * Herhangi bir ağ hatasında bağlantıyı engellemeden STUN'a güvenli düşüş yapar.
 */
export async function getRtcConfig({ forceRefresh = false } = {}) {
  if (forceRefresh) invalidateTurnCache();

  const settings = getNetworkSettings();
  const iceServers = [...DEFAULT_ICE_SERVERS];
  let turnSource = "none";

  // 1) Ephemeral TURN (Cloudflare Worker / Function)
  if (settings.proxyBaseUrl) {
    try {
      const dynamicServers = await fetchEphemeralTurnServers(settings.proxyBaseUrl);
      if (dynamicServers.length > 0) {
        iceServers.push(...dynamicServers);
        turnSource = "proxy";
      }
    } catch (err) {
      console.warn("Dinamik TURN alınamadı, yedeğe düşülüyor:", err.message);
    }
  }

  // 2) Manuel TURN sunucusu (varsa)
  const manualServers = parseManualTurnServers(settings);
  if (manualServers.length > 0) {
    iceServers.push(...manualServers);
    turnSource = turnSource === "proxy" ? "proxy+manual" : "manual";
  }

  return {
    rtcConfig: {
      ...RTC_BASE_CONFIG,
      iceServers
    },
    turnSource,
    hasTurn: turnSource !== "none"
  };
}

/**
 * Aktif RTCPeerConnection üzerinden bağlantı tipini (P2P / TURN) ve gecikmeyi (RTT) okur.
 */
export async function inspectActiveConnectionStats(pc) {
  if (!pc || typeof pc.getStats !== "function") return null;
  try {
    const stats = await pc.getStats();
    let selectedPair = null;
    const localCandidates = new Map();
    const remoteCandidates = new Map();

    stats.forEach((report) => {
      if (report.type === "local-candidate") localCandidates.set(report.id, report);
      else if (report.type === "remote-candidate") remoteCandidates.set(report.id, report);
      else if (
        report.type === "candidate-pair" &&
        (report.nominated || report.selected) &&
        report.state === "succeeded"
      ) {
        selectedPair = report;
      }
    });

    if (!selectedPair) return null;

    const local = localCandidates.get(selectedPair.localCandidateId);
    const remote = remoteCandidates.get(selectedPair.remoteCandidateId);
    const isRelay = local?.candidateType === "relay" || remote?.candidateType === "relay";
    const rttMs =
      typeof selectedPair.currentRoundTripTime === "number"
        ? Math.round(selectedPair.currentRoundTripTime * 1000)
        : null;

    return {
      mode: isRelay ? "TURN" : "P2P",
      localType: local?.candidateType || "?",
      remoteType: remote?.candidateType || "?",
      rttMs
    };
  } catch (_) {
    return null;
  }
}

/**
 * Mevcut ICE/TURN yapılandırmasının relay/srflx adayı üretip üretemediğini hızlıca test eder.
 */
export async function testIceConfiguration() {
  const { rtcConfig, turnSource } = await getRtcConfig({ forceRefresh: true });
  const pc = new RTCPeerConnection(rtcConfig);
  const foundTypes = new Set();

  return await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { pc.close(); } catch (_) {}
      resolve({
        turnSource,
        types: Array.from(foundTypes),
        hasRelay: foundTypes.has("relay"),
        hasSrflx: foundTypes.has("srflx")
      });
    };

    const timer = setTimeout(finish, 4500);

    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        finish();
        return;
      }
      const match = e.candidate.candidate.match(/\btyp\s+(host|srflx|prflx|relay)\b/);
      if (match) {
        foundTypes.add(match[1]);
        if (foundTypes.has("relay")) finish();
      }
    };

    pc.createDataChannel("ice-test");
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(finish);
  });
}

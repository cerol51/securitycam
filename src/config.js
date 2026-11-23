// Uygulama yapılandırması ve sistem sabitleri

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyB0DKFBgJXCVdVALdbsS7xERIR48elErQQ",
  authDomain: "camera-5151.firebaseapp.com",
  databaseURL: "https://camera-5151-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "camera-5151",
  storageBucket: "camera-5151.firebasestorage.app",
  messagingSenderId: "633768477814",
  appId: "1:633768477814:web:53485b8ca5063aeeab4b57",
  measurementId: "G-8K16PEFD9R"
};

export const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" }
];

export const RTC_BASE_CONFIG = {
  iceCandidatePoolSize: 4
};

// İzleyici profiline göre kamera upload bitrate ve çözünürlük ölçekleme hedefleri
export const VIDEO_PROFILES = {
  single: {
    "720p": { maxBitrate: 900_000, scaleResolutionDownBy: 1, maxFramerate: 12 },
    "480p": { maxBitrate: 500_000, scaleResolutionDownBy: 1, maxFramerate: 12 }
  },
  grid: {
    "720p": { maxBitrate: 250_000, scaleResolutionDownBy: 2, maxFramerate: 8 },
    "480p": { maxBitrate: 200_000, scaleResolutionDownBy: 1.5, maxFramerate: 8 }
  }
};

export const LIMITS = {
  MAX_VIEWERS: 4,
  MAX_GRID_CAMERAS: 4,
  SIREN_MAX_DURATION_MS: 60_000,
  VIDEO_BITRATE_BPS: 600_000,
  VIEWER_MAX_AUTO_RETRIES: 3,
  VIEWER_DISCONNECT_GRACE_MS: 5_000,
  TURN_CACHE_TTL_MS: 10 * 60_000
};

export const MOTION_CONFIG = {
  WIDTH: 64,
  HEIGHT: 36,
  PIXEL_DIFF_LIMIT: 26,
  CHECK_INTERVAL_MS: 400,
  REQUIRED_CONSECUTIVE: 2
};

export const STORAGE_KEYS = {
  PROXY_URL: "cam_proxy_base_url",
  TURN_URLS: "cam_turn_urls",
  TURN_USER: "cam_turn_username",
  TURN_PASS: "cam_turn_credential"
};

export const DB_PATHS = {
  CONNECTED: ".info/connected",
  directory: (uid) => `users/${uid}/directory`,
  roomDir: (uid, room) => `users/${uid}/directory/${room}`,
  roomMeta: (uid, room) => `users/${uid}/rooms/${room}/meta`,
  roomSessionId: (uid, room) => `users/${uid}/rooms/${room}/meta/sessionId`,
  roomViewers: (uid, room) => `users/${uid}/rooms/${room}/viewers`,
  roomViewer: (uid, room, viewerId) => `users/${uid}/rooms/${room}/viewers/${viewerId}`,
  roomCommands: (uid, room) => `users/${uid}/rooms/${room}/commands`,
  roomSnapshot: (uid, room) => `users/${uid}/rooms/${room}/snapshot`
};

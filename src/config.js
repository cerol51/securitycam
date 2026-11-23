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

export const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
  ],
  iceCandidatePoolSize: 4
};

export const LIMITS = {
  MAX_VIEWERS: 4,
  MAX_GRID_CAMERAS: 4,
  SIREN_MAX_DURATION_MS: 60_000,
  VIDEO_BITRATE_BPS: 600_000,
  VIEWER_MAX_AUTO_RETRIES: 3,
  VIEWER_DISCONNECT_GRACE_MS: 5_000
};

export const MOTION_CONFIG = {
  WIDTH: 64,
  HEIGHT: 36,
  PIXEL_DIFF_LIMIT: 26,
  CHECK_INTERVAL_MS: 400,
  REQUIRED_CONSECUTIVE: 2
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

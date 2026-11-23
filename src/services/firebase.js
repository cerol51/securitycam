// Firebase SDK başlatma ve ortak dışa aktarımlar

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getDatabase,
  ref,
  set,
  update,
  push,
  remove,
  onValue,
  onChildAdded,
  onChildRemoved,
  onDisconnect,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { FIREBASE_CONFIG } from "../config.js";

export const app = initializeApp(FIREBASE_CONFIG);
export const auth = getAuth(app);
export const db = getDatabase(app);

export {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  ref,
  set,
  update,
  push,
  remove,
  onValue,
  onChildAdded,
  onChildRemoved,
  onDisconnect,
  serverTimestamp
};

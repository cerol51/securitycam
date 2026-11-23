// İzleyici Bas-Konuş (Push-to-Talk) ses motoru

import { $, appState } from "../state.js";

export class PushToTalk {
  constructor() {
    this.audioCtx = null;
    this.dummyOsc = null;
    this.dummyTrack = null;
    this.micStream = null;
    this.micTrack = null;
    this.audioSender = null;
    this.isTalking = false;
    this.wasRemoteMutedBeforePtt = true;

    this._bindEvents();
  }

  _bindEvents() {
    const btn = $("pttBtn");
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
    btn.addEventListener("pointerdown", async (e) => {
      if (btn.disabled) return;
      e.preventDefault();
      if (!this.micTrack || this.micTrack.readyState !== "live") {
        await this.prepareMic();
        return;
      }
      if (btn.setPointerCapture) {
        try { btn.setPointerCapture(e.pointerId); } catch (_) {}
      }
      this.startTalking();
    });

    ["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => {
      btn.addEventListener(ev, () => this.stopTalking());
    });
    window.addEventListener("blur", () => this.stopTalking());
  }

  ensureDummyAudio() {
    if (this.dummyTrack && this.dummyTrack.readyState === "live") return this.dummyTrack;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    this.audioCtx = this.audioCtx || new AudioCtx();
    if (this.audioCtx.state === "suspended") this.audioCtx.resume().catch(() => {});

    const dest = this.audioCtx.createMediaStreamDestination();
    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(dest);
    osc.start();

    this.dummyOsc = osc;
    this.dummyTrack = dest.stream.getAudioTracks()[0];
    return this.dummyTrack;
  }

  async attachToPeer(pc) {
    const audioTr = pc.getTransceivers().find(
      (t) =>
        (t.receiver && t.receiver.track && t.receiver.track.kind === "audio") ||
        (t.sender && t.sender.track && t.sender.track.kind === "audio")
    );
    if (!audioTr) return;

    const trackToAttach =
      this.micTrack && this.micTrack.readyState === "live"
        ? this.micTrack
        : this.ensureDummyAudio();

    if (trackToAttach) {
      await audioTr.sender.replaceTrack(trackToAttach);
      audioTr.direction = "sendrecv";
      this.audioSender = audioTr.sender;
    }
  }

  onConnectionLive() {
    $("pttBtn").disabled = !this.audioSender;
    if (this.audioSender) {
      $("pttBtn").textContent = this.micTrack
        ? "Basılı Tut ve Konuş"
        : "Mikrofonu Etkinleştir (Bas-Konuş)";
      $("pttStatus").textContent = this.micTrack
        ? "Mikrofon hazır. Konuşmak için butona basılı tut."
        : "İlk dokunuşta mikrofon izni alınır, sonra basılı tutarak konuşabilirsin.";
    }
  }

  onConnectionLost() {
    this.stopTalking();
    $("pttBtn").disabled = true;
  }

  detachSender() {
    this.stopTalking();
    this.audioSender = null;
    $("pttBtn").disabled = true;
    $("pttStatus").textContent = "Canlı bağlantı kurulduğunda kameraya seslenebilirsin.";
  }

  async prepareMic() {
    $("pttStatus").textContent = "Mikrofon izni isteniyor...";
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      this.micTrack = this.micStream.getAudioTracks()[0];
      this.micTrack.enabled = false;

      if (this.audioSender) await this.audioSender.replaceTrack(this.micTrack);
      $("pttBtn").textContent = "Basılı Tut ve Konuş";
      $("pttStatus").textContent = "Mikrofon hazır. Konuşmak için butona basılı tut.";
    } catch (err) {
      $("pttStatus").textContent = "Mikrofon izni alınamadı: " + err.message;
    }
  }

  startTalking() {
    if (this.isTalking || !this.micTrack || !this.audioSender) return;
    this.isTalking = true;
    this.wasRemoteMutedBeforePtt = $("remoteVideo").muted;
    $("remoteVideo").muted = true;

    this.micTrack.enabled = true;
    $("pttBtn").classList.add("talking");
    $("pttBtn").textContent = "KONUŞULUYOR... (Bırakınca Kesilir)";
    $("pttStatus").textContent = `Sesin ${appState.currentRoom} kamerasına iletiliyor...`;
  }

  stopTalking() {
    if (!this.isTalking) return;
    this.isTalking = false;
    if (this.micTrack) this.micTrack.enabled = false;
    $("remoteVideo").muted = this.wasRemoteMutedBeforePtt;
    $("pttBtn").classList.remove("talking");
    $("pttBtn").textContent = this.micTrack
      ? "Basılı Tut ve Konuş"
      : "Mikrofonu Etkinleştir (Bas-Konuş)";
    $("pttStatus").textContent = "Mikrofon kapalı. Konuşmak için tekrar basılı tut.";
  }

  releaseAll() {
    this.stopTalking();
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
      this.micTrack = null;
    }
    if (this.dummyOsc) {
      try { this.dummyOsc.stop(); } catch (_) {}
      this.dummyOsc = null;
    }
    if (this.dummyTrack) {
      try { this.dummyTrack.stop(); } catch (_) {}
      this.dummyTrack = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.audioSender = null;
    $("pttBtn").textContent = "Mikrofonu Etkinleştir (Bas-Konuş)";
    $("pttBtn").disabled = true;
  }
}

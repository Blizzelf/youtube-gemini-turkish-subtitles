// Shows the translated subtitles over the YouTube player and adds an on/off button to the
// control bar. Loaded before content.js (same isolated world).
// Video time is read from the <video> element; the DOM is written only via textContent.
// The button's labels are shown to the user, so they stay Turkish.

const OVERLAY_STORAGE_KEY = "overlayEnabled";
const OVERLAY_FONT_RATIO = 0.042; // Font size / player height
const OVERLAY_MIN_FONT_PX = 14;
const OVERLAY_MAX_LINES = 2; // Maximum lines shown at once (for overlapping captions)
const OVERLAY_LOOKBACK = 5; // Lines to look back for overlaps

class SubtitleOverlay {
  constructor() {
    this.cues = [];
    this.enabled = true;
    this.status = "idle"; // idle | loading | ready | error
    this.statusText = "";
    this.player = null;
    this.video = null;
    this.frame = null;
    this.lastText = null;
    this.onSeek = null; // content.js: moves the seeked position to the front while translating

    this.container = document.createElement("div");
    this.container.className = "yt-ceviri-overlay";
    this.container.hidden = true;
    this.textEl = document.createElement("div");
    this.textEl.className = "yt-ceviri-text";
    this.container.append(this.textEl);

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "ytp-button yt-ceviri-button";
    this.button.textContent = "TR";
    this.button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setEnabled(!this.enabled);
    });

    this.resizeObserver = new ResizeObserver(() => this.updateLayout());
    this.render = this.render.bind(this);
    this.videoListeners = {
      play: () => this.startLoop(),
      playing: () => this.startLoop(),
      pause: () => this.stopLoop(),
      ended: () => this.stopLoop(),
      seeked: () => {
        this.render();
        this.onSeek?.(this.video.currentTime);
      },
      // requestAnimationFrame stops in background tabs; timeupdate still keeps things current.
      timeupdate: this.render,
    };

    chrome.storage.local
      .get(OVERLAY_STORAGE_KEY)
      .then((stored) => {
        if (stored[OVERLAY_STORAGE_KEY] === false) this.setEnabled(false, { save: false });
      })
      .catch(() => {});
  }

  // The player and video element can change; connections are checked on every call.
  attach() {
    const player = document.getElementById("movie_player");
    const video = player?.querySelector("video.html5-main-video");
    if (!player || !video) return false;

    if (player !== this.player) {
      this.player = player;
      this.resizeObserver.disconnect();
      this.resizeObserver.observe(player);
    }
    if (this.container.parentElement !== player) player.append(this.container);

    if (video !== this.video) {
      for (const [type, listener] of Object.entries(this.videoListeners)) {
        this.video?.removeEventListener(type, listener);
        video.addEventListener(type, listener);
      }
      this.video = video;
      if (!video.paused) this.startLoop();
    }

    this.ensureButton();
    this.updateLayout();
    this.updatePlayerClass();
    return true;
  }

  // The button goes to the left of the CC button. Re-added if YouTube redraws its controls.
  ensureButton() {
    const ccButton = this.player.querySelector(".ytp-subtitles-button");
    const parent = ccButton?.parentElement || this.player.querySelector(".ytp-right-controls");
    if (!parent) return;
    if (this.button.parentElement !== parent) {
      parent.insertBefore(this.button, ccButton || parent.firstChild);
    }
    this.updateButton();
  }

  // Does not change the status: while translating, finished chunks are shown and the status
  // stays "loading".
  setCues(cues) {
    this.cues = Array.isArray(cues) ? cues : [];
    this.lastText = null;
    this.updatePlayerClass();
    if (this.attach() && !this.video.paused) this.startLoop();
    this.render();
  }

  currentTime() {
    return this.video?.currentTime ?? 0;
  }

  clear() {
    this.cues = [];
    this.lastText = null;
    this.stopLoop();
    this.setStatus("idle", "");
    this.render();
  }

  setStatus(status, text) {
    this.status = status;
    this.statusText = text || "";
    this.updatePlayerClass();
    this.updateButton();
  }

  setEnabled(enabled, { save = true } = {}) {
    this.enabled = enabled;
    if (save) chrome.storage.local.set({ [OVERLAY_STORAGE_KEY]: enabled }).catch(() => {});
    this.lastText = null;
    this.updatePlayerClass();
    this.updateButton();
    this.render();
  }

  updateButton() {
    const button = this.button;
    button.hidden = this.status === "idle" && !this.statusText;
    button.classList.toggle("is-loading", this.status === "loading");
    button.classList.toggle("is-error", this.status === "error");
    button.classList.toggle("is-idle", this.status === "idle");
    // The preference is shown while translating too; otherwise the button looks off and a
    // user pressing it to "turn it on" would actually turn the subtitles off.
    button.setAttribute("aria-pressed", String(this.enabled && this.status !== "idle"));

    const state = this.enabled ? "açık" : "kapalı";
    const title =
      this.status === "ready"
        ? `${this.statusText}: ${state} (tıklayarak değiştirin)`
        : `${this.statusText || "Türkçe altyazı"} · Türkçe altyazı ${state}`;
    button.title = title;
    button.setAttribute("aria-label", title);
  }

  // While the overlay is visible, YouTube's own captions are hidden (CSS, overlay.css).
  updatePlayerClass() {
    this.player?.classList.toggle("yt-ceviri-on", this.enabled && this.cues.length > 0);
  }

  // Font size follows the player height. While the controls are visible the subtitles sit
  // above the progress bar; the controls are hidden via opacity, so the measurement is always valid.
  updateLayout() {
    if (!this.player) return;
    const size = Math.max(OVERLAY_MIN_FONT_PX, Math.round(this.player.clientHeight * OVERLAY_FONT_RATIO));
    this.container.style.setProperty("--yt-ceviri-font-size", `${size}px`);

    const controls =
      this.player.querySelector(".ytp-progress-bar-container") || this.player.querySelector(".ytp-chrome-bottom");
    if (controls) {
      const offset = this.player.getBoundingClientRect().bottom - controls.getBoundingClientRect().top;
      if (offset > 0) this.container.style.setProperty("--yt-ceviri-controls-offset", `${Math.round(offset) + 8}px`);
    }
  }

  // Finds the last line with start <= time by binary search; also collects overlapping lines.
  findActiveText(time) {
    const cues = this.cues;
    let low = 0;
    let high = cues.length - 1;
    let index = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (cues[middle].start <= time) {
        index = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    const lines = [];
    for (let i = index; i >= 0 && i > index - OVERLAY_LOOKBACK && lines.length < OVERLAY_MAX_LINES; i--) {
      if (time < cues[i].start + cues[i].duration) lines.unshift(cues[i].text);
    }
    return lines.join("\n");
  }

  render() {
    const active = this.enabled && this.cues.length > 0 && this.video;
    const text = active ? this.findActiveText(this.video.currentTime) : "";
    if (text === this.lastText) return;
    this.lastText = text;
    this.textEl.textContent = text;
    this.container.hidden = !text;
  }

  startLoop() {
    if (this.frame !== null) return;
    const tick = () => {
      this.render();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stopLoop() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.render();
  }
}

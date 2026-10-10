// Shows the translated subtitles over the YouTube player and adds a button to the control bar
// that opens the subtitle menu (menu.js). Loaded before menu.js and content.js (same isolated
// world). In dual mode the original line is shown together with the translation; how both
// look is set in the menu and stored under SETTINGS_STORAGE_KEY.
// Video time is read from the <video> element; the DOM is written only via textContent.
// Labels shown to the user stay Turkish.

const OVERLAY_STORAGE_KEY = "overlayEnabled";
const SETTINGS_STORAGE_KEY = "subtitleSettings";
const OVERLAY_FONT_RATIO = 0.042; // Font size / player height
const OVERLAY_MIN_FONT_PX = 14;
const OVERLAY_MAX_LINES = 2; // Maximum lines shown at once (for overlapping captions)
const OVERLAY_LOOKBACK = 5; // Lines to look back for overlaps
const SUBTITLE_SIZE_LIMITS = { min: 50, max: 200, step: 10 }; // Percent of the base size
const SUBTITLE_BACKGROUND_LIMITS = { min: 0, max: 100, step: 10 }; // Percent opacity

// System fonts only, so nothing is downloaded; each stack falls back on other systems.
const SUBTITLE_FONTS = {
  youtube: { label: "YouTube", stack: '"YouTube Noto", Roboto, Arial, sans-serif' },
  arial: { label: "Arial", stack: "Arial, Helvetica, sans-serif" },
  verdana: { label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  trebuchet: { label: "Trebuchet", stack: '"Trebuchet MS", Tahoma, sans-serif' },
  segoe: { label: "Segoe UI", stack: '"Segoe UI", system-ui, sans-serif' },
  georgia: { label: "Georgia", stack: "Georgia, serif" },
  times: { label: "Times", stack: '"Times New Roman", Times, serif' },
  consolas: { label: "Consolas", stack: 'Consolas, "Courier New", monospace' },
  comic: { label: "Comic Sans", stack: '"Comic Sans MS", "Comic Neue", cursive' },
};
const SUBTITLE_EDGES = { none: "Yok", shadow: "Gölge", outline: "Kontur", raised: "Kabartma" };
const SUBTITLE_MODES = { translation: "Yalnız çeviri", dual: "Çift dil" };

const DEFAULT_SUBTITLE_SETTINGS = {
  mode: "translation",
  translationFirst: false, // Dual mode: the original above, the translation below
  translation: { size: 100, color: "#ffffff", font: "youtube", bold: false },
  original: { size: 85, color: "#ffffff", font: "youtube", bold: false },
  background: 75,
  blur: false,
  edge: "none",
};

// Stored settings come back through chrome.storage; every field is checked and falls back to
// its default.
function normalizeSubtitleSettings(stored) {
  const value = stored && typeof stored === "object" ? stored : {};
  const defaults = DEFAULT_SUBTITLE_SETTINGS;
  const isBoolean = (field) => typeof field === "boolean";
  const inRange = ({ min, max }) => (field) => Number.isFinite(field) && field >= min && field <= max;
  const pick = (field, valid, fallback) => (valid(field) ? field : fallback);
  const line = (stored, fallback) => {
    const lineValue = stored && typeof stored === "object" ? stored : {};
    return {
      size: pick(lineValue.size, inRange(SUBTITLE_SIZE_LIMITS), fallback.size),
      color: pick(lineValue.color, (color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color), fallback.color),
      font: pick(lineValue.font, (font) => Object.hasOwn(SUBTITLE_FONTS, font), fallback.font),
      bold: pick(lineValue.bold, isBoolean, fallback.bold),
    };
  };
  return {
    mode: pick(value.mode, (mode) => Object.hasOwn(SUBTITLE_MODES, mode), defaults.mode),
    translationFirst: pick(value.translationFirst, isBoolean, defaults.translationFirst),
    translation: line(value.translation, defaults.translation),
    original: line(value.original, defaults.original),
    background: pick(value.background, inRange(SUBTITLE_BACKGROUND_LIMITS), defaults.background),
    blur: pick(value.blur, isBoolean, defaults.blur),
    edge: pick(value.edge, (edge) => Object.hasOwn(SUBTITLE_EDGES, edge), defaults.edge),
  };
}

class SubtitleOverlay {
  constructor() {
    // Every caption line: { start, duration, original, text }. text is the translation (null
    // until translated); original is null when the captions are already Turkish.
    this.cues = [];
    this.hasText = false; // At least one line is translated
    this.enabled = true;
    this.status = "idle"; // idle | available | loading | ready | error
    this.statusText = "";
    this.settings = normalizeSubtitleSettings(null);
    this.player = null;
    this.video = null;
    this.frame = null;
    this.lastKey = null;
    this.onSeek = null; // content.js: moves the seeked position to the front while translating
    this.onRequest = null; // content.js: starts (or retries) translating the current video
    this.onRetranslate = null; // content.js: translates the video again with the selected model

    this.container = document.createElement("div");
    this.container.className = "yt-ceviri-overlay";
    this.container.hidden = true;
    this.originalEl = this.createLine("is-original");
    this.translationEl = this.createLine("is-translation");
    this.container.append(this.originalEl, this.translationEl);

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "ytp-button yt-ceviri-button";
    this.button.textContent = "TR";
    this.button.setAttribute("aria-haspopup", "menu");
    this.button.setAttribute("aria-expanded", "false");
    this.button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.menu.toggle();
    });
    this.menu = new SubtitleMenu(this);

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

    this.applySettings();
    chrome.storage.local
      .get([OVERLAY_STORAGE_KEY, SETTINGS_STORAGE_KEY])
      .then((stored) => {
        if (stored[OVERLAY_STORAGE_KEY] === false) this.setEnabled(false, { save: false });
        this.settings = normalizeSubtitleSettings(stored[SETTINGS_STORAGE_KEY]);
        this.applySettings();
      })
      .catch(() => {});
    // Settings changed in another tab.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[SETTINGS_STORAGE_KEY]) return;
      this.settings = normalizeSubtitleSettings(changes[SETTINGS_STORAGE_KEY].newValue);
      this.applySettings();
    });
  }

  createLine(className) {
    const line = document.createElement("div");
    line.className = `yt-ceviri-line ${className}`;
    line.hidden = true;
    const text = document.createElement("span");
    text.className = "yt-ceviri-text";
    line.append(text);
    return line;
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
    this.hasText = this.cues.some((cue) => cue.text);
    this.lastKey = null;
    this.updatePlayerClass();
    this.updateButton();
    if (this.attach() && !this.video.paused) this.startLoop();
    this.render();
  }

  currentTime() {
    return this.video?.currentTime ?? 0;
  }

  clear() {
    this.cues = [];
    this.hasText = false;
    this.lastKey = null;
    this.menu.close();
    this.stopLoop();
    this.setStatus("idle", "");
    this.render();
  }

  // The button opens the menu, so it is (re)inserted on every status change.
  setStatus(status, text) {
    this.status = status;
    this.statusText = text || "";
    if (status !== "idle") this.attach();
    this.updatePlayerClass();
    this.updateButton();
  }

  // The menu's switch starts the translation when none has been requested yet, or retries a
  // failed attempt that left nothing on screen.
  canRequest() {
    return this.status === "available" || (this.status === "error" && !this.hasText);
  }

  // The preference is shown while translating too; otherwise the switch looks off and a user
  // turning it "on" would actually turn the subtitles off.
  isShowing() {
    return this.enabled && (this.status === "loading" || this.status === "ready" || this.hasText);
  }

  // The menu's "Türkçe altyazı" switch.
  toggleSubtitles() {
    if (this.canRequest()) this.onRequest?.();
    else if (this.status !== "idle") this.setEnabled(!this.enabled);
  }

  setEnabled(enabled, { save = true } = {}) {
    this.enabled = enabled;
    if (save) chrome.storage.local.set({ [OVERLAY_STORAGE_KEY]: enabled }).catch(() => {});
    this.lastKey = null;
    this.updatePlayerClass();
    this.updateButton();
    this.render();
  }

  // change holds top-level fields; a line (translation/original) is replaced as a whole.
  // save is false while a color is being picked, so storage is written only once at the end.
  updateSettings(change, { save = true } = {}) {
    this.settings = normalizeSubtitleSettings({ ...this.settings, ...change });
    if (save) chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: this.settings }).catch(() => {});
    this.applySettings();
  }

  // The mode is not a style setting and stays as it is.
  resetStyle() {
    this.updateSettings({ ...DEFAULT_SUBTITLE_SETTINGS, mode: this.settings.mode });
  }

  applySettings() {
    const settings = this.settings;
    this.container.classList.toggle("translation-first", settings.translationFirst);
    this.container.classList.toggle("has-blur", settings.blur);
    for (const edge of Object.keys(SUBTITLE_EDGES)) {
      this.container.classList.toggle(`edge-${edge}`, settings.edge === edge);
    }
    this.container.style.setProperty("--yt-ceviri-background", `rgba(8, 8, 8, ${settings.background / 100})`);
    this.styleLine(this.translationEl, settings.translation);
    this.styleLine(this.originalEl, settings.original);
    this.lastKey = null;
    this.updatePlayerClass();
    this.render();
    this.menu.refresh();
  }

  styleLine(line, style) {
    line.style.setProperty("--yt-ceviri-scale", String(style.size / 100));
    line.style.setProperty("--yt-ceviri-color", style.color);
    line.style.setProperty("--yt-ceviri-font", SUBTITLE_FONTS[style.font].stack);
    line.style.setProperty("--yt-ceviri-weight", style.bold ? "700" : "400");
  }

  updateButton() {
    const button = this.button;
    button.hidden = this.status === "idle" && !this.statusText;
    button.classList.toggle("is-loading", this.status === "loading");
    button.classList.toggle("is-error", this.status === "error");
    button.classList.toggle("is-idle", this.status === "idle");
    button.classList.toggle("is-available", this.status === "available");
    button.setAttribute("aria-pressed", String(this.isShowing()));

    const title = this.status === "available" || !this.statusText ? "Türkçe altyazı" : this.statusText;
    button.title = title;
    button.setAttribute("aria-label", title);
    this.menu.refresh();
  }

  // While the overlay is visible, YouTube's own captions are hidden (CSS, overlay.css). In dual
  // mode the original is shown before any line is translated.
  updatePlayerClass() {
    const visible = this.hasText || (this.settings.mode === "dual" && this.cues.length > 0);
    this.player?.classList.toggle("yt-ceviri-on", this.enabled && visible);
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
    this.menu.updateLayout();
  }

  // Finds the last line with start <= time by binary search; also collects overlapping lines.
  findActiveLines(time) {
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

    const active = [];
    for (let i = index; i >= 0 && i > index - OVERLAY_LOOKBACK && active.length < OVERLAY_MAX_LINES; i--) {
      if (time < cues[i].start + cues[i].duration) active.unshift(cues[i]);
    }
    return {
      translation: active.map((cue) => cue.text).filter(Boolean).join("\n"),
      original: active.map((cue) => cue.original).filter(Boolean).join("\n"),
    };
  }

  render() {
    let translation = "";
    let original = "";
    if (this.enabled && this.cues.length > 0 && this.video) {
      ({ translation, original } = this.findActiveLines(this.video.currentTime));
      if (this.settings.mode !== "dual") original = "";
    }
    const key = `${original}\u0000${translation}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.translationEl.firstChild.textContent = translation;
    this.translationEl.hidden = !translation;
    this.originalEl.firstChild.textContent = original;
    this.originalEl.hidden = !original;
    this.container.hidden = !translation && !original;
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

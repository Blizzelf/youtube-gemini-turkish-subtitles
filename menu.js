// Menu that opens from the TR button, styled like YouTube's own settings menu. Loaded after
// overlay.js and before content.js (same isolated world).
// Main view: Turkish subtitles on/off with the status, subtitle mode, model, subtitle style,
// re-translating the video, auto-translate and the settings page. The style view sets the
// look of the translation and of the original line (dual mode).
// All text here is shown to the user, so it is Turkish. The DOM is built with createElement
// and textContent only.

const MENU_MODEL_KEY = "geminiModel"; // Same keys as popup.js; background.js and content.js read them
const MENU_AUTO_TRANSLATE_KEY = "autoTranslate";
// The first model is background.js's default.
const MENU_MODELS = [
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "Ucuz, varsayılan" },
  { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", hint: "Daha iyi çeviri" },
];
const MENU_MODE_OPTIONS = [
  { value: "translation", label: SUBTITLE_MODES.translation, hint: "Yalnızca Türkçe altyazı" },
  { value: "dual", label: SUBTITLE_MODES.dual, hint: "Orijinal ve Türkçe birlikte" },
];
const MENU_CONFIRM_MS = 4000; // How long the re-translate confirmation stays
const MENU_SVG_NS = "http://www.w3.org/2000/svg";
// 24x24 line icons, drawn with the text color.
const MENU_ICONS = {
  subtitles: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M7 11h3 M13 11h4 M7 15h6 M16 15h1",
  mode: "M4 7h16 M4 11h11 M4 15h16 M4 19h11",
  model: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  style: "M3 18l5-12 5 12 M4.7 14h6.6 M15 12.5a2.5 2.5 0 0 1 5 0V18 M20 15c-3 0-5 .6-5 1.8s2.4 1.6 5 .2",
  retranslate: "M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7",
  auto: "M13 2 4 14h7l-1 8 9-12h-7z",
  settings: "M4 7h9 M17 7h3 M15 5v4 M4 12h3 M11 12h9 M9 10v4 M4 17h11 M19 17h1 M17 15v4",
};
// Events inside the menu must not reach the player (play/pause, fullscreen, shortcuts).
const MENU_STOPPED_EVENTS = ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "keydown", "keyup", "keypress", "contextmenu"];

function menuElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function menuButton(className, text) {
  const button = menuElement("button", className, text);
  button.type = "button";
  return button;
}

function menuIcon(name) {
  const svg = document.createElementNS(MENU_SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("yt-ceviri-menu-icon");
  const path = document.createElementNS(MENU_SVG_NS, "path");
  path.setAttribute("d", MENU_ICONS[name]);
  svg.append(path);
  return svg;
}

function setSwitch(button, toggle, on) {
  toggle.classList.toggle("is-on", on);
  button.setAttribute("aria-checked", String(on));
}

// Storage calls throw synchronously once the extension has been reloaded; the menu keeps working.
function saveMenuPreference(key, value) {
  try {
    chrome.storage.local.set({ [key]: value }).catch(() => {});
  } catch {}
}

class SubtitleMenu {
  constructor(overlay) {
    this.overlay = overlay;
    this.view = "main";
    this.model = MENU_MODELS[0].value;
    this.autoTranslate = false;
    this.refs = null; // Main view nodes that refresh() updates in place
    this.confirmTimer = null;

    this.root = menuElement("div", "yt-ceviri-menu");
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Türkçe altyazı");
    for (const type of MENU_STOPPED_EVENTS) {
      this.root.addEventListener(type, (event) => event.stopPropagation());
    }
    this.root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      this.close();
      this.overlay.button.focus();
    });
    this.onOutsidePointer = (event) => {
      if (!this.root.contains(event.target) && !this.overlay.button.contains(event.target)) this.close();
    };
  }

  get isOpen() {
    return !this.root.hidden;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    const player = this.overlay.player;
    if (!player) return;
    if (this.root.parentElement !== player) player.append(this.root);
    this.root.hidden = false;
    this.overlay.button.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", this.onOutsidePointer, true);
    this.show("main");
    this.updateLayout();
    this.loadPreferences();
  }

  close() {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.resetConfirm();
    this.overlay.button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.onOutsidePointer, true);
  }

  async loadPreferences() {
    try {
      const stored = await chrome.storage.local.get([MENU_MODEL_KEY, MENU_AUTO_TRANSLATE_KEY]);
      const model = stored[MENU_MODEL_KEY];
      this.model = MENU_MODELS.some((option) => option.value === model) ? model : MENU_MODELS[0].value;
      this.autoTranslate = stored[MENU_AUTO_TRANSLATE_KEY] === true;
    } catch {}
    this.refresh();
  }

  // Above the control bar, at the right edge like YouTube's settings menu; scrolls in small players.
  updateLayout() {
    const player = this.overlay.player;
    if (!player || !this.isOpen) return;
    const controls = player.querySelector(".ytp-chrome-bottom");
    const offset = controls ? player.getBoundingClientRect().bottom - controls.getBoundingClientRect().top : 48;
    const bottom = Math.max(0, Math.round(offset)) + 12;
    this.root.style.bottom = `${bottom}px`;
    this.root.style.maxHeight = `${Math.max(120, player.clientHeight - bottom - 12)}px`;
  }

  // Called by the overlay on every status and settings change. Only the main view is updated,
  // so an open color picker or list in another view is never rebuilt under the user.
  refresh() {
    if (!this.isOpen || this.view !== "main" || !this.refs) return;
    const { overlay, refs } = this;
    setSwitch(refs.subtitles.button, refs.subtitles.toggle, overlay.isShowing());
    refs.subtitles.sub.textContent = this.statusLine();
    refs.mode.value.textContent = SUBTITLE_MODES[overlay.settings.mode];
    refs.model.value.textContent = MENU_MODELS.find((option) => option.value === this.model).label.replace("Gemini ", "");
    setSwitch(refs.auto.button, refs.auto.toggle, this.autoTranslate);
    refs.retranslate.button.disabled = overlay.status === "idle";
  }

  statusLine() {
    const { status, statusText } = this.overlay;
    if (status === "available") return "Açınca bu video çevrilir";
    if (status === "ready") return "Hazır";
    return statusText;
  }

  show(view) {
    this.view = view;
    this.refs = null;
    this.resetConfirm();
    const build = {
      main: () => this.buildMain(),
      mode: () =>
        this.buildChoice("Altyazı modu", MENU_MODE_OPTIONS, this.overlay.settings.mode, (mode) =>
          this.overlay.updateSettings({ mode })
        ),
      model: () =>
        this.buildChoice(
          "Çeviri modeli",
          MENU_MODELS,
          this.model,
          (model) => {
            this.model = model;
            saveMenuPreference(MENU_MODEL_KEY, model);
          },
          "Yeni başlayan çevirilerde geçerli olur. Çevrilmiş bir videoyu değiştirmek için \"Bu videoyu yeniden çevir\"i kullanın."
        ),
      style: () => this.buildStyle(),
    }[view];
    const content = build();
    this.refresh(); // Before the view is shown, so the switches do not animate into place
    this.root.replaceChildren(content);
    this.root.scrollTop = 0;
  }

  // --- Main view ---

  item({ icon, label, sub = "", value, next = false, toggle = false }) {
    const button = menuButton("yt-ceviri-menu-item");
    const text = menuElement("span", "yt-ceviri-menu-text");
    const subEl = menuElement("span", "yt-ceviri-menu-sub", sub);
    text.append(menuElement("span", "yt-ceviri-menu-label", label), subEl);
    button.append(menuIcon(icon), text);
    const refs = { button, sub: subEl };
    if (value !== undefined) {
      refs.value = menuElement("span", "yt-ceviri-menu-value", value);
      button.append(refs.value);
    }
    if (next) button.append(menuElement("span", "yt-ceviri-menu-chevron", "›"));
    if (toggle) {
      refs.toggle = menuElement("span", "yt-ceviri-switch");
      button.setAttribute("role", "switch");
      button.append(refs.toggle);
    }
    return refs;
  }

  buildMain() {
    const overlay = this.overlay;
    const subtitles = this.item({ icon: "subtitles", label: "Türkçe altyazı", toggle: true });
    subtitles.button.addEventListener("click", () => overlay.toggleSubtitles());
    const mode = this.item({ icon: "mode", label: "Altyazı modu", value: "", next: true });
    mode.button.addEventListener("click", () => this.show("mode"));
    const model = this.item({ icon: "model", label: "Çeviri modeli", value: "", next: true });
    model.button.addEventListener("click", () => this.show("model"));
    const style = this.item({ icon: "style", label: "Altyazı ayarları", next: true });
    style.button.addEventListener("click", () => this.show("style"));

    const retranslate = this.item({ icon: "retranslate", label: "Bu videoyu yeniden çevir", sub: "Seçili modelle baştan çevirir" });
    retranslate.button.addEventListener("click", () => this.confirmRetranslate(retranslate));
    const auto = this.item({ icon: "auto", label: "Otomatik çevir", sub: "Her videoyu tıklamadan çevirir", toggle: true });
    auto.button.addEventListener("click", () => {
      this.autoTranslate = !this.autoTranslate;
      saveMenuPreference(MENU_AUTO_TRANSLATE_KEY, this.autoTranslate);
      this.refresh();
    });
    const settings = this.item({ icon: "settings", label: "Daha fazla ayar", sub: "API anahtarı, önbellek" });
    settings.button.addEventListener("click", () => {
      try {
        chrome.runtime.sendMessage({ type: "OPEN_SETTINGS" }).catch(() => {});
      } catch {}
      this.close();
    });

    this.refs = { subtitles, mode, model, retranslate, auto };
    const divider = () => menuElement("div", "yt-ceviri-menu-divider");
    const view = menuElement("div", "yt-ceviri-menu-view");
    view.append(
      subtitles.button,
      mode.button,
      model.button,
      style.button,
      divider(),
      retranslate.button,
      auto.button,
      divider(),
      settings.button
    );
    return view;
  }

  // The first click asks for confirmation: re-translating replaces the saved translation and
  // uses API credit.
  confirmRetranslate(item) {
    if (!this.confirmTimer) {
      item.sub.textContent = "Emin misiniz? Onaylamak için tekrar tıklayın.";
      item.button.classList.add("is-confirm");
      this.confirmTimer = setTimeout(() => {
        this.confirmTimer = null;
        item.sub.textContent = "Seçili modelle baştan çevirir";
        item.button.classList.remove("is-confirm");
      }, MENU_CONFIRM_MS);
      return;
    }
    this.resetConfirm();
    this.overlay.onRetranslate?.();
    this.close();
  }

  resetConfirm() {
    clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
  }

  // --- Sub views ---

  header(title, action) {
    const header = menuElement("div", "yt-ceviri-menu-header");
    const back = menuButton("yt-ceviri-menu-back", "‹");
    back.setAttribute("aria-label", "Geri");
    back.addEventListener("click", () => this.show("main"));
    header.append(back, menuElement("span", "yt-ceviri-menu-title", title));
    if (action) {
      const button = menuButton("yt-ceviri-menu-action", action.label);
      button.addEventListener("click", action.onClick);
      header.append(button);
    }
    return header;
  }

  buildChoice(title, options, selected, onSelect, note) {
    const view = menuElement("div", "yt-ceviri-menu-view");
    view.append(this.header(title));
    for (const option of options) {
      const button = menuButton("yt-ceviri-menu-option");
      const isSelected = option.value === selected;
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", String(isSelected));
      const text = menuElement("span", "yt-ceviri-menu-text");
      text.append(menuElement("span", "yt-ceviri-menu-label", option.label), menuElement("span", "yt-ceviri-menu-sub", option.hint));
      button.append(menuElement("span", "yt-ceviri-menu-check", isSelected ? "✓" : ""), text);
      button.addEventListener("click", () => {
        onSelect(option.value);
        this.show("main");
      });
      view.append(button);
    }
    if (note) view.append(menuElement("p", "yt-ceviri-menu-note", note));
    return view;
  }

  buildStyle() {
    const overlay = this.overlay;
    const view = menuElement("div", "yt-ceviri-menu-view");
    view.append(
      this.header("Altyazı ayarları", {
        label: "Sıfırla",
        onClick: () => {
          overlay.resetStyle();
          this.show("style");
        },
      }),
      this.lineSection("Çeviri", "translation"),
      this.lineSection("Orijinal", "original", "çift dil modunda", [
        this.switchRow("Kelime kelime vurgulama", () => overlay.settings.wordHighlight, (wordHighlight) =>
          overlay.updateSettings({ wordHighlight })
        ),
        this.colorRow("Vurgu rengi", () => overlay.settings.highlightColor, (highlightColor, options) =>
          overlay.updateSettings({ highlightColor }, options)
        ),
      ]),
      this.section("Diğer", undefined, [
        this.stepperRow("Arka plan opaklığı", SUBTITLE_BACKGROUND_LIMITS, () => overlay.settings.background, (background) =>
          overlay.updateSettings({ background })
        ),
        this.switchRow("Arka plan bulanıklığı", () => overlay.settings.blur, (blur) => overlay.updateSettings({ blur })),
        this.selectRow("Kontur stili", Object.entries(SUBTITLE_EDGES), () => overlay.settings.edge, (edge) =>
          overlay.updateSettings({ edge })
        ),
        this.switchRow("Çeviri üstte", () => overlay.settings.translationFirst, (translationFirst) =>
          overlay.updateSettings({ translationFirst })
        ),
      ]),
      // The edges are black, so they barely show on the dark background box.
      menuElement("p", "yt-ceviri-menu-note", "Kontur stili, arka plan opaklığı düşükken (%0–30) belirgin olur.")
    );
    return view;
  }

  section(title, note, rows) {
    const section = menuElement("div", "yt-ceviri-menu-section");
    const heading = menuElement("div", "yt-ceviri-menu-section-title", title);
    if (note) heading.append(menuElement("span", "yt-ceviri-menu-section-note", note));
    const card = menuElement("div", "yt-ceviri-menu-card");
    card.append(...rows);
    section.append(heading, card);
    return section;
  }

  // key: "translation" or "original"; the line's settings are replaced as a whole.
  lineSection(title, key, note, extraRows = []) {
    const overlay = this.overlay;
    const get = () => overlay.settings[key];
    const set = (change, options) => overlay.updateSettings({ [key]: { ...get(), ...change } }, options);
    const fonts = Object.entries(SUBTITLE_FONTS).map(([value, font]) => [value, font.label]);
    return this.section(title, note, [
      this.stepperRow("Yazı boyutu", SUBTITLE_SIZE_LIMITS, () => get().size, (size) => set({ size })),
      this.colorRow("Renk", () => get().color, (color, options) => set({ color }, options)),
      this.selectRow("Yazı tipi", fonts, () => get().font, (font) => set({ font }), { fonts: true }),
      this.switchRow("Kalın", () => get().bold, (bold) => set({ bold })),
      ...extraRows,
    ]);
  }

  row(label, control) {
    const row = menuElement("div", "yt-ceviri-menu-row");
    row.append(menuElement("span", "yt-ceviri-menu-row-label", label), control);
    return row;
  }

  stepperRow(label, limits, get, set) {
    const stepper = menuElement("div", "yt-ceviri-stepper");
    const value = menuElement("span", "yt-ceviri-stepper-value");
    const show = () => {
      value.textContent = `${get()}%`;
    };
    const step = (direction) => {
      set(Math.min(limits.max, Math.max(limits.min, get() + direction * limits.step)));
      show();
    };
    const minus = menuButton("", "−");
    minus.setAttribute("aria-label", `${label}: azalt`);
    minus.addEventListener("click", () => step(-1));
    const plus = menuButton("", "+");
    plus.setAttribute("aria-label", `${label}: artır`);
    plus.addEventListener("click", () => step(1));
    stepper.append(minus, value, plus);
    show();
    return this.row(label, stepper);
  }

  switchRow(label, get, set) {
    const button = menuButton("yt-ceviri-switch-button");
    const toggle = menuElement("span", "yt-ceviri-switch");
    button.setAttribute("role", "switch");
    button.setAttribute("aria-label", label);
    button.append(toggle);
    button.addEventListener("click", () => {
      set(!get());
      setSwitch(button, toggle, get());
    });
    setSwitch(button, toggle, get());
    return this.row(label, button);
  }

  // While the picker is open the color is shown live; it is saved once the picker closes.
  colorRow(label, get, set) {
    const swatch = menuElement("label", "yt-ceviri-swatch");
    const input = menuElement("input");
    input.type = "color";
    input.value = get();
    input.setAttribute("aria-label", label);
    const show = () => {
      swatch.style.background = get();
    };
    input.addEventListener("input", () => {
      set(input.value, { save: false });
      show();
    });
    input.addEventListener("change", () => {
      set(input.value);
      show();
    });
    swatch.append(input);
    show();
    return this.row(label, swatch);
  }

  // options: [value, label] pairs. Font names are shown in their own font.
  selectRow(label, options, get, set, { fonts = false } = {}) {
    const select = menuElement("select", "yt-ceviri-select");
    select.setAttribute("aria-label", label);
    for (const [value, text] of options) {
      const option = menuElement("option", "", text);
      option.value = value;
      if (fonts) option.style.fontFamily = SUBTITLE_FONTS[value].stack;
      select.append(option);
    }
    const show = () => {
      select.value = get();
      if (fonts) select.style.fontFamily = SUBTITLE_FONTS[get()].stack;
    };
    select.addEventListener("change", () => {
      set(select.value);
      show();
    });
    show();
    return this.row(label, select);
  }
}

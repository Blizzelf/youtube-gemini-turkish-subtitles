// Popup: saves the user's Gemini API key, the model and the auto-translate option to
// chrome.storage.local, re-translates the video open in the active tab (via its content script),
// and shows, clears, exports and imports the translation cache (the cache belongs to
// background.js; requested by message). When the browser withholds YouTube from the extension,
// it shows a warning with a button that asks for the access; when the background does not
// answer at all, a warning with a button that restarts the extension.
// The saved key is never written back into the input; only a masked form is shown.
// All strings in this file are shown to the user, so they are Turkish.

const STORAGE_KEY = "geminiApiKey";
const MODEL_KEY = "geminiModel"; // Read by background.js; the first option is its default
const AUTO_TRANSLATE_KEY = "autoTranslate"; // Read by content.js; off by default
const CLEAR_CONFIRM_MS = 4000; // How long the "Emin misiniz?" (are you sure?) state lasts
const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const YOUTUBE_ORIGIN = "https://www.youtube.com/*"; // The content scripts' match pattern
const NO_BACKGROUND_PATTERN = /Receiving end does not exist/i;

// Import happens in a tab: the popup can close when the file picker opens.
const params = new URLSearchParams(location.search);
const isTabView = params.get("view") === "tab";

const els = {
  backgroundWarning: document.getElementById("backgroundWarning"),
  restartBtn: document.getElementById("restartBtn"),
  accessWarning: document.getElementById("accessWarning"),
  grantAccessBtn: document.getElementById("grantAccessBtn"),
  accessMessage: document.getElementById("accessMessage"),
  status: document.getElementById("status"),
  input: document.getElementById("apiKey"),
  toggleBtn: document.getElementById("toggleBtn"),
  saveBtn: document.getElementById("saveBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  message: document.getElementById("message"),
  model: document.getElementById("model"),
  retranslateBtn: document.getElementById("retranslateBtn"),
  retranslateInfo: document.getElementById("retranslateInfo"),
  retranslateMessage: document.getElementById("retranslateMessage"),
  autoTranslate: document.getElementById("autoTranslate"),
  cacheStats: document.getElementById("cacheStats"),
  clearCacheBtn: document.getElementById("clearCacheBtn"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
  cacheMessage: document.getElementById("cacheMessage"),
};

let clearConfirmTimer = null;
let videoTabId = null; // Active tab, when it shows a YouTube video

function maskKey(key) {
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function showMessage(text, type) {
  els.message.textContent = text;
  els.message.className = `message ${type || ""}`.trim();
}

function renderStatus(key) {
  if (key) {
    els.status.textContent = `Anahtar kayıtlı (${maskKey(key)})`;
    els.status.classList.add("saved");
    els.deleteBtn.disabled = false;
  } else {
    els.status.textContent = "Anahtar yok";
    els.status.classList.remove("saved");
    els.deleteBtn.disabled = true;
  }
}

function validateKey(key) {
  if (!key) return "Lütfen bir API anahtarı girin.";
  if (/\s/.test(key)) return "Anahtar boşluk içeremez.";
  if (!key.startsWith("AIza")) return "Gemini API anahtarları \"AIza\" ile başlar.";
  if (key.length < 30) return "Anahtar çok kısa görünüyor.";
  return null;
}

async function loadStatus() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    renderStatus(result[STORAGE_KEY] || null);
  } catch (error) {
    els.status.textContent = "Durum okunamadı";
    showMessage(`Hata: ${error?.message || error}`, "error");
  }
}

async function saveKey() {
  const key = els.input.value.trim();
  const validationError = validateKey(key);
  if (validationError) {
    showMessage(validationError, "error");
    els.input.focus();
    return;
  }

  els.saveBtn.disabled = true;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: key });
    els.input.value = "";
    renderStatus(key);
    showMessage("Anahtar kaydedildi.", "success");
  } catch (error) {
    showMessage(`Kaydedilemedi: ${error?.message || error}`, "error");
  } finally {
    els.saveBtn.disabled = false;
  }
}

async function deleteKey() {
  els.deleteBtn.disabled = true;
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
    renderStatus(null);
    showMessage("Anahtar silindi.", "success");
  } catch (error) {
    els.deleteBtn.disabled = false;
    showMessage(`Silinemedi: ${error?.message || error}`, "error");
  }
}

function toggleVisibility() {
  const hidden = els.input.type === "password";
  els.input.type = hidden ? "text" : "password";
  els.toggleBtn.textContent = hidden ? "Gizle" : "Göster";
  els.toggleBtn.setAttribute("aria-label", hidden ? "Anahtarı gizle" : "Anahtarı göster");
}

// --- YouTube site access ---
// With site access set to "on click" the browser withholds YouTube, so the content scripts
// do not run there. The manifest already lists the site (content script matches), so
// permissions.request may ask for it again; once the user allows it, it stays granted.

function showAccessMessage(text, type) {
  els.accessMessage.textContent = text;
  els.accessMessage.className = `message ${type || ""}`.trim();
}

async function loadAccess() {
  try {
    els.accessWarning.hidden = await chrome.permissions.contains({ origins: [YOUTUBE_ORIGIN] });
  } catch {
    els.accessWarning.hidden = true;
  }
}

// The request must start inside the click (user gesture), so nothing is awaited before it.
// The popup can close while the browser's dialog is open; the hint above the button already
// says what to do next, and background.js clears the badge once access is granted.
async function requestAccess() {
  els.grantAccessBtn.disabled = true;
  try {
    const granted = await chrome.permissions.request({ origins: [YOUTUBE_ORIGIN] });
    if (granted) {
      els.grantAccessBtn.hidden = true;
      showAccessMessage("İzin verildi. Açık YouTube sekmelerini yenileyin.", "success");
    } else {
      showAccessMessage("İzin verilmedi. Eklentiler sayfasında eklentinin ayrıntılarındaki \"Site erişimi\" bölümünden de açabilirsiniz.", "error");
      els.grantAccessBtn.disabled = false;
    }
  } catch (error) {
    showAccessMessage(`İzin istenemedi: ${error?.message || error}`, "error");
    els.grantAccessBtn.disabled = false;
  }
}

// --- Background that does not start ---
// "Receiving end does not exist" from runtime.sendMessage means no service worker answers.
// Seen in Edge after its Service Worker database was recreated empty: the browser still
// believes the worker is registered and never starts it. Reloading the extension registers
// it again; storage (key, cache, settings) is kept. The popup closes on reload.

function checkBackgroundError(error) {
  if (NO_BACKGROUND_PATTERN.test(String(error?.message || error))) els.backgroundWarning.hidden = false;
}

function restartExtension() {
  chrome.runtime.reload();
}

// --- Model (applies to translations started after the change) ---

async function loadModel() {
  try {
    const stored = (await chrome.storage.local.get(MODEL_KEY))[MODEL_KEY];
    if ([...els.model.options].some((option) => option.value === stored)) els.model.value = stored;
  } catch (error) {
    showMessage(`Ayar okunamadı: ${error?.message || error}`, "error");
  }
}

async function saveModel() {
  try {
    await chrome.storage.local.set({ [MODEL_KEY]: els.model.value });
  } catch (error) {
    showMessage(`Ayar kaydedilemedi: ${error?.message || error}`, "error");
  }
}

// --- Re-translate the open video with the selected model ---

function showRetranslateMessage(text, type) {
  els.retranslateMessage.textContent = text;
  els.retranslateMessage.className = `message ${type || ""}`.trim();
}

// Only the content script knows the video; on other pages the message has no receiver and fails.
async function loadCurrentVideo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const video = await chrome.tabs.sendMessage(tab.id, { type: "GET_VIDEO" });
    if (!video?.videoId) throw new Error("no video");
    videoTabId = tab.id;
    els.retranslateBtn.disabled = false;
    els.retranslateInfo.textContent = video.title ? `Açık video: ${video.title}` : "";
    els.retranslateInfo.title = video.title || "";
  } catch {
    els.retranslateBtn.disabled = true;
    els.retranslateInfo.textContent = "YouTube'da bir video açıkken kullanılabilir.";
  }
}

async function retranslate() {
  els.retranslateBtn.disabled = true;
  try {
    const result = await chrome.tabs.sendMessage(videoTabId, { type: "RETRANSLATE" });
    if (!result?.ok) throw new Error(result?.error || "yanıt yok");
    showRetranslateMessage("Yeniden çeviri başladı. İlerlemeyi videodaki logo butonunda görebilirsiniz.", "success");
  } catch (error) {
    showRetranslateMessage(`Başlatılamadı: ${error?.message || error}`, "error");
    els.retranslateBtn.disabled = false;
  }
}

// --- Auto-translate option (applies to videos opened after the change) ---

async function loadAutoTranslate() {
  try {
    const result = await chrome.storage.local.get(AUTO_TRANSLATE_KEY);
    els.autoTranslate.checked = result[AUTO_TRANSLATE_KEY] === true;
  } catch (error) {
    showMessage(`Ayar okunamadı: ${error?.message || error}`, "error");
  }
}

async function saveAutoTranslate() {
  try {
    await chrome.storage.local.set({ [AUTO_TRANSLATE_KEY]: els.autoTranslate.checked });
  } catch (error) {
    els.autoTranslate.checked = !els.autoTranslate.checked;
    showMessage(`Ayar kaydedilemedi: ${error?.message || error}`, "error");
  }
}

// --- Translation cache ---

function formatBytes(bytes) {
  const number = (value) => value.toLocaleString("tr-TR", { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${number(bytes / 1024)} KB`;
  return `${number(bytes / (1024 * 1024))} MB`;
}

function showCacheMessage(text, type) {
  els.cacheMessage.textContent = text;
  els.cacheMessage.className = `message ${type || ""}`.trim();
}

function resetClearButton() {
  clearTimeout(clearConfirmTimer);
  clearConfirmTimer = null;
  els.clearCacheBtn.classList.remove("confirm");
  els.clearCacheBtn.textContent = "Önbelleği temizle";
}

async function loadCacheStats() {
  try {
    const stats = await chrome.runtime.sendMessage({ type: "GET_CACHE_STATS" });
    if (!stats?.ok) throw new Error(stats?.error || "yanıt yok");
    els.cacheStats.textContent = stats.count
      ? `${stats.count} video · ${formatBytes(stats.bytes)}`
      : "Önbellekte çeviri yok";
    els.clearCacheBtn.disabled = stats.count === 0;
    els.exportBtn.disabled = stats.count === 0;
  } catch (error) {
    checkBackgroundError(error);
    els.cacheStats.textContent = "Bilgi alınamadı";
    els.clearCacheBtn.disabled = false;
    els.exportBtn.disabled = false;
    showCacheMessage(`Hata: ${error?.message || error}`, "error");
  }
}

async function exportCache() {
  els.exportBtn.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "EXPORT_TRANSLATION_CACHE" });
    if (!result?.ok) throw new Error(result?.error || "yanıt yok");
    if (!result.count) {
      showCacheMessage("Dışa aktarılacak çeviri yok.");
      return;
    }

    const blob = new Blob([JSON.stringify(result.data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `yt-ceviri-onbellek-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    showCacheMessage(`${result.count} videonun çevirisi dışa aktarıldı (${formatBytes(blob.size)}).`, "success");
  } catch (error) {
    showCacheMessage(`Dışa aktarılamadı: ${error?.message || error}`, "error");
  } finally {
    els.exportBtn.disabled = false;
  }
}

function startImport() {
  if (isTabView) {
    els.importFile.click();
    return;
  }
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?view=tab&import=1") });
  window.close();
}

function describeImport(result) {
  const parts = [`${result.imported} videonun çevirisi içe aktarıldı.`];
  if (result.existing) parts.push(`${result.existing} video bu tarayıcıda zaten vardı.`);
  if (result.incompatible) parts.push(`${result.incompatible} kayıt eklentinin farklı bir sürümüyle yapıldığı için atlandı.`);
  if (result.invalid) parts.push(`${result.invalid} bozuk kayıt atlandı.`);
  if (result.evicted) parts.push(`Yer açmak için en eski ${result.evicted} çeviri silindi.`);
  return parts.join(" ");
}

async function importCache() {
  const file = els.importFile.files[0];
  els.importFile.value = "";
  if (!file) return;

  if (file.size > IMPORT_MAX_BYTES) {
    showCacheMessage(`Dosya çok büyük (${formatBytes(file.size)}).`, "error");
    return;
  }

  els.importBtn.disabled = true;
  try {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new Error("dosya geçerli JSON değil.");
    }
    const result = await chrome.runtime.sendMessage({ type: "IMPORT_TRANSLATION_CACHE", data });
    if (!result?.ok) throw new Error(result?.error || "yanıt yok");
    showCacheMessage(describeImport(result), result.imported ? "success" : "");
  } catch (error) {
    showCacheMessage(`İçe aktarılamadı: ${error?.message || error}`, "error");
  } finally {
    els.importBtn.disabled = false;
  }
  await loadCacheStats();
}

// The first click asks for confirmation; the irreversible delete happens on the second click.
async function clearCache() {
  if (!clearConfirmTimer) {
    els.clearCacheBtn.classList.add("confirm");
    els.clearCacheBtn.textContent = "Emin misiniz?";
    showCacheMessage("Kayıtlı tüm çeviriler silinecek. Onaylamak için tekrar tıklayın.");
    clearConfirmTimer = setTimeout(() => {
      resetClearButton();
      showCacheMessage("");
    }, CLEAR_CONFIRM_MS);
    return;
  }

  resetClearButton();
  els.clearCacheBtn.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "CLEAR_TRANSLATION_CACHE" });
    if (!result?.ok) throw new Error(result?.error || "yanıt yok");
    let text = `${result.removed} videonun çevirisi silindi (${formatBytes(result.bytes)}).`;
    if (result.activeJobs) text += ` Süren ${result.activeJobs} çeviri bitince yeniden kaydedilecek.`;
    showCacheMessage(text, "success");
  } catch (error) {
    showCacheMessage(`Silinemedi: ${error?.message || error}`, "error");
  }
  await loadCacheStats();
}

document.addEventListener("DOMContentLoaded", () => {
  els.restartBtn.addEventListener("click", restartExtension);
  els.grantAccessBtn.addEventListener("click", requestAccess);
  els.saveBtn.addEventListener("click", saveKey);
  els.deleteBtn.addEventListener("click", deleteKey);
  els.toggleBtn.addEventListener("click", toggleVisibility);
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveKey();
  });
  els.input.addEventListener("input", () => showMessage(""));
  els.model.addEventListener("change", saveModel);
  els.retranslateBtn.addEventListener("click", retranslate);
  els.autoTranslate.addEventListener("change", saveAutoTranslate);
  els.clearCacheBtn.addEventListener("click", clearCache);
  els.exportBtn.addEventListener("click", exportCache);
  els.importBtn.addEventListener("click", startImport);
  els.importFile.addEventListener("change", importCache);

  if (isTabView) {
    document.body.classList.add("tab-view");
    if (params.has("import")) {
      showCacheMessage("Çeviri dosyasını seçmek için \"İçe aktar…\" butonuna tıklayın.");
      els.importBtn.focus();
    }
  }

  loadAccess();
  loadStatus();
  loadModel();
  loadCurrentVideo();
  loadAutoTranslate();
  loadCacheStats();
});

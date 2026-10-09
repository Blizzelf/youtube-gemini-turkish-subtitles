// Service worker: Gemini API anahtarını okuyan tek yer burasıdır.
// Content script anahtarı asla görmez; altyazıyı mesajla gönderir, çeviriyi parça parça geri alır.
//
// Çeviri akışı:
// 1. Önbellek: video daha önce tamamen çevrildiyse API'ye hiç gidilmez. Yarıda kaldıysa
//    çevrilen kısım hemen gönderilir ve çeviri kaldığı yerden sürer.
// 2. Kümeleme: altyazı en fazla 40 satır / 6000 karakterlik parçalara bölünür.
// 3. Kuyruk: tüm Gemini istekleri (bütün sekmeler için) tek sırada ve aralarında en az
//    2,5 sn beklenerek gönderilir. 429 gelirse kuyruk durur, parça artan sürelerle tekrar denenir.
// 4. Her parça bitince sekmeye gönderilir ve önbelleğe yazılır. Oynatma konumundaki parça önce çevrilir.

const STORAGE_KEY = "geminiApiKey";
const LOG_PREFIX = "[YT Çeviri]";

const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Kümeleme
const CHUNK_MAX_ITEMS = 40;
const CHUNK_MAX_CHARS = 6000; // Satır metni + JSON alanları; token sınırının çok altında kalır
const CHUNK_FIELD_CHARS = 40; // Bir satırın start/duration alanları için yaklaşık pay
const MAX_CUES = 5000;
const TIMESTAMP_TOLERANCE = 0.01; // saniye

// Kuyruk ve yeniden deneme
const MIN_REQUEST_INTERVAL_MS = 2500; // Ardışık iki istek arasında en az bekleme
const MAX_ATTEMPTS = 8; // Geçici hatalarda (429, 5xx, ağ) bir parça için toplam deneme
const BACKOFF_BASE_MS = 4000; // 4, 8, 16, 32, 60, 60… sn
const BACKOFF_MAX_MS = 60000;
const BACKOFF_JITTER_MS = 1000; // Aynı anda tekrar denemeleri dağıtmak için rastgele ek
const RETRY_AFTER_MAX_MS = 5 * 60 * 1000; // API'nin önerdiği bekleme için üst sınır
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const KEEPALIVE_INTERVAL_MS = 20000;

// Önbellek (chrome.storage.local kotası 10 MB)
const CACHE_VERSION = 1; // İstem veya çıktı biçimi değişince artırılır; eski kayıtlar kullanılmaz
const CACHE_PREFIX = "translation:";
const CACHE_INDEX_KEY = "translationIndex"; // videoId -> { updatedAt, bytes }
const CACHE_MAX_BYTES = 8 * 1024 * 1024;

// Dışa / içe aktarma dosyası
const EXPORT_FORMAT = "yt-ceviri-cache";
const VIDEO_ID_PATTERN = /^[\w-]{6,20}$/;
const IMPORT_MAX_TEXT_CHARS = 2000;

const SYSTEM_PROMPT = `You are a professional subtitle translator. You translate YouTube video subtitles into Turkish.

INPUT FORMAT
You receive a JSON array of subtitle objects. Each object has exactly three fields:
- "start": start time in seconds (number)
- "duration": length in seconds (number)
- "text": the original subtitle text (string)
Example input:
[{"start": 0, "duration": 5, "text": "hello"}]

OUTPUT FORMAT
Return the SAME JSON array with only "text" translated into Turkish.
Example output:
[{"start": 0, "duration": 5, "text": "merhaba"}]

STRICT RULES. Never break them:
1. Output only a valid JSON array. No markdown, no code fences, no explanations.
2. The output must contain exactly as many objects as the input, in exactly the same order.
3. Copy every "start" and "duration" value exactly as given. Never change, round, recalculate, merge, split, add or remove timestamps or objects.
4. Translate only the "text" field. Each object's translation stays in that object. A sentence may continue across several objects: translate it naturally, but keep each part in its own object as closely as Turkish word order allows. Never leave a "text" empty and never move content into a neighboring object.
5. Write natural, fluent, everyday Turkish suitable for subtitles. Keep the tone and register of the original.
6. Translate sound and music tags in brackets, for example [Music] becomes [Müzik] and [Applause] becomes [Alkış]. Keep symbols such as ♪ unchanged.
7. Keep proper nouns, brand names, usernames and code unchanged.
8. If a text is already in Turkish, copy it unchanged.`;

const RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      start: { type: "NUMBER" },
      duration: { type: "NUMBER" },
      text: { type: "STRING" },
    },
    required: ["start", "duration", "text"],
    propertyOrdering: ["start", "duration", "text"],
  },
};

// API'den gelen hata (HTTP veya ağ). retryable ise tekrar denenir.
class GeminiApiError extends Error {
  constructor(message, { status = null, retryable = false, retryAfterMs = null, dailyQuota = false } = {}) {
    super(message);
    this.name = "GeminiApiError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.dailyQuota = dailyQuota;
  }
}

// Yanıt geldi ama yapı bozuk (satır sayısı, zaman damgası, JSON). Parça bölünerek tekrar denenir.
class TranslationFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "TranslationFormatError";
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`${LOG_PREFIX} Eklenti ${details.reason} (v${chrome.runtime.getManifest().version})`);
});

async function getApiKey() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Gemini isteği ---

function buildRequestBody(chunk, title) {
  const parts = [];
  if (title) parts.push({ text: `Video title (context only; do not include it in the output): ${title}` });
  parts.push({ text: JSON.stringify(chunk) });

  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      thinkingConfig: { thinkingLevel: "low" },
    },
  };
}

function findErrorDetail(data, typeSuffix) {
  return data?.error?.details?.find((detail) => detail["@type"]?.endsWith(typeSuffix));
}

function parseRetryDelay(data) {
  const seconds = parseFloat(findErrorDetail(data, "RetryInfo")?.retryDelay);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
}

// Günlük kota dolduysa beklemek işe yaramaz; tekrar denenmez.
function isDailyQuota(data) {
  const violations = findErrorDetail(data, "QuotaFailure")?.violations || [];
  return violations.some((violation) => /PerDay/i.test(violation.quotaId || ""));
}

function extractResponseText(data) {
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new TranslationFormatError(blockReason ? `İstek engellendi: ${blockReason}` : "Yanıt boş.");
  }
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    throw new TranslationFormatError(`Yanıt tamamlanmadı: ${candidate.finishReason}`);
  }
  // Düşünce (thought) parçaları çıktıya dahil değildir.
  return (candidate.content?.parts || [])
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

async function callGemini(apiKey, chunk, title) {
  let response;
  try {
    response = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Anahtar URL yerine başlıkta gönderilir; böylece loglarda ve geçmişte görünmez.
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(buildRequestBody(chunk, title)),
    });
  } catch (error) {
    throw new GeminiApiError(`Ağ hatası: ${error.message}`, { retryable: true });
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const dailyQuota = response.status === 429 && isDailyQuota(data);
    throw new GeminiApiError(data?.error?.message || `HTTP ${response.status}`, {
      status: response.status,
      retryable: RETRYABLE_STATUS.has(response.status) && !dailyQuota,
      retryAfterMs: parseRetryDelay(data),
      dailyQuota,
    });
  }
  return extractResponseText(data);
}

// --- Yanıt doğrulama ---

const sameTime = (a, b) => typeof a === "number" && Math.abs(a - b) <= TIMESTAMP_TOLERANCE;

// Modelin çıktısını orijinal parçayla satır satır karşılaştırır ve yalnızca metinleri döner.
function parseTranslatedTexts(chunk, rawText) {
  let items;
  try {
    const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    items = JSON.parse(cleaned);
  } catch {
    throw new TranslationFormatError("Yanıt geçerli JSON değil.");
  }

  if (!Array.isArray(items) || items.length !== chunk.length) {
    throw new TranslationFormatError(`Satır sayısı uyuşmuyor: ${items?.length} / ${chunk.length}`);
  }

  return chunk.map((cue, i) => {
    const item = items[i];
    if (!sameTime(item?.start, cue.start) || !sameTime(item?.duration, cue.duration)) {
      throw new TranslationFormatError(`Zaman damgası değişmiş (satır ${i}, start ${cue.start}).`);
    }
    const text = typeof item.text === "string" ? item.text.trim() : "";
    return text || cue.text;
  });
}

// --- İstek kuyruğu (throttling) ---

// Tüm Gemini istekleri bu zincirde sırayla çalışır; aynı anda yalnızca bir istek vardır.
let requestQueue = Promise.resolve();
// Bir sonraki isteğin en erken başlayabileceği an. 429 sonrası ileri alınır; tüm işler bekler.
let nextRequestAt = 0;

function enqueueGeminiRequest(task) {
  const run = requestQueue.then(async () => {
    const wait = nextRequestAt - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      nextRequestAt = Math.max(nextRequestAt, Date.now() + MIN_REQUEST_INTERVAL_MS);
    }
  });
  requestQueue = run.catch(() => {});
  return run;
}

function pauseQueue(ms) {
  nextRequestAt = Math.max(nextRequestAt, Date.now() + ms);
}

function backoffDelay(attempt, retryAfterMs) {
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  const jitter = Math.round(Math.random() * BACKOFF_JITTER_MS);
  return Math.min(Math.max(backoff, retryAfterMs ?? 0) + jitter, RETRY_AFTER_MAX_MS);
}

// Bir parçayı çevirir. Geçici hatalarda kuyruğu durdurup artan sürelerle tekrar dener.
async function requestChunk(apiKey, chunk, job) {
  for (let attempt = 1; ; attempt++) {
    try {
      const raw = await enqueueGeminiRequest(() => callGemini(apiKey, chunk, job.title));
      return parseTranslatedTexts(chunk, raw);
    } catch (error) {
      if (!(error instanceof GeminiApiError) || !error.retryable || attempt >= MAX_ATTEMPTS) throw error;

      const delay = backoffDelay(attempt, error.retryAfterMs);
      pauseQueue(delay);
      const reason = error.status === 429 ? "Gemini hız sınırı (429)" : `Gemini geçici hata (${error.status ?? "ağ"})`;
      const message = `${reason}; ${Math.ceil(delay / 1000)} sn sonra tekrar denenecek (${attempt + 1}/${MAX_ATTEMPTS}).`;
      console.warn(`${LOG_PREFIX} ${message} ${error.message}`);
      job.notify({ type: "TRANSLATION_STATUS", message });
    }
  }
}

// Yapı bozuk gelirse parçayı ikiye bölüp tekrar dener; tek satırda da olmazsa orijinal metin kalır.
async function translateChunk(apiKey, chunk, job) {
  try {
    return await requestChunk(apiKey, chunk, job);
  } catch (error) {
    if (!(error instanceof TranslationFormatError)) throw error;

    if (chunk.length === 1) {
      console.warn(`${LOG_PREFIX} Satır çevrilemedi, orijinal bırakıldı (start ${chunk[0].start}): ${error.message}`);
      return [chunk[0].text];
    }

    console.warn(`${LOG_PREFIX} ${error.message} ${chunk.length} satırlık parça bölünüyor.`);
    const middle = Math.ceil(chunk.length / 2);
    const first = await translateChunk(apiKey, chunk.slice(0, middle), job);
    const second = await translateChunk(apiKey, chunk.slice(middle), job);
    return [...first, ...second];
  }
}

// --- Kümeleme ---

// Altyazı dizisini satır ve karakter sınırına göre [start, end) aralıklarına böler.
function createChunks(captions) {
  const chunks = [];
  let start = 0;
  let chars = 0;
  captions.forEach((cue, i) => {
    const size = cue.text.length + CHUNK_FIELD_CHARS;
    if (i > start && (i - start >= CHUNK_MAX_ITEMS || chars + size > CHUNK_MAX_CHARS)) {
      chunks.push({ start, end: i });
      start = i;
      chars = 0;
    }
    chars += size;
  });
  if (start < captions.length) chunks.push({ start, end: captions.length });
  return chunks;
}

// --- Önbellek ---

// Önbellek yazımları sırayla yapılır; dizin (index) aynı anda iki yerden değişmesin.
let cacheQueue = Promise.resolve();
function withCacheLock(task) {
  const run = cacheQueue.then(task);
  cacheQueue = run.catch(() => {});
  return run;
}

// Altyazı değişirse (ör. bölme kuralları güncellenirse) eski çeviri kullanılmaz (FNV-1a).
function hashCaptions(captions, language) {
  const text = `${language}\n${captions.map((cue) => `${cue.start}|${cue.duration}|${cue.text}`).join("\n")}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function readTranslation(videoId, hash, count) {
  const key = CACHE_PREFIX + videoId;
  const entry = (await chrome.storage.local.get(key))[key];
  const valid =
    entry?.version === CACHE_VERSION &&
    entry.model === GEMINI_MODEL &&
    entry.hash === hash &&
    Array.isArray(entry.texts) &&
    entry.texts.length === count;
  return valid ? entry : null;
}

// Kayıtları ve dizini yazar; bütçe aşılırsa en uzun süredir kullanılmayan kayıtlar silinir (LRU).
// En yeni kayıt, tek başına bütçeyi aşsa bile silinmez. withCacheLock içinde çağrılır.
async function storeEntries(entries) {
  const index = (await chrome.storage.local.get(CACHE_INDEX_KEY))[CACHE_INDEX_KEY] || {};
  const values = {};
  for (const [videoId, entry] of Object.entries(entries)) {
    index[videoId] = { updatedAt: entry.updatedAt, bytes: new TextEncoder().encode(JSON.stringify(entry)).length };
    values[CACHE_PREFIX + videoId] = entry;
  }

  let total = Object.values(index).reduce((sum, info) => sum + info.bytes, 0);
  const oldestFirst = Object.entries(index).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const removals = [];
  let evicted = 0;
  while (total > CACHE_MAX_BYTES && oldestFirst.length > 1) {
    const [videoId, info] = oldestFirst.shift();
    total -= info.bytes;
    delete index[videoId];
    evicted++;
    // Bu yazımda eklenen bir kayıt silinecekse hiç yazılmaz.
    if (CACHE_PREFIX + videoId in values) delete values[CACHE_PREFIX + videoId];
    else removals.push(CACHE_PREFIX + videoId);
  }

  if (removals.length) await chrome.storage.local.remove(removals);
  await chrome.storage.local.set({ ...values, [CACHE_INDEX_KEY]: index });
  return { evicted };
}

// Çeviri işinin ilerlemesini kaydeder (her parçadan sonra).
function saveTranslation(job) {
  const entry = {
    version: CACHE_VERSION,
    model: GEMINI_MODEL,
    hash: job.hash,
    texts: job.texts,
    complete: job.texts.every((text) => text !== null),
    updatedAt: Date.now(),
  };
  return withCacheLock(() => storeEntries({ [job.videoId]: entry })).catch((error) =>
    console.warn(`${LOG_PREFIX} Önbelleğe yazılamadı:`, error)
  );
}

async function getCacheStats() {
  const index = (await chrome.storage.local.get(CACHE_INDEX_KEY))[CACHE_INDEX_KEY] || {};
  const entries = Object.values(index);
  return { count: entries.length, bytes: entries.reduce((sum, info) => sum + info.bytes, 0) };
}

// Tüm çeviri kayıtlarını siler; dizinde olmayan (yarım kalmış yazımdan kalan) kayıtlar da bulunur.
function clearTranslationCache() {
  return withCacheLock(async () => {
    const { bytes } = await getCacheStats();
    const keys = Object.keys(await chrome.storage.local.get(null)).filter((key) => key.startsWith(CACHE_PREFIX));
    await chrome.storage.local.remove([...keys, CACHE_INDEX_KEY]);
    console.log(`${LOG_PREFIX} Önbellek temizlendi: ${keys.length} video`);
    return { removed: keys.length, bytes };
  });
}

// --- Dışa / içe aktarma (popup) ---

async function exportTranslationCache() {
  const all = await chrome.storage.local.get(null);
  const entries = {};
  for (const [key, entry] of Object.entries(all)) {
    if (key.startsWith(CACHE_PREFIX)) entries[key.slice(CACHE_PREFIX.length)] = entry;
  }
  return { format: EXPORT_FORMAT, version: CACHE_VERSION, exportedAt: new Date().toISOString(), entries };
}

// Dosya kullanıcıdan gelir; yapısı tek tek doğrulanır.
function isWellFormedEntry(videoId, entry) {
  return (
    VIDEO_ID_PATTERN.test(videoId) &&
    typeof entry?.hash === "string" &&
    Array.isArray(entry.texts) &&
    entry.texts.length > 0 &&
    entry.texts.length <= MAX_CUES &&
    entry.texts.every((text) => text === null || (typeof text === "string" && text.length <= IMPORT_MAX_TEXT_CHARS))
  );
}

// Başka bir tarayıcıdan dışa aktarılan çevirileri ekler. Bu tarayıcıda zaten tam çevirisi
// olan videolar korunur; farklı önbellek sürümü veya modelle yapılmış çeviriler atlanır.
function importTranslationCache(data) {
  if (data?.format !== EXPORT_FORMAT || !data.entries || typeof data.entries !== "object") {
    throw new Error("Dosya bu eklentinin dışa aktarma dosyası değil.");
  }

  return withCacheLock(async () => {
    const stats = { imported: 0, existing: 0, incompatible: 0, invalid: 0, evicted: 0 };
    const ids = Object.keys(data.entries);
    const current = await chrome.storage.local.get(ids.map((videoId) => CACHE_PREFIX + videoId));
    const accepted = {};

    for (const videoId of ids) {
      const entry = data.entries[videoId];
      if (!isWellFormedEntry(videoId, entry)) {
        stats.invalid++;
        continue;
      }
      if (entry.version !== CACHE_VERSION || entry.model !== GEMINI_MODEL) {
        stats.incompatible++;
        continue;
      }

      const complete = entry.texts.every((text) => text !== null);
      const local = current[CACHE_PREFIX + videoId];
      if (local?.complete && (local.hash === entry.hash || !complete)) {
        stats.existing++;
        continue;
      }

      accepted[videoId] = {
        version: CACHE_VERSION,
        model: GEMINI_MODEL,
        hash: entry.hash,
        texts: entry.texts,
        complete,
        updatedAt: Number.isFinite(entry.updatedAt) ? Math.min(entry.updatedAt, Date.now()) : Date.now(),
      };
    }

    stats.imported = Object.keys(accepted).length;
    if (stats.imported) stats.evicted = (await storeEntries(accepted)).evicted;
    console.log(`${LOG_PREFIX} İçe aktarma: ${JSON.stringify(stats)}`);
    return stats;
  });
}

// Önbellekten okunan kaydı en son kullanılan olarak işaretler.
function touchTranslation(videoId) {
  return withCacheLock(async () => {
    const index = (await chrome.storage.local.get(CACHE_INDEX_KEY))[CACHE_INDEX_KEY] || {};
    if (!index[videoId]) return;
    index[videoId].updatedAt = Date.now();
    await chrome.storage.local.set({ [CACHE_INDEX_KEY]: index });
  }).catch(() => {});
}

// --- Çeviri işleri ---

const jobs = new Map(); // `${videoId}:${hash}` -> iş
const jobsStarting = new Map(); // `${videoId}:${hash}` -> Promise; başlatma sırasında gelen istekler bekler
let keepAliveTimer = null;

// Uzun çevirilerde (429 beklemeleri dahil) service worker'ın 30 sn boşta kalınca kapanmasını önler.
function updateKeepAlive() {
  if (jobs.size && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), KEEPALIVE_INTERVAL_MS);
  } else if (!jobs.size && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function notifyTargets(targets, message) {
  for (const target of targets) {
    const [tabId, frameId] = target.split(":").map(Number);
    // Sekme kapanmış veya sayfa değişmiş olabilir; hata yok sayılır.
    chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => {});
  }
}

const isChunkDone = (job, chunk) => job.texts.slice(chunk.start, chunk.end).every((text) => text !== null);

function progressOf(job) {
  return { done: job.chunks.filter((chunk) => isChunkDone(job, chunk)).length, total: job.chunks.length };
}

// Oynatma konumunu içeren (ya da ondan sonraki) parça önce çevrilir; sonra baştakiler.
function pickNextChunk(job) {
  const pending = job.chunks.filter((chunk) => !isChunkDone(job, chunk));
  if (!pending.length) return null;
  return (
    pending.find((chunk) => {
      const last = job.captions[chunk.end - 1];
      return last.start + last.duration >= job.priorityTime;
    }) || pending[0]
  );
}

async function runJob(job, apiKey) {
  let chunk;
  while ((chunk = pickNextChunk(job))) {
    const texts = await translateChunk(apiKey, job.captions.slice(chunk.start, chunk.end), job);
    texts.forEach((text, i) => {
      job.texts[chunk.start + i] = text;
    });
    // Kısmi ilerleme de kaydedilir; çeviri yarıda kalırsa buradan devam eder.
    await saveTranslation(job);
    job.notify({ type: "TRANSLATION_CHUNK", startIndex: chunk.start, texts, ...progressOf(job) });
  }
}

function startJob({ apiKey, key, videoId, title, captions, hash, texts, priorityTime, target }) {
  const job = {
    videoId,
    title,
    captions,
    hash,
    texts,
    priorityTime,
    chunks: createChunks(captions),
    targets: new Set([target]),
  };
  job.notify = (message) => notifyTargets(job.targets, { videoId, ...message });
  jobs.set(key, job);
  updateKeepAlive();

  const startedAt = Date.now();
  const { done, total } = progressOf(job);
  console.log(
    `${LOG_PREFIX} Çeviri ${done ? "kaldığı yerden sürüyor" : "başladı"}: videoId=${videoId}, ` +
      `${captions.length} satır, ${done}/${total} parça hazır, model=${GEMINI_MODEL}`
  );

  runJob(job, apiKey)
    .then(() => {
      console.log(`${LOG_PREFIX} Çeviri bitti: videoId=${videoId}, ${((Date.now() - startedAt) / 1000).toFixed(1)} sn`);
      job.notify({ type: "TRANSLATION_RESULT", texts: job.texts, fromCache: false });
    })
    .catch((error) => {
      console.error(`${LOG_PREFIX} Çeviri başarısız: videoId=${videoId}`, error);
      const saved = progressOf(job).done > 0;
      const message = error.dailyQuota
        ? `Gemini günlük kotası doldu.${saved ? " Çevrilen kısım kaydedildi; kota yenilenince kaldığı yerden devam eder." : ""}`
        : error.message;
      job.notify({ type: "TRANSLATION_ERROR", error: message, partial: saved });
    })
    .finally(() => {
      jobs.delete(key);
      updateKeepAlive();
    });

  return job;
}

// Gelen veriyi doğrular ve yalnızca start, duration, text alanlarını bırakır.
function normalizeCaptions(captions) {
  if (!Array.isArray(captions) || captions.length === 0 || captions.length > MAX_CUES) return null;

  const normalized = [];
  for (const cue of captions) {
    if (!Number.isFinite(cue?.start) || !Number.isFinite(cue?.duration) || typeof cue?.text !== "string") {
      return null;
    }
    normalized.push({ start: cue.start, duration: cue.duration, text: cue.text });
  }
  return normalized;
}

// --- Mesajlar ---

async function handleTranslate(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    return { ok: false, error: "Çeviri yalnızca YouTube sekmesinden istenebilir." };
  }
  if (typeof message.videoId !== "string" || !message.videoId) {
    return { ok: false, error: "Geçersiz videoId." };
  }
  const captions = normalizeCaptions(message.captions);
  if (!captions) {
    return { ok: false, error: `Geçersiz altyazı verisi (1-${MAX_CUES} satır olmalı).` };
  }

  const { videoId } = message;
  const language = typeof message.language === "string" ? message.language : "";
  const hash = hashCaptions(captions, language);
  const key = `${videoId}:${hash}`;
  const target = `${tabId}:${sender.frameId ?? 0}`;
  const priorityTime = Number.isFinite(message.currentTime) ? message.currentTime : 0;

  // Aynı video şu an başlatılıyorsa (önbellek okunurken) ikinci bir iş açılmaz.
  const starting = jobsStarting.get(key);
  if (starting) {
    await starting;
    return handleTranslate(message, sender);
  }

  // Aynı video zaten çevriliyorsa bu sekme de sonuçları alır; hazır olan kısım hemen gönderilir.
  const running = jobs.get(key);
  if (running) {
    running.targets.add(target);
    running.priorityTime = priorityTime;
    return { ok: true, status: "pending", texts: running.texts, ...progressOf(running) };
  }

  const start = startOrLoadTranslation({ message, videoId, captions, hash, key, target, priorityTime });
  jobsStarting.set(key, start);
  try {
    return await start;
  } finally {
    jobsStarting.delete(key);
  }
}

async function startOrLoadTranslation({ message, videoId, captions, hash, key, target, priorityTime }) {
  // 1) Önbellek: tamamlanmış çeviri varsa API'ye gidilmez (anahtar da gerekmez).
  const cached = await readTranslation(videoId, hash, captions.length);
  if (cached?.complete) {
    touchTranslation(videoId);
    console.log(`${LOG_PREFIX} Önbellekten yüklendi: videoId=${videoId}, ${captions.length} satır`);
    return { ok: true, status: "cached", texts: cached.texts };
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error: "API anahtarı bulunamadı. Eklenti popup'ından Gemini API anahtarınızı girin.",
      texts: cached?.texts ?? null,
    };
  }

  // 2) Yarıda kalmış çeviri varsa kaldığı yerden sürer.
  const job = startJob({
    apiKey,
    key,
    videoId,
    title: typeof message.title === "string" ? message.title : "",
    captions,
    hash,
    texts: cached ? [...cached.texts] : new Array(captions.length).fill(null),
    priorityTime,
    target,
  });
  return { ok: true, status: cached ? "resumed" : "started", texts: cached?.texts ?? null, ...progressOf(job) };
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_KEY_STATUS": {
      const key = await getApiKey();
      return { ok: true, hasKey: Boolean(key) };
    }

    case "CONTENT_READY": {
      const tabId = sender.tab?.id;
      console.log(`${LOG_PREFIX} İzleme sayfası hazır: videoId=${message.videoId}, tabId=${tabId}`);
      return { ok: true };
    }

    case "TRANSLATE":
      return handleTranslate(message, sender);

    // Popup: önbellek bilgisi ve temizleme.
    case "GET_CACHE_STATS":
      return { ok: true, ...(await getCacheStats()), activeJobs: jobs.size };

    case "CLEAR_TRANSLATION_CACHE":
      // Süren çeviriler her parçadan sonra kaydettiği için bitince yeniden önbellekte olur.
      return { ok: true, ...(await clearTranslationCache()), activeJobs: jobs.size };

    case "EXPORT_TRANSLATION_CACHE": {
      const data = await exportTranslationCache();
      return { ok: true, count: Object.keys(data.entries).length, data };
    }

    case "IMPORT_TRANSLATION_CACHE":
      return { ok: true, ...(await importTranslationCache(message.data)) };

    // Kullanıcı ileri/geri sardı: o konumdaki parça öne alınır.
    case "TRANSLATION_PRIORITY": {
      if (Number.isFinite(message.time)) {
        for (const job of jobs.values()) {
          if (job.videoId === message.videoId) job.priorityTime = message.time;
        }
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: `Bilinmeyen mesaj tipi: ${message?.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Yalnızca bu eklentiden gelen mesajları kabul et.
  if (sender.id !== chrome.runtime.id) {
    return false;
  }

  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error(`${LOG_PREFIX} Mesaj işlenemedi:`, error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    });

  // Asenkron yanıt vereceğimizi bildir.
  return true;
});

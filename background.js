// Service worker: the only place that reads the Gemini API key.
// The content script never sees the key; it sends captions by message and receives the
// translation back chunk by chunk.
//
// Translation flow:
// 1. Cache: if the video was fully translated before, the API is not called at all. If a
//    translation was interrupted, the finished part is sent right away and work resumes.
// 2. Batching: captions are split into chunks of at most 40 lines / 6000 characters. The
//    first untranslated chunk at the playback position has only 10 lines, so the first
//    subtitles appear quickly.
// 3. Queue: all Gemini requests (for every tab) share one queue. Up to 3 run at once and
//    starts are at least 0.5 s apart. After the first 429 (e.g. on the free tier) it drops to
//    one request at a time, 2.5 s apart, until the browser closes. On 429 the queue pauses
//    and the chunk is retried with exponential backoff.
// 4. Each finished chunk is sent to the tab and written to the cache. The chunk at the
//    current playback position is translated first, then the ones after it.
//
// Strings shown to the user (overlay, popup) are Turkish; log messages are English.

const STORAGE_KEY = "geminiApiKey";
const LOG_PREFIX = "[YT Çeviri]";

const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Batching
const CHUNK_MAX_ITEMS = 40;
const FIRST_CHUNK_ITEMS = 10; // Chunk at the playback position; translated first, and faster
const CHUNK_MAX_CHARS = 6000; // Caption text + JSON fields; stays well below the token limit
const CHUNK_FIELD_CHARS = 40; // Rough allowance for a line's start/duration fields
const MAX_CUES = 5000;
const TIMESTAMP_TOLERANCE = 0.01; // seconds

// Queue and retries
const MAX_PARALLEL_REQUESTS = 3; // Requests in flight at once (one after a 429)
const MIN_REQUEST_INTERVAL_MS = 500; // Minimum gap between two request starts
const SLOW_REQUEST_INTERVAL_MS = 2500; // Gap once a 429 shows a tight rate limit (free tier)
const RATE_LIMITED_KEY = "rateLimited"; // chrome.storage.session: kept across worker restarts
const MAX_ATTEMPTS = 8; // Total attempts per chunk on transient errors (429, 5xx, network)
const BACKOFF_BASE_MS = 4000; // 4, 8, 16, 32, 60, 60… s
const BACKOFF_MAX_MS = 60000;
const BACKOFF_JITTER_MS = 1000; // Random extra delay so retries do not line up
const RETRY_AFTER_MAX_MS = 5 * 60 * 1000; // Upper bound for the delay suggested by the API
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const KEEPALIVE_INTERVAL_MS = 20000;

// Cache (chrome.storage.local quota is 10 MB)
const CACHE_VERSION = 1; // Bump when the prompt or output format changes; old entries are ignored
const CACHE_PREFIX = "translation:";
const CACHE_INDEX_KEY = "translationIndex"; // videoId -> { updatedAt, bytes }
const CACHE_MAX_BYTES = 8 * 1024 * 1024;

// Export / import file
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

// Error from the API (HTTP or network). Retried when retryable.
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

// A response arrived but its structure is broken (line count, timestamps, JSON).
// The chunk is split and retried.
class TranslationFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "TranslationFormatError";
  }
}

// A queued request whose job has already failed; it is dropped without being sent.
class JobStoppedError extends Error {}

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`${LOG_PREFIX} Extension ${details.reason} (v${chrome.runtime.getManifest().version})`);
});

async function getApiKey() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Gemini request ---

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

// Waiting does not help once the daily quota is used up; such errors are not retried.
function isDailyQuota(data) {
  const violations = findErrorDetail(data, "QuotaFailure")?.violations || [];
  return violations.some((violation) => /PerDay/i.test(violation.quotaId || ""));
}

function extractResponseText(data) {
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new TranslationFormatError(blockReason ? `Request blocked: ${blockReason}` : "Empty response.");
  }
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    throw new TranslationFormatError(`Response not finished: ${candidate.finishReason}`);
  }
  // Thought parts are not part of the output.
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
        // The key goes in a header instead of the URL so it never shows up in logs or history.
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

// --- Response validation ---

const sameTime = (a, b) => typeof a === "number" && Math.abs(a - b) <= TIMESTAMP_TOLERANCE;

// Compares the model output with the original chunk line by line and returns only the texts.
function parseTranslatedTexts(chunk, rawText) {
  let items;
  try {
    const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    items = JSON.parse(cleaned);
  } catch {
    throw new TranslationFormatError("Response is not valid JSON.");
  }

  if (!Array.isArray(items) || items.length !== chunk.length) {
    throw new TranslationFormatError(`Line count mismatch: ${items?.length} / ${chunk.length}`);
  }

  return chunk.map((cue, i) => {
    const item = items[i];
    if (!sameTime(item?.start, cue.start) || !sameTime(item?.duration, cue.duration)) {
      throw new TranslationFormatError(`Timestamp changed (line ${i}, start ${cue.start}).`);
    }
    const text = typeof item.text === "string" ? item.text.trim() : "";
    return text || cue.text;
  });
}

// --- Request queue (throttling) ---

// Requests start one at a time and in order through this chain; up to requestSlots of them
// then run at once.
let startQueue = Promise.resolve();
let activeRequests = 0;
let slotWaiter = null; // Resolves the request waiting for a free slot (only one waits at a time)
// Earliest moment the next request may start. Pushed forward after a 429; every job waits.
let nextRequestAt = 0;
// Paid keys can go fast. After a 429 the queue drops to one request at a time with the slower
// gap; this is remembered until the browser closes (chrome.storage.session).
let requestSlots = MAX_PARALLEL_REQUESTS;
let requestInterval = MIN_REQUEST_INTERVAL_MS;

function slowDown() {
  requestSlots = 1;
  requestInterval = SLOW_REQUEST_INTERVAL_MS;
}

chrome.storage.session
  .get(RATE_LIMITED_KEY)
  .then((stored) => {
    if (stored[RATE_LIMITED_KEY]) slowDown();
  })
  .catch(() => {});

function onRateLimited() {
  if (requestSlots === 1 && requestInterval === SLOW_REQUEST_INTERVAL_MS) return;
  console.warn(`${LOG_PREFIX} Rate limited; switching to one request at a time.`);
  slowDown();
  chrome.storage.session.set({ [RATE_LIMITED_KEY]: true }).catch(() => {});
}

async function waitForRequestSlot() {
  for (;;) {
    if (activeRequests >= requestSlots) {
      await new Promise((resolve) => {
        slotWaiter = resolve;
      });
      continue;
    }
    const wait = nextRequestAt - Date.now();
    if (wait <= 0) break;
    await sleep(wait); // The time may have moved (429) or the slots dropped meanwhile; check again.
  }
  activeRequests++;
  nextRequestAt = Math.max(nextRequestAt, Date.now() + requestInterval);
}

function enqueueGeminiRequest(task) {
  const started = startQueue.then(waitForRequestSlot);
  startQueue = started.catch(() => {});
  return started.then(async () => {
    try {
      return await task();
    } finally {
      activeRequests--;
      nextRequestAt = Math.max(nextRequestAt, Date.now() + requestInterval);
      const waiter = slotWaiter;
      slotWaiter = null;
      waiter?.();
    }
  });
}

function pauseQueue(ms) {
  nextRequestAt = Math.max(nextRequestAt, Date.now() + ms);
}

function backoffDelay(attempt, retryAfterMs) {
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  const jitter = Math.round(Math.random() * BACKOFF_JITTER_MS);
  return Math.min(Math.max(backoff, retryAfterMs ?? 0) + jitter, RETRY_AFTER_MAX_MS);
}

// Translates one chunk. On transient errors it pauses the queue and retries with growing delays.
async function requestChunk(apiKey, chunk, job) {
  for (let attempt = 1; ; attempt++) {
    try {
      const raw = await enqueueGeminiRequest(() => {
        // Another chunk of this job failed while this request waited; it is not sent.
        if (job.error) throw new JobStoppedError();
        return callGemini(apiKey, chunk, job.title);
      });
      return parseTranslatedTexts(chunk, raw);
    } catch (error) {
      if (!(error instanceof GeminiApiError) || !error.retryable || attempt >= MAX_ATTEMPTS) throw error;

      if (error.status === 429) onRateLimited();
      const delay = backoffDelay(attempt, error.retryAfterMs);
      pauseQueue(delay);
      // Shown to the user in the overlay, so it stays Turkish.
      const reason = error.status === 429 ? "Gemini hız sınırı (429)" : `Gemini geçici hata (${error.status ?? "ağ"})`;
      const message = `${reason}; ${Math.ceil(delay / 1000)} sn sonra tekrar denenecek (${attempt + 1}/${MAX_ATTEMPTS}).`;
      console.warn(`${LOG_PREFIX} ${message} ${error.message}`);
      job.notify({ type: "TRANSLATION_STATUS", message });
    }
  }
}

// If the structure comes back broken, the chunk is halved and retried; if a single line still
// fails, its original text is kept.
async function translateChunk(apiKey, chunk, job) {
  try {
    return await requestChunk(apiKey, chunk, job);
  } catch (error) {
    if (!(error instanceof TranslationFormatError)) throw error;

    if (chunk.length === 1) {
      console.warn(`${LOG_PREFIX} Line not translated, original kept (start ${chunk[0].start}): ${error.message}`);
      return [chunk[0].text];
    }

    console.warn(`${LOG_PREFIX} ${error.message} Splitting the ${chunk.length}-line chunk.`);
    const middle = Math.ceil(chunk.length / 2);
    const first = await translateChunk(apiKey, chunk.slice(0, middle), job);
    const second = await translateChunk(apiKey, chunk.slice(middle), job);
    return [...first, ...second];
  }
}

// --- Batching ---

// First untranslated line at or after the playback position (the line playing now included);
// if everything after it is done, the first untranslated line. -1 when nothing is left.
function firstPendingIndex(captions, texts, time) {
  const index = captions.findIndex((cue, i) => texts[i] === null && cue.start + cue.duration >= time);
  return index !== -1 ? index : texts.indexOf(null);
}

// Splits the caption array into [start, end) ranges by line and character limits. A chunk never
// mixes translated and untranslated lines, so an interrupted job resumes without redoing any.
// The chunk at firstIndex is cut to FIRST_CHUNK_ITEMS lines.
function createChunks(captions, texts, firstIndex) {
  const chunks = [];
  let start = 0;
  let chars = 0;
  captions.forEach((cue, i) => {
    const size = cue.text.length + CHUNK_FIELD_CHARS;
    const boundary =
      (texts[i] === null) !== (texts[i - 1] === null) ||
      (firstIndex >= 0 && (i === firstIndex || i === firstIndex + FIRST_CHUNK_ITEMS));
    if (i > start && (boundary || i - start >= CHUNK_MAX_ITEMS || chars + size > CHUNK_MAX_CHARS)) {
      chunks.push({ start, end: i });
      start = i;
      chars = 0;
    }
    chars += size;
  });
  if (start < captions.length) chunks.push({ start, end: captions.length });
  return chunks;
}

// --- Cache ---

// Cache writes run one at a time so the index is never changed from two places at once.
let cacheQueue = Promise.resolve();
function withCacheLock(task) {
  const run = cacheQueue.then(task);
  cacheQueue = run.catch(() => {});
  return run;
}

// If the captions change (e.g. the segmentation rules are updated), the old translation is
// not used (FNV-1a).
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

// Writes entries and the index; when over budget, the least recently used entries are removed
// (LRU). The newest entry is never removed, even if it alone exceeds the budget.
// Must be called inside withCacheLock.
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
    // An entry added in this same write is simply not written.
    if (CACHE_PREFIX + videoId in values) delete values[CACHE_PREFIX + videoId];
    else removals.push(CACHE_PREFIX + videoId);
  }

  if (removals.length) await chrome.storage.local.remove(removals);
  await chrome.storage.local.set({ ...values, [CACHE_INDEX_KEY]: index });
  return { evicted };
}

// Saves a translation job's progress (after every chunk).
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
    console.warn(`${LOG_PREFIX} Could not write to the cache:`, error)
  );
}

async function getCacheStats() {
  const index = (await chrome.storage.local.get(CACHE_INDEX_KEY))[CACHE_INDEX_KEY] || {};
  const entries = Object.values(index);
  return { count: entries.length, bytes: entries.reduce((sum, info) => sum + info.bytes, 0) };
}

// Removes every translation entry, including ones missing from the index (left over from an
// interrupted write).
function clearTranslationCache() {
  return withCacheLock(async () => {
    const { bytes } = await getCacheStats();
    const keys = Object.keys(await chrome.storage.local.get(null)).filter((key) => key.startsWith(CACHE_PREFIX));
    await chrome.storage.local.remove([...keys, CACHE_INDEX_KEY]);
    console.log(`${LOG_PREFIX} Cache cleared: ${keys.length} videos`);
    return { removed: keys.length, bytes };
  });
}

// --- Export / import (popup) ---

async function exportTranslationCache() {
  const all = await chrome.storage.local.get(null);
  const entries = {};
  for (const [key, entry] of Object.entries(all)) {
    if (key.startsWith(CACHE_PREFIX)) entries[key.slice(CACHE_PREFIX.length)] = entry;
  }
  return { format: EXPORT_FORMAT, version: CACHE_VERSION, exportedAt: new Date().toISOString(), entries };
}

// The file comes from the user; every entry's structure is validated.
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

// Adds translations exported from another browser. Videos already fully translated in this
// browser are kept; translations made with a different cache version or model are skipped.
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
    console.log(`${LOG_PREFIX} Import: ${JSON.stringify(stats)}`);
    return stats;
  });
}

// Checked by videoId alone before the captions are downloaded: a video with a complete
// translation or a running job is shown without the user asking for it again.
async function hasTranslation(videoId) {
  if (typeof videoId !== "string" || !videoId) return false;
  for (const job of jobs.values()) {
    if (job.videoId === videoId) return true;
  }
  const key = CACHE_PREFIX + videoId;
  const entry = (await chrome.storage.local.get(key))[key];
  return entry?.version === CACHE_VERSION && entry.model === GEMINI_MODEL && entry.complete === true;
}

// Marks an entry read from the cache as most recently used.
function touchTranslation(videoId) {
  return withCacheLock(async () => {
    const index = (await chrome.storage.local.get(CACHE_INDEX_KEY))[CACHE_INDEX_KEY] || {};
    if (!index[videoId]) return;
    index[videoId].updatedAt = Date.now();
    await chrome.storage.local.set({ [CACHE_INDEX_KEY]: index });
  }).catch(() => {});
}

// --- Translation jobs ---

const jobs = new Map(); // `${videoId}:${hash}` -> job
const jobsStarting = new Map(); // `${videoId}:${hash}` -> Promise; requests arriving while a job starts wait on it
let keepAliveTimer = null;

// Keeps the service worker from shutting down after 30 s idle during long translations
// (including 429 waits).
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
    // The tab may have closed or navigated away; errors are ignored.
    chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => {});
  }
}

const isChunkDone = (job, chunk) => job.texts.slice(chunk.start, chunk.end).every((text) => text !== null);

function progressOf(job) {
  return { done: job.chunks.filter((chunk) => isChunkDone(job, chunk)).length, total: job.chunks.length };
}

// The chunk containing (or following) the playback position goes first, then the earlier ones.
// Chunks another worker is translating are skipped.
function pickNextChunk(job) {
  const pending = job.chunks.filter((chunk) => !isChunkDone(job, chunk) && !job.inFlight.has(chunk));
  if (!pending.length) return null;
  return (
    pending.find((chunk) => {
      const last = job.captions[chunk.end - 1];
      return last.start + last.duration >= job.priorityTime;
    }) || pending[0]
  );
}

// Each worker translates one chunk at a time. Workers beyond the current slot count stop after
// their chunk, so after a 429 only one chunk is claimed at a time and seeking still takes effect.
async function runWorker(job, apiKey, index) {
  let chunk;
  while (!job.error && index < requestSlots && (chunk = pickNextChunk(job))) {
    job.inFlight.add(chunk);
    try {
      const texts = await translateChunk(apiKey, job.captions.slice(chunk.start, chunk.end), job);
      texts.forEach((text, i) => {
        job.texts[chunk.start + i] = text;
      });
      // Partial progress is saved too, so an interrupted translation resumes from here.
      await saveTranslation(job);
      job.notify({ type: "TRANSLATION_CHUNK", startIndex: chunk.start, texts, ...progressOf(job) });
    } catch (error) {
      job.error ??= error; // The first error stops the job; queued requests are dropped.
    } finally {
      job.inFlight.delete(chunk);
    }
  }
}

// The error is reported only after every worker has stopped, so no chunk message arrives after it.
async function runJob(job, apiKey) {
  await Promise.all(Array.from({ length: MAX_PARALLEL_REQUESTS }, (_, index) => runWorker(job, apiKey, index)));
  if (job.error) throw job.error;
}

function startJob({ apiKey, key, videoId, title, captions, hash, texts, priorityTime, target }) {
  const job = {
    videoId,
    title,
    captions,
    hash,
    texts,
    priorityTime,
    chunks: createChunks(captions, texts, firstPendingIndex(captions, texts, priorityTime)),
    inFlight: new Set(), // Chunks a worker is translating
    error: null, // First error; stops the job
    targets: new Set([target]),
  };
  job.notify = (message) => notifyTargets(job.targets, { videoId, ...message });
  jobs.set(key, job);
  updateKeepAlive();

  const startedAt = Date.now();
  const { done, total } = progressOf(job);
  console.log(
    `${LOG_PREFIX} Translation ${done ? "resumed" : "started"}: videoId=${videoId}, ` +
      `${captions.length} lines, ${done}/${total} chunks ready, model=${GEMINI_MODEL}`
  );

  runJob(job, apiKey)
    .then(() => {
      console.log(`${LOG_PREFIX} Translation finished: videoId=${videoId}, ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
      job.notify({ type: "TRANSLATION_RESULT", texts: job.texts, fromCache: false });
    })
    .catch((error) => {
      console.error(`${LOG_PREFIX} Translation failed: videoId=${videoId}`, error);
      const saved = progressOf(job).done > 0;
      // Shown to the user in the overlay, so it stays Turkish.
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

// Validates incoming data and keeps only the start, duration and text fields.
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

// --- Messages ---
// Error texts returned here are shown in the overlay, so they stay Turkish.

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

  // If the same video is being started right now (cache read in progress), no second job is opened.
  const starting = jobsStarting.get(key);
  if (starting) {
    await starting;
    return handleTranslate(message, sender);
  }

  // If the same video is already being translated, this tab receives the results too; the
  // finished part is sent immediately.
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
  // 1) Cache: a complete translation needs no API call (and no key).
  const cached = await readTranslation(videoId, hash, captions.length);
  if (cached?.complete) {
    touchTranslation(videoId);
    console.log(`${LOG_PREFIX} Loaded from cache: videoId=${videoId}, ${captions.length} lines`);
    return { ok: true, status: "cached", texts: cached.texts };
  }

  // A video the user has not asked to translate only shows a complete cached translation.
  if (message.cacheOnly) return { ok: true, status: "not-cached", texts: null };

  const apiKey = await getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error: "API anahtarı bulunamadı. Eklenti popup'ından Gemini API anahtarınızı girin.",
      texts: cached?.texts ?? null,
    };
  }

  // 2) An interrupted translation resumes where it stopped.
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
      console.log(`${LOG_PREFIX} Watch page ready: videoId=${message.videoId}, tabId=${tabId}`);
      return { ok: true };
    }

    case "HAS_TRANSLATION":
      return { ok: true, available: await hasTranslation(message.videoId) };

    case "TRANSLATE":
      return handleTranslate(message, sender);

    // Popup: cache info and clearing.
    case "GET_CACHE_STATS":
      return { ok: true, ...(await getCacheStats()), activeJobs: jobs.size };

    case "CLEAR_TRANSLATION_CACHE":
      // Running jobs save after every chunk, so they end up in the cache again when they finish.
      return { ok: true, ...(await clearTranslationCache()), activeJobs: jobs.size };

    case "EXPORT_TRANSLATION_CACHE": {
      const data = await exportTranslationCache();
      return { ok: true, count: Object.keys(data.entries).length, data };
    }

    case "IMPORT_TRANSLATION_CACHE":
      return { ok: true, ...(await importTranslationCache(message.data)) };

    // The user seeked: the chunk at that position moves to the front.
    case "TRANSLATION_PRIORITY": {
      if (Number.isFinite(message.time)) {
        for (const job of jobs.values()) {
          if (job.videoId === message.videoId) job.priorityTime = message.time;
        }
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown message type: ${message?.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Accept messages from this extension only.
  if (sender.id !== chrome.runtime.id) {
    return false;
  }

  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error(`${LOG_PREFIX} Message handling failed:`, error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    });

  // Tell Chrome we will respond asynchronously.
  return true;
});

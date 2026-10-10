// Content script: runs on youtube.com and only becomes active on /watch pages.
// Extracts the video's original captions as a [{ start, duration, text }] array.
//
// Flow:
// 0. Nothing is downloaded until the user turns on the "Türkçe altyazı" switch in the TR
//    button's menu, except for videos translated before (complete in the cache, or still
//    being translated), which are shown right away. The auto-translate option (menu or
//    popup) starts every video without a click.
// 1. captionTracks: read from the player (page-bridge.js), or failing that from the
//    ytInitialPlayerResponse object in the page source.
// 2. The original-language track is chosen and downloaded as json3. Auto-generated captions
//    are re-segmented into sentences (segmenter.js).
// 3. If YouTube returns an empty response (PO token required), the token parameters from
//    the player's own timedtext request are used. If there is no token yet, captions are
//    briefly turned on in the player to trigger a request that carries one.
// 4. The captions are sent to the background. If the translation is not cached, Gemini
//    translates it chunk by chunk; each chunk (TRANSLATION_CHUNK) is shown as soon as it arrives.
//
// YouTube is a SPA, so URL and DOM changes are watched separately.
// This script never touches the API key; all Gemini work happens in the background.
// Strings shown to the user (overlay) are Turkish; log messages are English.

(() => {
  if (window.__ytCeviriLoaded) return;
  window.__ytCeviriLoaded = true;

  const LOG_PREFIX = "[YT Çeviri]";
  const BRIDGE_SOURCE = "yt-ceviri-bridge";
  const CONTENT_SOURCE = "yt-ceviri-content";
  const BRIDGE_TIMEOUT_MS = 10000;
  const TOKEN_TIMEOUT_MS = 8000; // Time for the token-bearing request to arrive after a trigger
  // Same as page-bridge.js: limit for waiting out an ad, and trigger attempts for the token.
  const TRIGGER_TIMEOUT_MS = 5 * 60 * 1000;
  const TRIGGER_ATTEMPTS = 6;
  const TRIGGER_ATTEMPT_MS = 2500;
  const TRIGGER_TOTAL_MS = TRIGGER_TIMEOUT_MS + TRIGGER_ATTEMPTS * TRIGGER_ATTEMPT_MS;
  const NAVIGATION_CHECK_DELAY_MS = 300;
  const CACHE_LIMIT = 20;
  const AUTO_TRANSLATE_KEY = "autoTranslate"; // Popup option; off by default
  // Track-specific parameters that are not copied from the token-bearing URL.
  const TRACK_PARAMS = new Set(["lang", "kind", "tlang", "fmt", "name"]);

  let lastVideoId = null;
  let runId = 0;
  let requestSeq = 0;
  let tokenRetry = null; // { videoId, options } of the run that failed for lack of a token
  let checkTimer = null;

  const pendingRequests = new Map(); // id -> { resolve, timer }
  const tokenParamsByVideo = new Map(); // videoId -> URLSearchParams
  const tokenWaiters = new Map(); // videoId -> [resolve]
  const captionCache = new Map(); // videoId -> result
  const requestedVideos = new Set(); // videoIds the user asked to translate on this page

  // Thrown with the reason when no token could be obtained; retried when CC is turned on.
  class TokenError extends Error {}

  // Turkish subtitles over the player, the TR button and its menu (overlay.js, menu.js).
  const overlay = new SubtitleOverlay();

  // --- Communication with the bridge (page-bridge.js) ---

  function requestBridge(type, payload = {}, timeoutMs = BRIDGE_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const id = ++requestSeq;
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        resolve(null);
      }, timeoutMs);
      pendingRequests.set(id, { resolve, timer });
      window.postMessage({ source: CONTENT_SOURCE, type, id, ...payload }, location.origin);
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== BRIDGE_SOURCE) return;
    const message = event.data;

    if (message.type === "TIMEDTEXT_URL") {
      handleTimedtextUrl(message.url);
      return;
    }

    const pending = pendingRequests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRequests.delete(message.id);
    pending.resolve(message.data ?? null);
  });

  // --- PO token handling ---

  function handleTimedtextUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl, location.origin);
    } catch {
      return;
    }

    // Right after a video starts, the player may send a request before the token exists
    // (no pot); such requests are ignored.
    const videoId = url.searchParams.get("v");
    if (!videoId || !url.searchParams.has("pot")) return;

    // The token alone is not enough; client parameters such as c, cver and cplayer are needed too.
    const params = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      if (!TRACK_PARAMS.has(key)) params.set(key, value);
    }
    tokenParamsByVideo.set(videoId, params);

    const waiters = tokenWaiters.get(videoId);
    if (waiters) {
      tokenWaiters.delete(videoId);
      waiters.forEach((resolve) => resolve(params));
    }

    // If an earlier attempt failed for lack of a token (e.g. the user just turned on CC), retry.
    if (videoId === tokenRetry?.videoId && videoId === lastVideoId) {
      const { options } = tokenRetry;
      tokenRetry = null;
      processVideo(videoId, options);
    }
  }

  function waitForToken(videoId, timeoutMs) {
    const known = tokenParamsByVideo.get(videoId);
    if (known) return Promise.resolve(known);

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const waiters = tokenWaiters.get(videoId) || [];
      waiters.push((params) => {
        clearTimeout(timer);
        resolve(params);
      });
      tokenWaiters.set(videoId, waiters);
    });
  }

  // --- Reading captionTracks ---

  // Extracts the first JSON object after "marker", skipping braces inside strings.
  function extractJsonObject(text, marker) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex === -1) return null;
    const start = text.indexOf("{", markerIndex);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
    return null;
  }

  function normalizeCaptionInfo(playerResponse) {
    const renderer = playerResponse?.captions?.playerCaptionsTracklistRenderer;
    const tracks = (renderer?.captionTracks || []).map((track) => ({
      baseUrl: track.baseUrl,
      languageCode: track.languageCode,
      kind: track.kind === "asr" ? "asr" : "manual",
      name: track.name?.simpleText || track.name?.runs?.map((run) => run.text).join("") || track.languageCode,
    }));
    // In multi-audio (AI-dubbed) videos the default audio track is the original language,
    // e.g. audioTrackId "en-US.4". Single-audio videos have no audioTrackId.
    const audioTrack = renderer?.audioTracks?.[renderer.defaultAudioTrackIndex ?? 0];

    return {
      videoId: playerResponse?.videoDetails?.videoId || null,
      title: playerResponse?.videoDetails?.title || "",
      tracks,
      defaultTrackIndex: audioTrack?.defaultCaptionTrackIndex ?? null,
      originalLanguage: audioTrack?.audioTrackId?.split(".")[0] || null,
    };
  }

  async function getCaptionInfo(videoId) {
    const fromPlayer = await requestBridge("GET_PLAYER_RESPONSE", { videoId });
    if (fromPlayer) {
      // Token-bearing request the player made before this script loaded.
      if (fromPlayer.timedtextUrl) handleTimedtextUrl(fromPlayer.timedtextUrl);
      return normalizeCaptionInfo(fromPlayer);
    }

    console.warn(`${LOG_PREFIX} Could not read from the player, trying the page source.`);
    const response = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, { credentials: "include" });
    const playerResponse = extractJsonObject(await response.text(), "ytInitialPlayerResponse = ");
    if (playerResponse?.videoDetails?.videoId !== videoId) {
      throw new Error("ytInitialPlayerResponse bulunamadı.");
    }
    return normalizeCaptionInfo(playerResponse);
  }

  // Original language, in order: the original audio track's language, the default
  // auto-generated (asr) track, the first asr track. Dubbed videos have one asr track per
  // audio language, so the first asr track can be misleading. A manual track in that
  // language is preferred over the auto-generated one.
  function pickOriginalTrack({ tracks, defaultTrackIndex, originalLanguage }) {
    if (!tracks.length) return null;

    const baseOf = (code) => code.split("-")[0];
    const defaultTrack = tracks[defaultTrackIndex];
    const language =
      originalLanguage ||
      (defaultTrack?.kind === "asr" ? defaultTrack.languageCode : null) ||
      tracks.find((track) => track.kind === "asr")?.languageCode;

    if (language) {
      const sameBase = (track) => baseOf(track.languageCode) === baseOf(language);
      const match =
        tracks.find((track) => track.kind === "manual" && track.languageCode === language) ||
        tracks.find((track) => track.kind === "manual" && sameBase(track)) ||
        tracks.find((track) => track.kind === "asr" && sameBase(track));
      if (match) return match;
    }

    return defaultTrack || tracks[0];
  }

  // --- Downloading captions ---
  // Error texts here can end up in the overlay, so they stay Turkish.

  function buildTimedtextUrl(baseUrl, tokenParams) {
    const url = new URL(baseUrl, location.origin);
    if (url.origin !== location.origin || url.pathname !== "/api/timedtext") {
      throw new Error(`Beklenmeyen altyazı adresi: ${url.origin}${url.pathname}`);
    }

    url.searchParams.set("fmt", "json3");
    url.searchParams.delete("tlang");
    tokenParams?.forEach((value, key) => {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    });
    return url.toString();
  }

  async function fetchTimedtext(url) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) return null;
    const text = await response.text();
    return text.trim() ? text : null;
  }

  // If the player fetches captions on its own, the token arrives by itself. Otherwise the
  // bridge turns captions on in the player (after any ad) to trigger a token-bearing request.
  // If no token can be obtained, the reason is reported with a TokenError.
  async function obtainToken(videoId, languageCode) {
    console.log(`${LOG_PREFIX} PO token required; triggering captions (after the ad, if any)…`);

    const tokenArrived = waitForToken(videoId, TRIGGER_TOTAL_MS + TOKEN_TIMEOUT_MS);
    const trigger = await Promise.race([
      requestBridge("TRIGGER_CAPTIONS", { videoId, languageCode }, TRIGGER_TOTAL_MS + BRIDGE_TIMEOUT_MS),
      tokenArrived.then(() => null),
    ]);

    const known = tokenParamsByVideo.get(videoId);
    if (known) return known;

    if (trigger?.ok) {
      const params = await waitForToken(videoId, TOKEN_TIMEOUT_MS);
      if (params) return params;
    }

    if (!trigger) throw new TokenError("sayfa köprüsü yanıt vermedi (page-bridge.js yüklenmemiş olabilir)");
    if (trigger.reason === "timeout") throw new TokenError("video 5 dakika içinde oynatılmadı");
    if (trigger.reason === "no-token") {
      throw new TokenError(`oynatıcı ${trigger.attempts} denemede token'lı altyazı isteği yapmadı`);
    }
    if (!trigger.ok) throw new TokenError(`tetikleme başarısız (${trigger.reason})`);
    throw new TokenError("token'lı istek yakalandı ama içeriğe ulaşılamadı");
  }

  async function downloadCaptions(videoId, track) {
    // 1) Try directly (for videos that do not require a token).
    const direct = await fetchTimedtext(buildTimedtextUrl(track.baseUrl));
    if (direct) return direct;

    // 2) Try with the token captured from the player.
    const tokenParams = tokenParamsByVideo.get(videoId) || (await obtainToken(videoId, track.languageCode));
    const body = await fetchTimedtext(buildTimedtextUrl(track.baseUrl, tokenParams));
    if (!body) {
      // The token may have expired; get a fresh one on the next attempt.
      tokenParamsByVideo.delete(videoId);
      throw new TokenError("token'lı istek de boş döndü");
    }
    return body;
  }

  // --- json3 parsing ---

  const toSeconds = (ms) => Math.round(ms) / 1000;

  // Manual captions: every event is already one caption line.
  // Auto-generated (asr) captions are re-segmented into sentences by segmenter.js.
  function parseJson3(text, kind) {
    const data = JSON.parse(text);
    if (kind === "asr") return buildAsrCues(data);

    const cues = [];
    for (const event of data.events || []) {
      // Events without segs define windows; aAppend events contain only a line break.
      if (!event.segs) continue;
      const line = event.segs.map((seg) => seg.utf8 || "").join("").replace(/\s+/g, " ").trim();
      if (!line) continue;

      cues.push({
        start: toSeconds(event.tStartMs || 0),
        duration: toSeconds(event.dDurationMs || 0),
        text: line,
      });
    }
    return cues;
  }

  // --- Results ---

  function cacheResult(result) {
    captionCache.set(result.videoId, result);
    if (captionCache.size > CACHE_LIMIT) {
      captionCache.delete(captionCache.keys().next().value);
    }
  }

  // For access from the page console: ytCeviri.captions, ytCeviri.translated
  function exposeResult(result) {
    window.postMessage({ source: CONTENT_SOURCE, type: "EXPOSE_CAPTIONS", result }, location.origin);
  }

  function report(result) {
    console.log(
      `${LOG_PREFIX} Captions ready: "${result.title}" (${result.trackName}, ${result.language}, ${result.kind}) — ${result.captions.length} lines`
    );
    console.log(`${LOG_PREFIX} JSON:`, result.captions);
    console.table(result.captions.slice(0, 15));
    exposeResult(result);
  }

  function reportTranslation(result) {
    console.log(`${LOG_PREFIX} Turkish translation ready: ${result.translated.length} lines`);
    console.log(`${LOG_PREFIX} Translation JSON:`, result.translated);
    console.table(result.translated.slice(0, 15));
    exposeResult(result);
    overlay.setCues(displayCues(result));
    overlay.setStatus("ready", "Türkçe altyazı");
  }

  // --- Translation (background + Gemini) ---

  const isCurrent = (videoId) => videoId === lastVideoId;

  // The background sends only translated texts (in original order, null where not yet
  // translated). Timestamps always come from the original captions held by the content script.
  function applyTranslatedTexts(result, startIndex, texts) {
    if (!Array.isArray(texts)) return;
    result.translatedTexts ??= new Array(result.captions.length).fill(null);
    texts.forEach((text, i) => {
      if (typeof text === "string" && startIndex + i < result.captions.length) {
        result.translatedTexts[startIndex + i] = text;
      }
    });
  }

  function translatedCues(result) {
    const texts = result.translatedTexts || [];
    const cues = [];
    result.captions.forEach((cue, i) => {
      if (typeof texts[i] === "string") cues.push({ start: cue.start, duration: cue.duration, text: texts[i] });
    });
    return cues;
  }

  // Every caption line for the overlay, with its translation (null until translated). The
  // original is shown too in dual mode.
  function displayCues(result) {
    const texts = result.translatedTexts || [];
    return result.captions.map((cue, i) => ({
      start: cue.start,
      duration: cue.duration,
      original: cue.text,
      wordStarts: cue.wordStarts,
      text: typeof texts[i] === "string" ? texts[i] : null,
    }));
  }

  // Finished chunks are shown before the whole translation is done.
  function showPartialTranslation(result, statusText) {
    if (!isCurrent(result.videoId) || result.translated) return;
    overlay.setCues(displayCues(result));
    overlay.setStatus("loading", statusText);
  }

  function completeTranslation(result) {
    result.translated = translatedCues(result);
    if (isCurrent(result.videoId)) reportTranslation(result);
  }

  // The menu's "Türkçe altyazı" switch starts the translation; until then it is only offered.
  function offerTranslation() {
    overlay.setStatus("available", "Türkçeye çevir");
  }

  // cacheOnly: the user has not asked for this video, so only a complete cached translation
  // (or one already running) is shown and the API is never called.
  // retranslate: the cached translation is ignored and the video is translated again with the
  // model selected in the popup.
  async function requestTranslation(result, { cacheOnly = false, retranslate = false } = {}) {
    if (retranslate) {
      // The old texts stay on screen until their new translation arrives.
      result.translated = null;
    } else if (result.translated) {
      reportTranslation(result);
      return;
    }
    if (result.language.split("-")[0] === "tr") {
      console.log(`${LOG_PREFIX} Captions are already Turkish; translation skipped.`);
      // There is no separate original to show in dual mode.
      overlay.setCues(result.captions.map((cue) => ({ ...cue, original: null })));
      overlay.setStatus("ready", "Türkçe altyazı");
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE",
        videoId: result.videoId,
        title: result.title,
        language: result.language,
        // Word timings (highlighting) stay here; only what is translated is sent.
        captions: result.captions.map(({ start, duration, text }) => ({ start, duration, text })),
        // The chunk at the playback position is translated first (e.g. a video opened with &t=1219s).
        currentTime: overlay.currentTime(),
        cacheOnly,
        retranslate,
      });
      applyTranslatedTexts(result, 0, response?.texts);

      // The cached translation no longer matches the captions (e.g. new segmentation rules).
      if (response?.status === "not-cached") {
        console.log(`${LOG_PREFIX} No usable cached translation; waiting for the user.`);
        if (isCurrent(result.videoId)) offerTranslation();
        return;
      }

      if (!response?.ok) {
        const error = response?.error || "bilinmeyen hata";
        console.warn(`${LOG_PREFIX} Translation could not start: ${error}`);
        if (isCurrent(result.videoId)) {
          overlay.setCues(displayCues(result));
          overlay.setStatus("error", `Çeviri başlatılamadı: ${error}`);
        }
        return;
      }

      if (response.status === "cached") {
        console.log(`${LOG_PREFIX} Translation loaded from cache (${result.captions.length} lines).`);
        completeTranslation(result);
        return;
      }

      const state = { started: "started", resumed: "resumed", pending: "already running" }[response.status];
      console.log(
        `${LOG_PREFIX} Translation ${state} (${result.captions.length} lines, ${response.done}/${response.total} chunks ready)…`
      );
      showPartialTranslation(result, `Türkçe altyazı hazırlanıyor… (${response.done}/${response.total})`);
    } catch (error) {
      console.warn(`${LOG_PREFIX} Could not reach the background:`, error?.message || error);
      if (isCurrent(result.videoId)) overlay.setStatus("error", "Eklentiye ulaşılamadı; sayfayı yenileyin.");
    }
  }

  // If the user seeks while translating, the chunk at that position moves to the front.
  overlay.onSeek = (time) => {
    const result = captionCache.get(lastVideoId);
    if (!result || result.translated || result.language.split("-")[0] === "tr") return;
    chrome.runtime.sendMessage({ type: "TRANSLATION_PRIORITY", videoId: result.videoId, time }).catch(() => {});
  };

  chrome.runtime.onMessage.addListener((message) => {
    // If the user moved to another video, the result stays cached and is shown on return.
    const result = captionCache.get(message?.videoId);

    switch (message?.type) {
      case "TRANSLATION_CHUNK":
        if (!result) return;
        console.log(`${LOG_PREFIX} Translation progress: ${message.done}/${message.total} chunks`);
        applyTranslatedTexts(result, message.startIndex, message.texts);
        showPartialTranslation(result, `Türkçe altyazı hazırlanıyor… (${message.done}/${message.total})`);
        break;

      case "TRANSLATION_STATUS":
        console.warn(`${LOG_PREFIX} ${message.message}`);
        if (isCurrent(message.videoId) && !result?.translated) overlay.setStatus("loading", message.message);
        break;

      case "TRANSLATION_RESULT":
        if (!result) return;
        applyTranslatedTexts(result, 0, message.texts);
        completeTranslation(result);
        break;

      case "TRANSLATION_ERROR":
        console.error(`${LOG_PREFIX} Translation failed (${message.videoId}): ${message.error}`);
        // Finished chunks stay on screen.
        if (isCurrent(message.videoId)) overlay.setStatus("error", `Çeviri başarısız: ${message.error}`);
        break;
    }
  });

  async function notifyBackground(videoId) {
    try {
      await chrome.runtime.sendMessage({ type: "CONTENT_READY", videoId });
    } catch (error) {
      // When the extension is reloaded, the old content script loses its connection.
      console.warn(`${LOG_PREFIX} Could not reach the background:`, error?.message || error);
    }
  }

  async function isAutoTranslateOn() {
    try {
      return (await chrome.storage.local.get(AUTO_TRANSLATE_KEY))[AUTO_TRANSLATE_KEY] === true;
    } catch {
      return false;
    }
  }

  async function hasTranslation(videoId) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "HAS_TRANSLATION", videoId });
      return response?.available === true;
    } catch {
      return false;
    }
  }

  // Decides whether a newly opened video is processed without a click.
  async function startVideo(videoId) {
    if (requestedVideos.has(videoId)) {
      processVideo(videoId);
      return;
    }

    const currentRun = ++runId;
    const [autoTranslate, available] = await Promise.all([isAutoTranslateOn(), hasTranslation(videoId)]);
    if (currentRun !== runId) return; // Navigated away, or the user clicked TR meanwhile.

    if (autoTranslate) {
      processVideo(videoId);
    } else if (available) {
      console.log(`${LOG_PREFIX} Translated before; loading: ${videoId}`);
      processVideo(videoId, { cacheOnly: true });
    } else {
      console.log(`${LOG_PREFIX} Waiting for the user to turn on the subtitles: ${videoId}`);
      offerTranslation();
    }
  }

  // Menu switch: translate the current video, or retry after an error.
  // Menu and popup: translate it again with the selected model (retranslate).
  function translateCurrentVideo(options) {
    if (!lastVideoId) return false;
    requestedVideos.add(lastVideoId);
    overlay.setEnabled(true);
    processVideo(lastVideoId, options);
    return true;
  }

  overlay.onRequest = () => translateCurrentVideo();
  overlay.onRetranslate = () => translateCurrentVideo({ retranslate: true });

  // Messages from the popup. The reply goes out right away; progress and errors show on the TR button.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "GET_VIDEO") {
      const title = document.title.replace(/^\(\d+\) /, "").replace(/ - YouTube$/, "");
      sendResponse({ videoId: lastVideoId, title: lastVideoId ? title : null });
    } else if (message?.type === "RETRANSLATE") {
      console.log(`${LOG_PREFIX} Re-translating with the selected model: ${lastVideoId}`);
      const started = translateCurrentVideo({ retranslate: true });
      // Shown in the popup, so it stays Turkish.
      sendResponse(started ? { ok: true } : { ok: false, error: "Bu sekmede açık bir YouTube videosu yok." });
    }
  });

  // options: { cacheOnly, retranslate }, see requestTranslation.
  async function processVideo(videoId, options = {}) {
    const currentRun = ++runId;
    const isStale = () => currentRun !== runId;

    if (captionCache.has(videoId)) {
      const cached = captionCache.get(videoId);
      report(cached);
      requestTranslation(cached, options);
      return;
    }

    overlay.setStatus("loading", "Altyazı alınıyor…");
    try {
      const info = await getCaptionInfo(videoId);
      if (isStale()) return;

      const track = pickOriginalTrack(info);
      if (!track) {
        console.log(`${LOG_PREFIX} This video has no captions: ${videoId}`);
        overlay.setStatus("idle", "Bu videoda altyazı yok");
        return;
      }

      const body = await downloadCaptions(videoId, track);
      if (isStale()) return;

      const result = {
        videoId,
        title: info.title,
        language: track.languageCode,
        kind: track.kind,
        trackName: track.name,
        captions: parseJson3(body, track.kind),
      };
      cacheResult(result);
      report(result);
      requestTranslation(result, options);
    } catch (error) {
      if (isStale()) return;
      if (error instanceof TokenError) {
        tokenRetry = { videoId, options };
        console.warn(
          `${LOG_PREFIX} Captions could not be downloaded: ${error.message}. Will retry automatically when CC is turned on. (videoId=${videoId})`
        );
        overlay.setStatus("error", `Altyazı alınamadı: ${error.message}. CC'yi açınca tekrar denenecek.`);
        return;
      }
      console.error(`${LOG_PREFIX} Captions could not be loaded:`, error);
      overlay.setStatus("error", `Altyazı alınamadı: ${error.message}`);
    }
  }

  // --- SPA navigation tracking ---

  function checkPage() {
    if (location.pathname !== "/watch") {
      if (lastVideoId) overlay.clear();
      lastVideoId = null;
      runId++; // Cancel the run in progress.
      return;
    }

    const videoId = new URL(location.href).searchParams.get("v");
    if (!videoId) return;
    if (videoId === lastVideoId) {
      // The player may not have existed yet, or YouTube redrew its controls; the button is
      // the only way to start a translation.
      overlay.attach();
      return;
    }

    lastVideoId = videoId;
    tokenRetry = null;
    overlay.clear();
    overlay.attach();
    console.log(`${LOG_PREFIX} Watch page detected: ${videoId}`);
    notifyBackground(videoId);
    startVideo(videoId);
  }

  // Coalesces bursts of events; even under constant DOM changes it runs within the delay.
  function scheduleCheck() {
    if (checkTimer) return;
    checkTimer = setTimeout(() => {
      checkTimer = null;
      checkPage();
    }, NAVIGATION_CHECK_DELAY_MS);
  }

  // YouTube's own navigation events.
  document.addEventListener("yt-navigate-finish", scheduleCheck);
  document.addEventListener("yt-page-data-updated", scheduleCheck);
  // Back/forward buttons.
  window.addEventListener("popstate", scheduleCheck);
  // Fallback: the title changes on every video switch; catches DOM changes if events are missed.
  new MutationObserver(scheduleCheck).observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  checkPage();
})();

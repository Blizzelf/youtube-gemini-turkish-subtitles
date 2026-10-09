// Content script: youtube.com üzerinde çalışır, yalnızca /watch sayfalarında aktifleşir.
// Videonun orijinal altyazısını [{ start, duration, text }] dizisi olarak çıkarır.
//
// Akış:
// 1. captionTracks: oynatıcıdan (page-bridge.js), olmazsa sayfa kaynağındaki
//    ytInitialPlayerResponse objesinden okunur.
// 2. Orijinal dil izi seçilir ve json3 formatında indirilir. Otomatik altyazı
//    cümlelere göre yeniden bölünür (segmenter.js).
// 3. YouTube boş yanıt dönerse (PO token gerekli), oynatıcının kendi timedtext
//    isteğindeki token parametreleri kullanılır. Token yoksa oynatıcıda altyazı
//    kısa süreliğine açılarak token'lı istek tetiklenir.
//
// 4. Altyazı background'a gönderilir. Çeviri önbellekte yoksa Gemini ile parça parça
//    çevrilir; her parça (TRANSLATION_CHUNK) gelir gelmez ekranda gösterilir.
//
// YouTube bir SPA olduğu için URL ve DOM değişimleri ayrıca izlenir.
// Bu script API anahtarına erişmez; tüm Gemini işleri background üzerinden yürür.

(() => {
  if (window.__ytCeviriLoaded) return;
  window.__ytCeviriLoaded = true;

  const LOG_PREFIX = "[YT Çeviri]";
  const BRIDGE_SOURCE = "yt-ceviri-bridge";
  const CONTENT_SOURCE = "yt-ceviri-content";
  const BRIDGE_TIMEOUT_MS = 10000;
  const TOKEN_TIMEOUT_MS = 8000; // Tetiklemeden sonra token'lı isteğin gelmesi için süre
  // page-bridge.js ile aynı: reklamın bitmesini bekleme sınırı ve token için tetikleme denemeleri.
  const TRIGGER_TIMEOUT_MS = 5 * 60 * 1000;
  const TRIGGER_ATTEMPTS = 6;
  const TRIGGER_ATTEMPT_MS = 2500;
  const TRIGGER_TOTAL_MS = TRIGGER_TIMEOUT_MS + TRIGGER_ATTEMPTS * TRIGGER_ATTEMPT_MS;
  const NAVIGATION_CHECK_DELAY_MS = 300;
  const CACHE_LIMIT = 20;
  // Token'lı URL'den kopyalanmayacak, ize özel parametreler.
  const TRACK_PARAMS = new Set(["lang", "kind", "tlang", "fmt", "name"]);

  let lastVideoId = null;
  let runId = 0;
  let requestSeq = 0;
  let tokenRetryVideoId = null;
  let checkTimer = null;

  const pendingRequests = new Map(); // id -> { resolve, timer }
  const tokenParamsByVideo = new Map(); // videoId -> URLSearchParams
  const tokenWaiters = new Map(); // videoId -> [resolve]
  const captionCache = new Map(); // videoId -> sonuç

  // Token alınamadığında nedeniyle birlikte fırlatılır; CC açılınca tekrar denenir.
  class TokenError extends Error {}

  // Oynatıcı üstündeki Türkçe altyazı ve TR düğmesi (overlay.js).
  const overlay = new SubtitleOverlay();

  // --- Köprü (page-bridge.js) ile iletişim ---

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

  // --- PO token yönetimi ---

  function handleTimedtextUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl, location.origin);
    } catch {
      return;
    }

    // Video yeni başladığında oynatıcı token üretilmeden (pot olmadan) istek yapabilir; yok sayılır.
    const videoId = url.searchParams.get("v");
    if (!videoId || !url.searchParams.has("pot")) return;

    // Token tek başına yetmez; c, cver, cplayer gibi istemci parametreleri de gerekir.
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

    // Daha önce token yüzünden başarısız olduysa (ör. kullanıcı CC'yi şimdi açtı) tekrar dene.
    if (videoId === tokenRetryVideoId && videoId === lastVideoId) {
      tokenRetryVideoId = null;
      processVideo(videoId);
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

  // --- captionTracks okuma ---

  // Metindeki "marker"dan sonraki ilk JSON objesini, string içindeki parantezleri atlayarak çıkarır.
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
    // Çok sesli (yapay zekâ ile seslendirilmiş) videolarda varsayılan ses izi orijinal dildir,
    // ör. audioTrackId "en-US.4". Tek sesli videolarda audioTrackId yoktur.
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
      // Bu script yüklenmeden önce oynatıcının yaptığı token'lı istek.
      if (fromPlayer.timedtextUrl) handleTimedtextUrl(fromPlayer.timedtextUrl);
      return normalizeCaptionInfo(fromPlayer);
    }

    console.warn(`${LOG_PREFIX} Oynatıcıdan okunamadı, sayfa kaynağı deneniyor.`);
    const response = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, { credentials: "include" });
    const playerResponse = extractJsonObject(await response.text(), "ytInitialPlayerResponse = ");
    if (playerResponse?.videoDetails?.videoId !== videoId) {
      throw new Error("ytInitialPlayerResponse bulunamadı.");
    }
    return normalizeCaptionInfo(playerResponse);
  }

  // Orijinal dil sırasıyla: orijinal ses izinin dili, varsayılan otomatik (asr) iz, ilk asr iz.
  // Seslendirilmiş videolarda her ses dili için ayrı asr iz olduğundan ilk asr iz yanıltıcı olabilir.
  // O dilde elle yazılmış altyazı varsa otomatik olana tercih edilir.
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

  // --- Altyazı indirme ---

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

  // Oynatıcı altyazıyı kendisi çekerse token kendiliğinden gelir. Gelmezse köprü,
  // reklam bittikten sonra oynatıcıda altyazıyı açarak token'lı isteği tetikler.
  // Token alınamazsa nedeni TokenError ile bildirilir.
  async function obtainToken(videoId, languageCode) {
    console.log(`${LOG_PREFIX} PO token gerekiyor; altyazı tetiklenecek (reklam varsa bittikten sonra)…`);

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
    // 1) Doğrudan dene (token istemeyen videolar için).
    const direct = await fetchTimedtext(buildTimedtextUrl(track.baseUrl));
    if (direct) return direct;

    // 2) Oynatıcıdan yakalanan token ile dene.
    const tokenParams = tokenParamsByVideo.get(videoId) || (await obtainToken(videoId, track.languageCode));
    const body = await fetchTimedtext(buildTimedtextUrl(track.baseUrl, tokenParams));
    if (!body) {
      // Token süresi dolmuş olabilir; bir sonraki denemede yenisi alınsın.
      tokenParamsByVideo.delete(videoId);
      throw new TokenError("token'lı istek de boş döndü");
    }
    return body;
  }

  // --- json3 ayrıştırma ---

  const toSeconds = (ms) => Math.round(ms) / 1000;

  // Elle yazılmış altyazı: her olay zaten bir altyazı satırıdır.
  // Otomatik (asr) altyazı ise segmenter.js ile cümlelere göre yeniden bölünür.
  function parseJson3(text, kind) {
    const data = JSON.parse(text);
    if (kind === "asr") return buildAsrCues(data);

    const cues = [];
    for (const event of data.events || []) {
      // segs olmayan olaylar pencere tanımıdır; aAppend olayları yalnızca satır sonu içerir.
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

  // --- Sonuç ---

  function cacheResult(result) {
    captionCache.set(result.videoId, result);
    if (captionCache.size > CACHE_LIMIT) {
      captionCache.delete(captionCache.keys().next().value);
    }
  }

  // Sayfa konsolundan erişim için: ytCeviri.captions, ytCeviri.translated
  function exposeResult(result) {
    window.postMessage({ source: CONTENT_SOURCE, type: "EXPOSE_CAPTIONS", result }, location.origin);
  }

  function report(result) {
    console.log(
      `${LOG_PREFIX} Altyazı hazır: "${result.title}" (${result.trackName}, ${result.language}, ${result.kind}) — ${result.captions.length} satır`
    );
    console.log(`${LOG_PREFIX} JSON:`, result.captions);
    console.table(result.captions.slice(0, 15));
    exposeResult(result);
  }

  function reportTranslation(result) {
    console.log(`${LOG_PREFIX} Türkçe çeviri hazır: ${result.translated.length} satır`);
    console.log(`${LOG_PREFIX} Çeviri JSON:`, result.translated);
    console.table(result.translated.slice(0, 15));
    exposeResult(result);
    overlay.setCues(result.translated);
    overlay.setStatus("ready", "Türkçe altyazı");
  }

  // --- Çeviri (background + Gemini) ---

  const isCurrent = (videoId) => videoId === lastVideoId;

  // Background yalnızca çevrilmiş metinleri gönderir (orijinal sırayla, henüz çevrilmeyenler null).
  // Zaman damgaları her zaman content script'teki orijinal altyazıdan alınır.
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

  // Hazır olan parçalar çeviri bitmeden ekranda gösterilir.
  function showPartialTranslation(result, statusText) {
    if (!isCurrent(result.videoId) || result.translated) return;
    overlay.setCues(translatedCues(result));
    overlay.setStatus("loading", statusText);
  }

  function completeTranslation(result) {
    result.translated = translatedCues(result);
    if (isCurrent(result.videoId)) reportTranslation(result);
  }

  async function requestTranslation(result) {
    if (result.translated) {
      reportTranslation(result);
      return;
    }
    if (result.language.split("-")[0] === "tr") {
      console.log(`${LOG_PREFIX} Altyazı zaten Türkçe, çeviri atlandı.`);
      overlay.setCues(result.captions);
      overlay.setStatus("ready", "Türkçe altyazı");
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE",
        videoId: result.videoId,
        title: result.title,
        language: result.language,
        captions: result.captions,
        // Oynatma konumundaki parça önce çevrilir (ör. &t=1219s ile açılan video).
        currentTime: overlay.currentTime(),
      });
      applyTranslatedTexts(result, 0, response?.texts);

      if (!response?.ok) {
        const error = response?.error || "bilinmeyen hata";
        console.warn(`${LOG_PREFIX} Çeviri başlatılamadı: ${error}`);
        if (isCurrent(result.videoId)) {
          overlay.setCues(translatedCues(result));
          overlay.setStatus("error", `Çeviri başlatılamadı: ${error}`);
        }
        return;
      }

      if (response.status === "cached") {
        console.log(`${LOG_PREFIX} Çeviri önbellekten yüklendi (${result.captions.length} satır).`);
        completeTranslation(result);
        return;
      }

      const state = { started: "başladı", resumed: "kaldığı yerden sürüyor", pending: "zaten sürüyor" }[response.status];
      console.log(
        `${LOG_PREFIX} Çeviri ${state} (${result.captions.length} satır, ${response.done}/${response.total} parça hazır)…`
      );
      showPartialTranslation(result, `Türkçe altyazı hazırlanıyor… (${response.done}/${response.total})`);
    } catch (error) {
      console.warn(`${LOG_PREFIX} Background'a ulaşılamadı:`, error?.message || error);
      if (isCurrent(result.videoId)) overlay.setStatus("error", "Eklentiye ulaşılamadı; sayfayı yenileyin.");
    }
  }

  // Çeviri sürerken ileri/geri sarılırsa o konumdaki parça öne alınır.
  overlay.onSeek = (time) => {
    const result = captionCache.get(lastVideoId);
    if (!result || result.translated || result.language.split("-")[0] === "tr") return;
    chrome.runtime.sendMessage({ type: "TRANSLATION_PRIORITY", videoId: result.videoId, time }).catch(() => {});
  };

  chrome.runtime.onMessage.addListener((message) => {
    // Kullanıcı başka videoya geçtiyse sonuç önbellekte kalır, geri dönünce gösterilir.
    const result = captionCache.get(message?.videoId);

    switch (message?.type) {
      case "TRANSLATION_CHUNK":
        if (!result) return;
        console.log(`${LOG_PREFIX} Çeviri ilerlemesi: ${message.done}/${message.total} parça`);
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
        console.error(`${LOG_PREFIX} Çeviri başarısız (${message.videoId}): ${message.error}`);
        // Hazır olan parçalar ekranda kalır.
        if (isCurrent(message.videoId)) overlay.setStatus("error", `Çeviri başarısız: ${message.error}`);
        break;
    }
  });

  async function notifyBackground(videoId) {
    try {
      await chrome.runtime.sendMessage({ type: "CONTENT_READY", videoId });
    } catch (error) {
      // Eklenti yeniden yüklendiğinde eski content script'in bağlantısı kopar.
      console.warn(`${LOG_PREFIX} Background'a ulaşılamadı:`, error?.message || error);
    }
  }

  async function processVideo(videoId) {
    const currentRun = ++runId;
    const isStale = () => currentRun !== runId;

    if (captionCache.has(videoId)) {
      const cached = captionCache.get(videoId);
      report(cached);
      requestTranslation(cached);
      return;
    }

    overlay.setStatus("loading", "Altyazı alınıyor…");
    try {
      const info = await getCaptionInfo(videoId);
      if (isStale()) return;

      const track = pickOriginalTrack(info);
      if (!track) {
        console.log(`${LOG_PREFIX} Bu videoda altyazı yok: ${videoId}`);
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
      requestTranslation(result);
    } catch (error) {
      if (isStale()) return;
      if (error instanceof TokenError) {
        tokenRetryVideoId = videoId;
        console.warn(
          `${LOG_PREFIX} Altyazı indirilemedi: ${error.message}. CC açılınca otomatik tekrar denenecek. (videoId=${videoId})`
        );
        overlay.setStatus("error", `Altyazı alınamadı: ${error.message}. CC'yi açınca tekrar denenecek.`);
        return;
      }
      console.error(`${LOG_PREFIX} Altyazı alınamadı:`, error);
      overlay.setStatus("error", `Altyazı alınamadı: ${error.message}`);
    }
  }

  // --- SPA gezinme takibi ---

  function checkPage() {
    if (location.pathname !== "/watch") {
      if (lastVideoId) overlay.clear();
      lastVideoId = null;
      runId++; // Devam eden işlemi iptal et.
      return;
    }

    const videoId = new URL(location.href).searchParams.get("v");
    if (!videoId || videoId === lastVideoId) return;

    lastVideoId = videoId;
    tokenRetryVideoId = null;
    overlay.clear();
    overlay.attach();
    console.log(`${LOG_PREFIX} İzleme sayfası algılandı: ${videoId}`);
    notifyBackground(videoId);
    processVideo(videoId);
  }

  // Art arda gelen olayları birleştirir; sürekli DOM değişiminde bile en geç gecikme kadar sonra çalışır.
  function scheduleCheck() {
    if (checkTimer) return;
    checkTimer = setTimeout(() => {
      checkTimer = null;
      checkPage();
    }, NAVIGATION_CHECK_DELAY_MS);
  }

  // YouTube'un kendi gezinme olayları.
  document.addEventListener("yt-navigate-finish", scheduleCheck);
  document.addEventListener("yt-page-data-updated", scheduleCheck);
  // Geri/ileri tuşları.
  window.addEventListener("popstate", scheduleCheck);
  // Yedek: başlık her video geçişinde değişir; olaylar kaçarsa DOM değişimi yakalar.
  new MutationObserver(scheduleCheck).observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  checkPage();
})();

// Sayfa köprüsü: MAIN world'de (YouTube'un kendi JS bağlamında) çalışır.
// Content script izole dünyada olduğu için oynatıcı API'sine ve sayfa değişkenlerine
// erişemez; bu dosya o erişimi sağlar ve sonuçları window.postMessage ile iletir.
//
// Görevleri:
// 1. Oynatıcının /api/timedtext isteklerini yakalamak. YouTube artık bu isteklerde
//    PO token (pot) ve istemci parametreleri istiyor; bunlar olmadan yanıt boş döner.
// 2. Güncel videonun captionTracks verisini oynatıcıdan okumak (SPA geçişlerinde de doğru).
// 3. İstendiğinde oynatıcıda altyazıyı açarak PO token'lı bir istek tetiklemek ve
//    ardından kullanıcının altyazı durumunu geri yüklemek.

(() => {
  if (window.__ytCeviriBridgeLoaded) return;
  window.__ytCeviriBridgeLoaded = true;

  const BRIDGE_SOURCE = "yt-ceviri-bridge";
  const CONTENT_SOURCE = "yt-ceviri-content";
  const PLAYER_POLL_MS = 250;
  const PLAYER_TIMEOUT_MS = 8000;
  const RESTORE_DELAY_MS = 1000;
  const CAPTURE_LIMIT = 20;
  const TRIGGER_POLL_MS = 250;
  const TRIGGER_TIMEOUT_MS = 5 * 60 * 1000; // Reklamın bitmesini bekleme sınırı (content.js ile aynı)
  const TRIGGER_ATTEMPTS = 6; // content.js ile aynı
  const TRIGGER_ATTEMPT_MS = 2500; // content.js ile aynı

  // Content script yüklenmeden önce yakalanan istekler kaybolmasın diye saklanır.
  const capturedUrls = new Map(); // videoId -> token'lı timedtext URL'si
  const triggersInFlight = new Map(); // videoId -> Promise (aynı video için tek tetikleme)

  function post(message) {
    window.postMessage({ source: BRIDGE_SOURCE, ...message }, location.origin);
  }

  function getPlayer() {
    return document.getElementById("movie_player");
  }

  function reportTimedtext(rawUrl) {
    if (!rawUrl.includes("/api/timedtext")) return;
    const url = new URL(rawUrl, location.origin);
    const videoId = url.searchParams.get("v");
    if (videoId && url.searchParams.has("pot")) {
      capturedUrls.delete(videoId);
      capturedUrls.set(videoId, url.toString());
      if (capturedUrls.size > CAPTURE_LIMIT) capturedUrls.delete(capturedUrls.keys().next().value);
    }
    post({ type: "TIMEDTEXT_URL", url: url.toString() });
  }

  // --- Ağ isteklerini dinle (yalnızca URL okunur, istek değiştirilmez) ---

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      reportTimedtext(String(input?.url ?? input));
    } catch {}
    return originalFetch.apply(this, arguments);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      reportTimedtext(String(url));
    } catch {}
    return originalOpen.apply(this, arguments);
  };

  // --- Oynatıcı verisi ---

  function readPlayerResponse(videoId) {
    const fromPlayer = getPlayer()?.getPlayerResponse?.();
    if (fromPlayer?.videoDetails?.videoId === videoId) return fromPlayer;

    // İlk yüklemede sayfa kaynağındaki obje; SPA geçişlerinden sonra eski videoya ait kalır.
    const initial = window.ytInitialPlayerResponse;
    if (initial?.videoDetails?.videoId === videoId) return initial;

    return null;
  }

  async function waitForPlayerResponse(videoId) {
    const deadline = Date.now() + PLAYER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = readPlayerResponse(videoId);
      if (response) {
        // Tüm player response yerine yalnızca gereken kısmı gönder.
        return {
          videoDetails: { videoId, title: response.videoDetails.title },
          captions: response.captions || null,
          timedtextUrl: capturedUrls.get(videoId) || null,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, PLAYER_POLL_MS));
    }
    return null;
  }

  // --- Altyazı tetikleme ---

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isCurrentVideo = (videoId) => new URL(location.href).searchParams.get("v") === videoId;

  // Reklam sürerken altyazı modülü ana videoya bağlı değildir; tetikleme boşa gider.
  // 1: oynatılıyor, 2: duraklatıldı, 3: arabelleğe alınıyor.
  function isMainContentActive(player) {
    if (player.classList.contains("ad-showing")) return false;
    return [1, 2, 3].includes(player.getPlayerState?.());
  }

  function readCaptionState(player) {
    const wasOn =
      player.isSubtitlesOn?.() ??
      document.querySelector(".ytp-subtitles-button")?.getAttribute("aria-pressed") === "true";
    return { wasOn, track: wasOn ? player.getOption?.("captions", "track") : null };
  }

  // Kullanıcının altyazı durumunu geri yükler. Boş iz seçmek altyazıyı kapatır;
  // unloadModule kalıcı değildir, oynatıcı altyazıyı birkaç saniye sonra yeniden açabiliyor.
  function restoreCaptionState(player, state) {
    if (state.wasOn && state.track?.languageCode) {
      player.setOption("captions", "track", state.track);
    } else {
      player.setOption("captions", "track", {});
    }
  }

  // Oynatıcı aynı izi tekrar seçince önbellekten okur ve istek yapmaz. Video yeni başladığında
  // ilk istek token henüz üretilmeden (pot olmadan) gidebiliyor. Bu yüzden iz önce kapatılıp
  // yeniden seçilir ve token'lı istek gelene kadar birkaç kez denenir.
  async function requestTokenFromPlayer(player, videoId, languageCode) {
    for (let attempt = 1; attempt <= TRIGGER_ATTEMPTS; attempt++) {
      player.loadModule?.("captions");
      player.setOption("captions", "track", {});
      player.setOption("captions", "track", { languageCode });

      const deadline = Date.now() + TRIGGER_ATTEMPT_MS;
      while (Date.now() < deadline) {
        if (capturedUrls.has(videoId)) return { ok: true, status: "triggered", attempts: attempt };
        if (!isCurrentVideo(videoId)) return { ok: false, reason: "navigated" };
        await sleep(TRIGGER_POLL_MS);
      }
    }
    return { ok: false, reason: "no-token", attempts: TRIGGER_ATTEMPTS };
  }

  // Ana video oynamaya başlayana kadar bekler, sonra token'lı isteği tetikler.
  async function triggerCaptionsWhenReady(videoId, languageCode) {
    const deadline = Date.now() + TRIGGER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // Oynatıcı altyazıyı kendisi token'la çektiyse tetiklemeye gerek yok.
      if (capturedUrls.has(videoId)) return { ok: true, status: "captured" };
      if (!isCurrentVideo(videoId)) return { ok: false, reason: "navigated" };

      const player = getPlayer();
      if (player?.setOption && isMainContentActive(player)) {
        const state = readCaptionState(player);
        try {
          return await requestTokenFromPlayer(player, videoId, languageCode);
        } finally {
          // Oynatıcı altyazı yüklemesini bitirsin diye kısa bir süre sonra geri yüklenir.
          setTimeout(() => restoreCaptionState(player, state), RESTORE_DELAY_MS);
        }
      }
      await sleep(TRIGGER_POLL_MS);
    }
    return { ok: false, reason: "timeout" };
  }

  function triggerOnce(videoId, languageCode) {
    if (!triggersInFlight.has(videoId)) {
      const promise = triggerCaptionsWhenReady(videoId, languageCode).finally(() => triggersInFlight.delete(videoId));
      triggersInFlight.set(videoId, promise);
    }
    return triggersInFlight.get(videoId);
  }

  // --- Content script mesajları ---

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== CONTENT_SOURCE) return;
    const { type, id } = event.data;

    switch (type) {
      case "GET_PLAYER_RESPONSE":
        post({ type: "RESPONSE", id, data: await waitForPlayerResponse(event.data.videoId) });
        break;

      case "TRIGGER_CAPTIONS":
        post({
          type: "RESPONSE",
          id,
          data: await triggerOnce(event.data.videoId, event.data.languageCode),
        });
        break;

      case "EXPOSE_CAPTIONS":
        // Konsoldan test için: ytCeviri.captions
        window.ytCeviri = event.data.result;
        break;
    }
  });
})();

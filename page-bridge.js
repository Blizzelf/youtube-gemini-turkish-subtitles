// Page bridge: runs in the MAIN world (YouTube's own JS context).
// The content script lives in an isolated world and cannot reach the player API or page
// variables; this file provides that access and passes results on with window.postMessage.
//
// Responsibilities:
// 1. Capture the player's /api/timedtext requests. YouTube now requires a PO token (pot)
//    and client parameters on these requests; without them the response is empty.
// 2. Read the current video's captionTracks from the player (correct after SPA navigation too).
// 3. On request, turn captions on in the player to trigger a PO-token request, then restore
//    the user's caption state.

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
  const TRIGGER_TIMEOUT_MS = 5 * 60 * 1000; // Limit for waiting out an ad (same as content.js)
  const TRIGGER_ATTEMPTS = 6; // Same as content.js
  const TRIGGER_ATTEMPT_MS = 2500; // Same as content.js

  // Kept so requests captured before the content script loads are not lost.
  const capturedUrls = new Map(); // videoId -> token-bearing timedtext URL
  const triggersInFlight = new Map(); // videoId -> Promise (one trigger per video)

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

  // --- Network observation (only the URL is read; requests are not modified) ---

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

  // --- Player data ---

  function readPlayerResponse(videoId) {
    const fromPlayer = getPlayer()?.getPlayerResponse?.();
    if (fromPlayer?.videoDetails?.videoId === videoId) return fromPlayer;

    // The object from the page source on first load; after SPA navigation it still belongs
    // to the old video.
    const initial = window.ytInitialPlayerResponse;
    if (initial?.videoDetails?.videoId === videoId) return initial;

    return null;
  }

  async function waitForPlayerResponse(videoId) {
    const deadline = Date.now() + PLAYER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = readPlayerResponse(videoId);
      if (response) {
        // Send only the needed part instead of the whole player response.
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

  // --- Triggering captions ---

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isCurrentVideo = (videoId) => new URL(location.href).searchParams.get("v") === videoId;

  // While an ad plays, the captions module is not attached to the main video and a trigger
  // has no effect. 1: playing, 2: paused, 3: buffering.
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

  // Restores the user's caption state. Selecting an empty track turns captions off;
  // unloadModule is not permanent, the player can turn captions back on a few seconds later.
  function restoreCaptionState(player, state) {
    if (state.wasOn && state.track?.languageCode) {
      player.setOption("captions", "track", state.track);
    } else {
      player.setOption("captions", "track", {});
    }
  }

  // Re-selecting the same track makes the player read from its cache without a request.
  // Right after a video starts, the first request may go out before the token exists
  // (without pot). So the track is first cleared and then re-selected, a few times, until a
  // token-bearing request arrives.
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

  // Waits until the main video plays, then triggers a token-bearing request.
  async function triggerCaptionsWhenReady(videoId, languageCode) {
    const deadline = Date.now() + TRIGGER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // If the player already fetched captions with a token, no trigger is needed.
      if (capturedUrls.has(videoId)) return { ok: true, status: "captured" };
      if (!isCurrentVideo(videoId)) return { ok: false, reason: "navigated" };

      const player = getPlayer();
      if (player?.setOption && isMainContentActive(player)) {
        const state = readCaptionState(player);
        try {
          return await requestTokenFromPlayer(player, videoId, languageCode);
        } finally {
          // Restored after a short delay so the player can finish loading captions.
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

  // --- Content script messages ---

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
        // For testing from the console: ytCeviri.captions
        window.ytCeviri = event.data.result;
        break;
    }
  });
})();

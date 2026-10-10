// Mocked tests for background.js: batching, request queue, 429 retries, cache, export/import.
// The chrome APIs and Gemini are faked; no real requests are made.
// Run: npm test  (or node tests/background.test.js)
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const INTERVAL_MS = 40;
const SLOW_INTERVAL_MS = 80;

// Shortens the timing constants so the tests run in milliseconds.
function patched({ cacheMaxBytes } = {}) {
  let src = SOURCE.replace("MIN_REQUEST_INTERVAL_MS = 500", `MIN_REQUEST_INTERVAL_MS = ${INTERVAL_MS}`)
    .replace("SLOW_REQUEST_INTERVAL_MS = 2500", `SLOW_REQUEST_INTERVAL_MS = ${SLOW_INTERVAL_MS}`)
    .replace("BACKOFF_BASE_MS = 4000", "BACKOFF_BASE_MS = 20")
    .replace("BACKOFF_MAX_MS = 60000", "BACKOFF_MAX_MS = 100")
    .replace("BACKOFF_JITTER_MS = 1000", "BACKOFF_JITTER_MS = 0");
  if (cacheMaxBytes) src = src.replace("CACHE_MAX_BYTES = 8 * 1024 * 1024", `CACHE_MAX_BYTES = ${cacheMaxBytes}`);
  const originals = { MIN_REQUEST_INTERVAL_MS: 500, SLOW_REQUEST_INTERVAL_MS: 2500, BACKOFF_BASE_MS: 4000, BACKOFF_JITTER_MS: 1000 };
  for (const [name, value] of Object.entries(originals)) {
    assert.ok(!src.includes(`${name} = ${value};`), `${name} not patched`);
  }
  return src;
}

function makeStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) if (key in data) out[key] = structuredClone(data[key]);
      return out;
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) data[key] = structuredClone(value);
    },
    async remove(keys) {
      for (const key of [].concat(keys)) delete data[key];
    },
  };
}

// Fake Gemini: returns the incoming lines prefixed with "TR ". behavior(callIndex, chunk) can
// return a custom response.
function makeGemini(behavior = () => null, { latencyMs = 5 } = {}) {
  const state = { calls: [], inFlight: 0, maxInFlight: 0 };
  state.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const parts = body.contents[0].parts;
    const chunk = JSON.parse(parts[parts.length - 1].text);
    const call = { at: Date.now(), chunk, headers: init.headers, url, body };
    state.calls.push(call);
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((r) => setTimeout(r, latencyMs));
    state.inFlight--;
    const custom = behavior(state.calls.length, chunk);
    if (custom) return custom;
    const items = chunk.map((c) => ({ ...c, text: `TR ${c.text}` }));
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(items) }] } }] }),
    };
  };
  return state;
}

function makeContext({ gemini, storage = makeStorage({ geminiApiKey: "AIzaTESTKEY" }), session = makeStorage(), cacheMaxBytes } = {}) {
  const sent = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, TextEncoder, structuredClone,
    fetch: gemini.fetch,
    chrome: {
      runtime: {
        id: "ext",
        onInstalled: { addListener() {} },
        onMessage: { addListener(fn) { ctx.__listener = fn; } },
        getManifest: () => ({ version: "0.1.0" }),
        getPlatformInfo: async () => ({}),
      },
      storage: { local: storage, session },
      tabs: { sendMessage: async (tabId, message) => { sent.push(JSON.parse(JSON.stringify(message))); } },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(patched({ cacheMaxBytes }), ctx);
  const send = (message, tabId = 7) =>
    new Promise((resolve) => ctx.__listener(message, { id: "ext", tab: { id: tabId }, frameId: 0 }, (r) => resolve(JSON.parse(JSON.stringify(r)))));
  return { ctx, sent, storage, session, send };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

const cues = (n, { step = 2, text = (i) => `line ${i}` } = {}) =>
  Array.from({ length: n }, (_, i) => ({ start: i * step, duration: 1.5, text: text(i) }));
const translate = (videoId, captions, extra = {}) => ({ type: "TRANSLATE", videoId, title: "T", language: "en", captions, ...extra });
const types = (sent) => sent.map((m) => m.type);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("batching: 100 lines -> 10/40/40/10 (small first chunk at the playback position)", async () => {
  const gemini = makeGemini();
  const { sent, send } = makeContext({ gemini });
  const ack = await send(translate("v1", cues(100)));
  assert.strictEqual(ack.status, "started");
  assert.deepStrictEqual([ack.done, ack.total], [0, 4]);
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));

  assert.deepStrictEqual(gemini.calls.map((c) => c.chunk.length), [10, 40, 40, 10]);
  assert.ok(gemini.calls[0].url.includes("gemini-3.8-flash:generateContent"));
  assert.strictEqual(gemini.calls[0].headers["x-goog-api-key"], "AIzaTESTKEY");
});

test("parallel: at most 3 requests in flight, starts spaced by the interval", async () => {
  const gemini = makeGemini(undefined, { latencyMs: 150 });
  const { sent, send } = makeContext({ gemini });
  await send(translate("v1", cues(200)));
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));

  assert.strictEqual(gemini.calls.length, 6); // 10, 40, 40, 40, 40, 30 lines
  assert.strictEqual(gemini.maxInFlight, 3);
  // The gap is kept between slot grants; fetch is called a moment later, hence 2 ms of slack.
  for (let i = 1; i < gemini.calls.length; i++) {
    assert.ok(gemini.calls[i].at - gemini.calls[i - 1].at >= INTERVAL_MS - 2, `start gap: ${gemini.calls[i].at - gemini.calls[i - 1].at} ms`);
  }
  assert.strictEqual(sent.at(-1).texts.filter((t) => t === null).length, 0);
});

test("first chunk: 10 lines starting at the line playing now", async () => {
  const gemini = makeGemini();
  const { sent, send } = makeContext({ gemini });
  // Lines start every 2 s; at 100.5 s line 50 (100-101.5 s) is playing.
  const ack = await send(translate("v1", cues(100), { currentTime: 100.5 }));
  assert.deepStrictEqual([ack.done, ack.total], [0, 4]);
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  assert.deepStrictEqual(gemini.calls.map((c) => [c.chunk[0].text, c.chunk.length]), [["line 50", 10], ["line 60", 40], ["line 0", 40], ["line 40", 10]]);
});

test("batching: long lines are split by the character limit", async () => {
  const gemini = makeGemini();
  const { sent, send } = makeContext({ gemini });
  await send(translate("v1", cues(10, { text: (i) => `${i} ${"x".repeat(1000)}` })));
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  assert.deepStrictEqual(gemini.calls.map((c) => c.chunk.length), [5, 5]);
});

test("progressive delivery: CHUNK messages in order, then RESULT; no timestamps sent", async () => {
  const gemini = makeGemini();
  const { sent, send } = makeContext({ gemini });
  await send(translate("v1", cues(100)));
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  assert.deepStrictEqual(types(sent), ["TRANSLATION_CHUNK", "TRANSLATION_CHUNK", "TRANSLATION_CHUNK", "TRANSLATION_CHUNK", "TRANSLATION_RESULT"]);
  assert.deepStrictEqual(sent.slice(0, 4).map((m) => [m.startIndex, m.done, m.total, m.texts.length]), [[0, 1, 4, 10], [10, 2, 4, 40], [50, 3, 4, 40], [90, 4, 4, 10]]);
  const result = sent[4];
  assert.strictEqual(result.videoId, "v1");
  assert.strictEqual(result.texts.length, 100);
  assert.strictEqual(result.texts[99], "TR line 99");
});

test("cache: the same video requested again does not call the API", async () => {
  const gemini = makeGemini();
  const { sent, send, storage } = makeContext({ gemini });
  await send(translate("v1", cues(50)));
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  const callsAfterFirst = gemini.calls.length;
  assert.strictEqual(storage.data["translation:v1"].complete, true);

  const ack = await send(translate("v1", cues(50)));
  assert.strictEqual(ack.status, "cached");
  assert.strictEqual(ack.texts[49], "TR line 49");
  assert.strictEqual(gemini.calls.length, callsAfterFirst);
});

test("cache: a complete translation loads even without an API key", async () => {
  const gemini = makeGemini();
  const storage = makeStorage({ geminiApiKey: "k" });
  const first = makeContext({ gemini, storage });
  await first.send(translate("v1", cues(10)));
  await waitFor(() => first.sent.some((m) => m.type === "TRANSLATION_RESULT"));
  delete storage.data.geminiApiKey;
  const second = makeContext({ gemini, storage });
  const ack = await second.send(translate("v1", cues(10)));
  assert.strictEqual(ack.status, "cached");
  const noCache = await second.send(translate("v2", cues(10)));
  assert.strictEqual(noCache.ok, false);
  assert.ok(noCache.error.includes("API anahtarı")); // Turkish user-facing message
});

test("cache: changed captions do not reuse the old translation", async () => {
  const gemini = makeGemini();
  const { sent, send } = makeContext({ gemini });
  await send(translate("v1", cues(10)));
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  const ack = await send(translate("v1", cues(10, { text: (i) => `changed ${i}` })));
  assert.strictEqual(ack.status, "started");
});

test("cacheOnly: a cached translation loads, an uncached video does not call the API", async () => {
  const gemini = makeGemini();
  const { sent, send } = makeContext({ gemini });
  const missing = await send(translate("v1", cues(10), { cacheOnly: true }));
  assert.deepStrictEqual([missing.ok, missing.status], [true, "not-cached"]);
  assert.strictEqual(gemini.calls.length, 0);

  await send(translate("v1", cues(10)));
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  const calls = gemini.calls.length;
  const cached = await send(translate("v1", cues(10), { cacheOnly: true }));
  assert.strictEqual(cached.status, "cached");
  const changed = await send(translate("v1", cues(10, { text: (i) => `changed ${i}` }), { cacheOnly: true }));
  assert.strictEqual(changed.status, "not-cached");
  assert.strictEqual(gemini.calls.length, calls);
});

test("cacheOnly: joins a translation that is already running", async () => {
  const gemini = makeGemini();
  const { sent, send } = makeContext({ gemini });
  await send(translate("v1", cues(100)));
  const ack = await send(translate("v1", cues(100), { cacheOnly: true }));
  assert.strictEqual(ack.status, "pending");
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
});

test("HAS_TRANSLATION: true for complete or running translations only", async () => {
  let failSecond = true;
  const gemini = makeGemini((call) =>
    failSecond && call === 2 ? { ok: false, status: 400, json: async () => ({ error: { message: "Bad request" } }) } : null
  );
  const { sent, send, storage } = makeContext({ gemini });
  const has = async (videoId) => (await send({ type: "HAS_TRANSLATION", videoId })).available;
  assert.strictEqual(await has("v1"), false);

  await send(translate("v1", cues(100)));
  assert.strictEqual(await has("v1"), true, "running job");
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_ERROR"));
  assert.strictEqual(await has("v1"), false, "partial translation");

  failSecond = false;
  await send(translate("v1", cues(100)));
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  assert.strictEqual(await has("v1"), true, "complete translation");
  storage.data["translation:v1"].version = 0;
  assert.strictEqual(await has("v1"), false, "old cache version");
  assert.strictEqual(await has(""), false);
});

test("429: waits for RetryInfo, sends STATUS, retries the chunk", async () => {
  const gemini = makeGemini((call) =>
    call === 1
      ? {
          ok: false,
          status: 429,
          json: async () => ({ error: { message: "Resource exhausted", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.15s" }] } }),
        }
      : null
  );
  const { sent, send } = makeContext({ gemini });
  await send(translate("v1", cues(10)));
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  assert.strictEqual(gemini.calls.length, 2);
  assert.ok(gemini.calls[1].at - gemini.calls[0].at >= 150, `wait: ${gemini.calls[1].at - gemini.calls[0].at} ms`);
  assert.deepStrictEqual(types(sent), ["TRANSLATION_STATUS", "TRANSLATION_CHUNK", "TRANSLATION_RESULT"]);
  assert.ok(sent[0].message.includes("429"));
});

test("429: the delay grows exponentially on repeated errors", async () => {
  const rateLimited = { ok: false, status: 429, json: async () => ({ error: { message: "Too many requests" } }) };
  const gemini = makeGemini((call) => (call <= 3 ? rateLimited : null));
  const { sent, send } = makeContext({ gemini });
  await send(translate("v1", cues(5)));
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  const gaps = gemini.calls.slice(1).map((c, i) => c.at - gemini.calls[i].at);
  // Base 20 ms: 20, 40, 80 (at least that much, together with the 40 ms queue gap)
  assert.ok(gaps[0] >= 20 && gaps[1] >= 40 && gaps[2] >= 80, gaps.join(","));
  assert.ok(gaps[2] > gaps[0], gaps.join(","));
});

test("429: the queue keeps the slower gap after a rate limit", async () => {
  const gemini = makeGemini((call) =>
    call === 1 ? { ok: false, status: 429, json: async () => ({ error: { message: "Too many requests" } }) } : null
  );
  const { sent, send } = makeContext({ gemini });
  await send(translate("v1", cues(100)));
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  assert.strictEqual(gemini.calls.length, 5);
  const gaps = gemini.calls.slice(2).map((c, i) => c.at - gemini.calls[i + 1].at);
  assert.ok(gaps.every((gap) => gap >= SLOW_INTERVAL_MS), gaps.join(","));
});

test("429: one request at a time afterwards, remembered across worker restarts", async () => {
  const rateLimited = { ok: false, status: 429, json: async () => ({ error: { message: "Too many requests" } }) };
  const first = makeContext({ gemini: makeGemini((call) => (call === 1 ? rateLimited : null)) });
  await first.send(translate("v1", cues(10)));
  await waitFor(() => first.sent.some((m) => m.type === "TRANSLATION_RESULT"));
  assert.strictEqual(first.session.data.rateLimited, true);

  const gemini = makeGemini(undefined, { latencyMs: 60 });
  const second = makeContext({ gemini, session: first.session });
  await new Promise((r) => setTimeout(r, 5)); // Let the stored flag load.
  await second.send(translate("v2", cues(200)));
  await waitFor(() => second.sent.some((m) => m.type === "TRANSLATION_RESULT"));
  assert.strictEqual(gemini.maxInFlight, 1);
});

test("daily quota: not retried, error message explains it", async () => {
  const gemini = makeGemini(() => ({
    ok: false,
    status: 429,
    json: async () => ({
      error: {
        message: "Quota exceeded",
        details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }],
      },
    }),
  }));
  const { sent, send } = makeContext({ gemini });
  await send(translate("v1", cues(5)));
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_ERROR"));
  assert.strictEqual(gemini.calls.length, 1);
  assert.ok(sent.at(-1).error.includes("günlük kotası")); // Turkish user-facing message
});

test("an interrupted translation is saved and resumes where it stopped", async () => {
  let failSecond = true;
  const gemini = makeGemini((call) =>
    failSecond && call === 2 ? { ok: false, status: 400, json: async () => ({ error: { message: "Bad request" } }) } : null
  );
  const storage = makeStorage({ geminiApiKey: "k" });
  const first = makeContext({ gemini, storage });
  await first.send(translate("v1", cues(100)));
  await waitFor(() => first.sent.some((m) => m.type === "TRANSLATION_ERROR"));
  assert.strictEqual(first.sent.at(-1).partial, true);
  assert.strictEqual(gemini.calls.length, 2, "the queued third chunk must not be sent after the error");
  const entry = storage.data["translation:v1"];
  assert.strictEqual(entry.complete, false);
  assert.strictEqual(entry.texts.filter((t) => t !== null).length, 10);

  failSecond = false;
  const callsBefore = gemini.calls.length;
  const second = makeContext({ gemini, storage });
  // Resumed at 160 s (line 80). Lines 0-9 form their own done chunk and are not sent again:
  // chunks 0-9 (done), 10-49, 50-79, 80-89 (small, playback position), 90-99.
  const ack = await second.send(translate("v1", cues(100), { currentTime: 160 }));
  assert.strictEqual(ack.status, "resumed");
  assert.deepStrictEqual([ack.done, ack.total], [1, 5]);
  assert.strictEqual(ack.texts.filter((t) => t !== null).length, 10);
  await waitFor(() => second.sent.some((m) => m.type === "TRANSLATION_RESULT"));
  assert.deepStrictEqual(gemini.calls.slice(callsBefore).map((c) => c.chunk[0].text), ["line 80", "line 90", "line 10", "line 50"]);
  assert.strictEqual(storage.data["translation:v1"].complete, true);
});

test("priority: the chunk at the playback position goes first; seeking moves the new position up", async () => {
  const gemini = makeGemini(undefined, { latencyMs: 100 });
  const { sent, send } = makeContext({ gemini });
  // 320 lines, 2 s apart. Chunks start at 0, 80, 100 (10 lines, the playback position), 120,
  // 200, ... s; the three from 100 s are claimed at once. The seek to 500 s splits the waiting
  // chunks again: 500 s gets a 10-line chunk and goes next, the claimed ones stay as they are.
  await send(translate("v1", cues(320), { currentTime: 100 }));
  await waitFor(() => gemini.calls.length >= 1);
  await send({ type: "TRANSLATION_PRIORITY", videoId: "v1", time: 500 });
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  assert.deepStrictEqual(
    gemini.calls.map((c) => [c.chunk[0].start, c.chunk.length]),
    [[100, 10], [120, 40], [200, 40], [500, 10], [520, 40], [600, 20], [0, 40], [80, 10], [280, 40], [360, 40], [440, 30]]
  );
  assert.strictEqual(sent.at(-1).texts.filter((t) => t === null).length, 0);
});

test("priority: seeking into a chunk being translated starts small right after it, no line twice", async () => {
  const gemini = makeGemini(undefined, { latencyMs: 100 });
  const { sent, send } = makeContext({ gemini });
  // Claimed at once: lines 0-9, 10-49 and 50-89. 40 s is line 20, already being translated.
  await send(translate("v1", cues(320)));
  await waitFor(() => gemini.calls.length >= 1);
  await send({ type: "TRANSLATION_PRIORITY", videoId: "v1", time: 40 });
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  assert.deepStrictEqual([gemini.calls[3].chunk[0].text, gemini.calls[3].chunk.length], ["line 90", 10]);
  const sentLines = gemini.calls.flatMap((c) => c.chunk.map((cue) => cue.text));
  assert.strictEqual(new Set(sentLines).size, sentLines.length, "a line was sent twice");
  assert.strictEqual(sentLines.length, 320);
});

test("priority: a repeated request for a running job also moves its position up", async () => {
  const gemini = makeGemini(undefined, { latencyMs: 100 });
  const { sent, send } = makeContext({ gemini });
  await send(translate("v1", cues(320)));
  await waitFor(() => gemini.calls.length >= 1);
  const ack = await send(translate("v1", cues(320), { currentTime: 500 }));
  assert.strictEqual(ack.status, "pending");
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  assert.deepStrictEqual([gemini.calls[3].chunk[0].start, gemini.calls[3].chunk.length], [500, 10]);
});

test("the same video requested from two tabs runs one job and both tabs get the result", async () => {
  const gemini = makeGemini();
  const { sent, send } = makeContext({ gemini });
  const [a, b] = await Promise.all([send(translate("v1", cues(50)), 1), send(translate("v1", cues(50)), 2)]);
  assert.deepStrictEqual([a.status, b.status].sort(), ["pending", "started"]);
  await waitFor(() => sent.filter((m) => m.type === "TRANSLATION_RESULT").length === 2);
  assert.strictEqual(gemini.calls.length, 2);
});

test("format errors: missing line -> chunk is split; broken timestamp -> that line keeps its original", async () => {
  const gemini = makeGemini((call, chunk) => {
    const items = chunk.map((c) => ({ ...c, text: `TR ${c.text}`, start: c.start === 4 ? 999 : c.start }));
    const out = call === 1 ? items.slice(0, -1) : items;
    return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(out) }] } }] }) };
  });
  const { sent, send } = makeContext({ gemini });
  await send(translate("v1", cues(4)));
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  assert.deepStrictEqual(sent.at(-1).texts, ["TR line 0", "TR line 1", "line 2", "TR line 3"]);
});

test("LRU: the oldest video is removed when the cache budget is exceeded", async () => {
  const gemini = makeGemini();
  const storage = makeStorage({ geminiApiKey: "k" });
  const { sent, send } = makeContext({ gemini, storage, cacheMaxBytes: 800 });
  for (const id of ["a", "b", "c"]) {
    await send(translate(id, cues(20)));
    await waitFor(() => sent.filter((m) => m.type === "TRANSLATION_RESULT").length === ["a", "b", "c"].indexOf(id) + 1);
    await new Promise((r) => setTimeout(r, 5));
  }
  const kept = Object.keys(storage.data).filter((k) => k.startsWith("translation:")).sort();
  assert.ok(!kept.includes("translation:a"), kept.join(","));
  assert.ok(kept.includes("translation:c"), kept.join(","));
  assert.deepStrictEqual(Object.keys(storage.data.translationIndex).sort(), kept.map((k) => k.slice(12)));
});

test("popup: cache stats and clearing (API key kept, entries missing from the index removed)", async () => {
  const gemini = makeGemini();
  const storage = makeStorage({ geminiApiKey: "k", "translation:orphan": { version: 1 } });
  const { sent, send } = makeContext({ gemini, storage });
  for (const id of ["a", "b"]) {
    await send(translate(id, cues(10)));
    await waitFor(() => sent.filter((m) => m.type === "TRANSLATION_RESULT").length === ["a", "b"].indexOf(id) + 1);
  }
  await new Promise((r) => setTimeout(r, 10));

  const stats = await send({ type: "GET_CACHE_STATS" });
  assert.strictEqual(stats.count, 2);
  assert.ok(stats.bytes > 0);
  assert.strictEqual(stats.activeJobs, 0);

  const cleared = await send({ type: "CLEAR_TRANSLATION_CACHE" });
  assert.strictEqual(cleared.ok, true);
  assert.strictEqual(cleared.removed, 3); // a, b and the entry missing from the index
  assert.strictEqual(cleared.bytes, stats.bytes);
  assert.deepStrictEqual(Object.keys(storage.data), ["geminiApiKey"]); // the API key is not removed

  assert.strictEqual((await send({ type: "GET_CACHE_STATS" })).count, 0);
  const callsBefore = gemini.calls.length;
  const ack = await send(translate("a", cues(10)));
  assert.strictEqual(ack.status, "started");
  await waitFor(() => gemini.calls.length > callsBefore);
});

test("export/import: a video translated in Chrome loads in Edge without calling the API", async () => {
  const chromeGemini = makeGemini();
  const chromeSide = makeContext({ gemini: chromeGemini });
  for (const id of ["videoAAAAAA1", "videoBBBBBB2"]) {
    await chromeSide.send(translate(id, cues(30)));
    await waitFor(() => chromeSide.sent.filter((m) => m.type === "TRANSLATION_RESULT").length === (id.endsWith("1") ? 1 : 2));
  }
  await new Promise((r) => setTimeout(r, 10));
  const exported = await chromeSide.send({ type: "EXPORT_TRANSLATION_CACHE" });
  assert.strictEqual(exported.count, 2);
  assert.strictEqual(exported.data.format, "yt-ceviri-cache");
  const file = JSON.parse(JSON.stringify(exported.data)); // as if written to a file and read back

  const edgeGemini = makeGemini();
  const edgeSide = makeContext({ gemini: edgeGemini, storage: makeStorage({}) }); // no API key in Edge
  const imported = await edgeSide.send({ type: "IMPORT_TRANSLATION_CACHE", data: file });
  assert.deepStrictEqual(
    [imported.imported, imported.existing, imported.incompatible, imported.invalid, imported.evicted],
    [2, 0, 0, 0, 0]
  );
  assert.strictEqual((await edgeSide.send({ type: "GET_CACHE_STATS" })).count, 2);
  const ack = await edgeSide.send(translate("videoAAAAAA1", cues(30)));
  assert.strictEqual(ack.status, "cached");
  assert.strictEqual(ack.texts[29], "TR line 29");
  assert.strictEqual(edgeGemini.calls.length, 0);

  // Importing the same file again finds the entries already present.
  const again = await edgeSide.send({ type: "IMPORT_TRANSLATION_CACHE", data: file });
  assert.deepStrictEqual([again.imported, again.existing], [0, 2]);
});

test("import: malformed, incompatible and partial entries are handled correctly", async () => {
  const gemini = makeGemini();
  const { send, sent, storage } = makeContext({ gemini });
  // A video that is fully translated locally
  await send(translate("localFull01", cues(10)));
  await waitFor(() => sent.some((m) => m.type === "TRANSLATION_RESULT"));
  await new Promise((r) => setTimeout(r, 10));
  const localHash = storage.data["translation:localFull01"].hash;

  const base = { version: 1, model: "gemini-3.8-flash", complete: false, updatedAt: Date.now() };
  const exportedHash = (await send({ type: "EXPORT_TRANSLATION_CACHE" })).data.entries.localFull01.hash;
  assert.strictEqual(exportedHash, localHash);
  const file = {
    format: "yt-ceviri-cache",
    version: 1,
    entries: {
      "bad id!": { ...base, hash: "x", texts: ["a"] }, // invalid videoId
      noTexts0001: { ...base, hash: "x", texts: "nope" }, // malformed
      oldModel001: { ...base, model: "gemini-2.5-flash", hash: "x", texts: ["a"] }, // incompatible
      localFull01: { ...base, hash: localHash, texts: new Array(10).fill(null) }, // the complete local entry is kept
      partial0001: { ...base, hash: "abc", texts: ["TR a", null] }, // a partial entry is added
    },
  };
  const result = await send({ type: "IMPORT_TRANSLATION_CACHE", data: file });
  assert.deepStrictEqual(
    [result.imported, result.existing, result.incompatible, result.invalid],
    [1, 1, 1, 2]
  );
  assert.strictEqual(storage.data["translation:localFull01"].complete, true);
  assert.strictEqual(storage.data["translation:partial0001"].complete, false);

  const wrong = await send({ type: "IMPORT_TRANSLATION_CACHE", data: { hello: "world" } });
  assert.strictEqual(wrong.ok, false);
  assert.ok(wrong.error.includes("dışa aktarma dosyası değil")); // Turkish user-facing message
});

test("import: the oldest entries are removed when the cache budget is exceeded", async () => {
  const gemini = makeGemini();
  const { send } = makeContext({ gemini, storage: makeStorage({}), cacheMaxBytes: 800 });
  const entries = {};
  for (let i = 0; i < 5; i++) {
    entries[`video00000${i}`] = {
      version: 1,
      model: "gemini-3.8-flash",
      hash: `h${i}`,
      texts: Array.from({ length: 10 }, (_, j) => `TR line ${j}`),
      complete: true,
      updatedAt: 1000 + i,
    };
  }
  const result = await send({ type: "IMPORT_TRANSLATION_CACHE", data: { format: "yt-ceviri-cache", version: 1, entries } });
  assert.strictEqual(result.imported, 5);
  assert.ok(result.evicted > 0);
  const stats = await send({ type: "GET_CACHE_STATS" });
  assert.strictEqual(stats.count, 5 - result.evicted);
  assert.ok(stats.bytes <= 800);
});

test("invalid data is rejected", async () => {
  const { send } = makeContext({ gemini: makeGemini() });
  const ack = await send(translate("v1", [{ start: "0", duration: 1, text: "a" }]));
  assert.strictEqual(ack.ok, false);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`OK   ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${name}\n     ${error.message}`);
    }
  }
  console.log(failed ? `${failed} TESTS FAILED` : "ALL TESTS PASSED");
  process.exit(failed ? 1 : 0);
})();

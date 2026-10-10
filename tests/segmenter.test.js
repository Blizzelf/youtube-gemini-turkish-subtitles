// Unit tests for segmenter.js (synthetic json3 data).
// Run: npm test  (or node tests/segmenter.test.js)
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "segmenter.js"), "utf8");
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${SOURCE}\nglobalThis.buildAsrCues = buildAsrCues;`, ctx);
const build = (data) => JSON.parse(JSON.stringify(ctx.buildAsrCues(data)));

// ASR-like json3: every line is one event, words carry tOffsetMs.
function asr(lines) {
  const events = [{ tStartMs: 0, dDurationMs: 999999, id: 1 }];
  for (const [startMs, text, step = 350] of lines) {
    const tokens = text.split(" ");
    events.push({
      tStartMs: startMs,
      dDurationMs: 6000,
      wWinId: 1,
      segs: tokens.map((t, i) => ({ utf8: (i ? " " : "") + t, ...(i ? { tOffsetMs: i * step } : {}) })),
    });
    events.push({ tStartMs: startMs + tokens.length * step, aAppend: 1, wWinId: 1, segs: [{ utf8: "\n" }] });
  }
  return { events };
}

const allWords = (cues) => cues.map((c) => c.text).join(" ").split(/\s+/);
const noOverlap = (cues) => cues.every((c, i) => !cues[i + 1] || c.start + c.duration <= cues[i + 1].start + 1e-9);

// 1) Sentences that end mid-line are joined.
{
  const data = asr([
    [0, "Hey everybody, it's Rob here. I'm"],
    [2100, "getting asked a ton of questions."],
    [4500, "So let's start."],
  ]);
  const cues = build(data);
  assert.deepStrictEqual(cues.map((c) => c.text), [
    "Hey everybody, it's Rob here.",
    "I'm getting asked a ton of questions.",
    "So let's start.",
  ]);
  assert.ok(noOverlap(cues));
  assert.strictEqual(cues[1].start, 1.75); // Start of the word "I'm": 0 + 5 * 0.35
  console.log("OK 1: sentences joined regardless of line breaks");
}

// 2) Without punctuation, text is split at pauses.
{
  const data = asr([
    [0, "this is a sentence without any punctuation"],
    [5000, "and here comes another one after a long pause"],
  ]);
  const cues = build(data);
  assert.strictEqual(cues.length, 2);
  assert.ok(cues[0].text.startsWith("this is") && cues[1].text.startsWith("and here"));
  console.log("OK 2: unpunctuated text split at the pause");
}

// 3) A sentence too long for the screen is split evenly, no word is lost, no cut after an article.
{
  const long =
    "I'm getting asked a ton of questions how some people on the leaderboards are getting the most insane items and a kind of new crafting meta that people have been using on the rune words.";
  const tokens = long.split(" ");
  const lines = [];
  for (let i = 0; i < tokens.length; i += 8) lines.push([i * 300, tokens.slice(i, i + 8).join(" "), 300]);
  const cues = build(asr(lines));
  assert.ok(cues.length >= 2 && cues.length <= 3, `part count: ${cues.length}`);
  assert.ok(cues.every((c) => c.text.length <= 108), cues.map((c) => c.text.length).join(","));
  assert.deepStrictEqual(allWords(cues), long.split(" "));
  assert.ok(cues.every((c) => !/\b(the|a|of|on)$/i.test(c.text)), cues.map((c) => c.text).join(" | "));
  assert.ok(noOverlap(cues));
  console.log("OK 3:", cues.map((c) => c.text).join(" | "));
}

// 4) The [Music] tag is its own subtitle and lasts for the whole line.
{
  const data = { events: [
    { tStartMs: 320, dDurationMs: 14260, segs: [{ utf8: "[Music]" }] },
    { tStartMs: 18800, dDurationMs: 7160, segs: [{ utf8: "We're" }, { utf8: " no", tOffsetMs: 239 }, { utf8: " strangers", tOffsetMs: 559 }] },
  ] };
  const cues = build(data);
  assert.strictEqual(cues[0].text, "[Music]");
  assert.ok(cues[0].duration > 14, String(cues[0].duration));
  assert.strictEqual(cues[1].text, "We're no strangers");
  console.log("OK 4: [Music] separate and long-lasting");
}

// 5) Scripts without spaces, such as Japanese, get no space between lines.
{
  const data = { events: [
    { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: "今日は" }, { utf8: "いい", tOffsetMs: 300 }] },
    { tStartMs: 900, dDurationMs: 3000, segs: [{ utf8: "天気です。" }] },
  ] };
  assert.strictEqual(build(data)[0].text, "今日はいい天気です。");
  console.log("OK 5: space-less script joined correctly");
}

// 6) An abbreviation does not end a sentence.
{
  const cues = build(asr([[0, "I met Dr. Smith yesterday."]]));
  assert.strictEqual(cues.length, 1);
  console.log("OK 6: 'Dr.' did not split the sentence");
}

// 7) Every cue keeps one start time per word for highlighting, in order and within the cue.
{
  const cues = build(asr([[0, "Hey everybody, it's Rob here. I'm"], [2100, "getting asked a ton of questions."]]));
  for (const cue of cues) {
    assert.strictEqual(cue.wordStarts.length, cue.text.split(" ").length, cue.text);
    assert.ok(cue.wordStarts.every((t, i) => i === 0 || t >= cue.wordStarts[i - 1]), cue.wordStarts.join(","));
    assert.strictEqual(cue.wordStarts[0], cue.start);
    assert.ok(cue.wordStarts.every((t) => t <= cue.start + cue.duration), cue.wordStarts.join(","));
  }
  assert.deepStrictEqual(cues[1].wordStarts, [1.75, 2.1, 2.45, 2.8, 3.15, 3.5, 3.85]);
  console.log("OK 7: word start times kept");
}

console.log("ALL TESTS PASSED");

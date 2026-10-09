// Re-segments auto-generated (asr) captions at sentence and clause boundaries.
// Loaded before content.js (same isolated world).
//
// YouTube's auto-generated captions break lines by screen width; those breaks land in the
// middle of sentences, and in translation the meaning drifts into the neighboring line.
// Using the word timings in json3 (tOffsetMs), words are regrouped at sentence ends and
// pauses. Long sentences that do not fit on screen are split into balanced parts at commas
// or near the middle.

const SEGMENT_MAX_CHARS = 90; // Maximum characters per subtitle (about two lines)
const SEGMENT_MAX_SECONDS = 7; // Maximum duration of a subtitle
const SEGMENT_MIN_SECONDS = 1; // Short subtitles stay at least this long (up to the next one)
const SEGMENT_PAUSE_SECONDS = 0.7; // A silence this long splits the subtitle even mid-sentence
const SEGMENT_JOIN_GAP_SECONDS = 0.6; // Short gaps between subtitles are closed (no flicker)
const WORD_MAX_SECONDS = 0.8; // json3 has no word end times; assumed maximum word duration

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/u;
const CLAUSE_END = /[,;:，、；：]["'”’)\]]*$/u;
const ABBREVIATION = /^(mr|mrs|ms|dr|prof|st|vs|etc|e\.g|i\.e)\.$/i;
const SOUND_TAG = /^\[[^\]]*\]$/;
// Long sentences prefer to split before these conjunctions (most auto captions are English).
const CONJUNCTION =
  /^(and|but|so|because|that|which|who|when|where|while|if|or|how|then|than|until|since|although|though|whether|after|before)$/i;
// Cutting after these words splits a phrase ("the | leaderboards").
const NO_BREAK_AFTER =
  /^(the|a|an|of|to|in|on|at|for|with|from|by|my|your|his|her|its|our|their|this|these|those|some|very|really|more|most)$/i;
// These scripts have no spaces between words.
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

const roundTime = (seconds) => Math.round(seconds * 1000) / 1000;

// Builds a list of words with absolute times from json3 events.
function extractWords(data) {
  const words = [];
  for (const event of data.events || []) {
    if (!event.segs) continue;
    const eventStart = (event.tStartMs || 0) / 1000;
    const eventEnd = eventStart + (event.dDurationMs || 0) / 1000;

    let firstInLine = true;
    for (const seg of event.segs) {
      const raw = (seg.utf8 || "").replace(/\n/g, " ");
      if (!raw.trim()) continue;
      const start = eventStart + (seg.tOffsetMs || 0) / 1000;
      // Tags such as [Music] last for the whole line; words get a short assumed duration.
      const maxEnd = SOUND_TAG.test(raw.trim()) ? eventEnd : start + WORD_MAX_SECONDS;
      words.push({ start, end: Math.min(maxEnd, eventEnd), raw, newLine: firstInLine });
      firstInLine = false;
    }
  }

  // A word ends before the next one starts.
  for (let i = 0; i < words.length - 1; i++) {
    words[i].end = Math.max(words[i].start, Math.min(words[i].end, words[i + 1].start));
  }
  return words;
}

// Words at the start of a line have no leading space; one is added where needed.
function joinWords(words) {
  let text = "";
  for (const word of words) {
    let piece = word.raw;
    if (text && word.newLine && !/^\s/.test(piece)) {
      const lastChar = text.slice(-1);
      const firstChar = piece.trimStart().charAt(0);
      if (!NO_SPACE_SCRIPT.test(lastChar) && !NO_SPACE_SCRIPT.test(firstChar)) piece = ` ${piece}`;
    }
    text += piece;
  }
  return text.replace(/\s+/g, " ").trim();
}

function endsSentence(text) {
  return SENTENCE_END.test(text) && !ABBREVIATION.test(text);
}

// Groups words at sentence ends, long pauses and sound tags.
function splitIntoSentences(words) {
  const groups = [];
  let current = [];

  words.forEach((word, i) => {
    const text = word.raw.trim();
    if (SOUND_TAG.test(text)) {
      if (current.length) groups.push(current);
      groups.push([word]);
      current = [];
      return;
    }

    current.push(word);
    const next = words[i + 1];
    const pause = next ? next.start - word.end : Infinity;
    if (endsSentence(text) || pause >= SEGMENT_PAUSE_SECONDS) {
      groups.push(current);
      current = [];
    }
  });

  if (current.length) groups.push(current);
  return groups;
}

function measure(words) {
  return { chars: joinWords(words).length, seconds: words[words.length - 1].end - words[0].start };
}

// Cut point score: distance from the target (lower is better). Clause boundaries such as
// commas, gaps before conjunctions and pauses are preferred; cuts after articles and
// prepositions are avoided.
function cutScore(words, index, leftChars, target, totalChars) {
  let score = Math.abs(leftChars - target) / totalChars;
  const before = words[index - 1].raw.trim();
  const after = words[index].raw.trim().replace(/[^\p{L}]/gu, "");
  if (CLAUSE_END.test(before)) score -= 0.2;
  else if (CONJUNCTION.test(after)) score -= 0.12;
  else if (NO_BREAK_AFTER.test(before)) score += 0.1;
  if (words[index].start - words[index - 1].end > 0.3) score -= 0.05;
  return score;
}

// Splits a sentence that does not fit on screen into the needed number of roughly equal parts.
// (Repeatedly halving produces needlessly small pieces.)
function splitLongSentence(words) {
  const { chars, seconds } = measure(words);
  const parts = Math.max(Math.ceil(chars / SEGMENT_MAX_CHARS), Math.ceil(seconds / SEGMENT_MAX_SECONDS));
  if (words.length < 2 || parts <= 1) return [words];

  const leftChars = [0];
  for (let i = 1; i < words.length; i++) leftChars[i] = joinWords(words.slice(0, i)).length;

  const cuts = [];
  let from = 1;
  for (let part = 1; part < parts; part++) {
    const target = (chars * part) / parts;
    let best = from;
    let bestScore = Infinity;
    // Every remaining part keeps at least one word.
    for (let i = from; i <= words.length - (parts - part); i++) {
      const score = cutScore(words, i, leftChars[i], target, chars);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    cuts.push(best);
    from = best + 1;
  }

  const pieces = [];
  let start = 0;
  for (const end of [...cuts, words.length]) {
    pieces.push(words.slice(start, end));
    start = end;
  }

  // Preferred cuts can push a part slightly over the limit; a part far over it is split again.
  return pieces.flatMap((piece) => {
    const size = measure(piece);
    const tooLong = size.chars > SEGMENT_MAX_CHARS * 1.2 || size.seconds > SEGMENT_MAX_SECONDS * 1.2;
    return tooLong && piece.length < words.length ? splitLongSentence(piece) : [piece];
  });
}

// Builds { start, duration, text } subtitles from the groups. Subtitles never overlap.
function groupsToCues(groups) {
  const cues = groups
    .map((words) => ({ start: words[0].start, end: words[words.length - 1].end, text: joinWords(words) }))
    .filter((cue) => cue.text);

  cues.forEach((cue, i) => {
    const nextStart = cues[i + 1]?.start ?? Infinity;
    cue.end = Math.max(cue.end, cue.start + SEGMENT_MIN_SECONDS);
    if (nextStart - cue.end < SEGMENT_JOIN_GAP_SECONDS) cue.end = nextStart;
    cue.end = Math.min(cue.end, nextStart);
  });

  return cues.map((cue) => ({
    start: roundTime(cue.start),
    duration: roundTime(Math.max(0, cue.end - cue.start)),
    text: cue.text,
  }));
}

// Builds a sentence-based subtitle array from json3 data.
function buildAsrCues(data) {
  const sentences = splitIntoSentences(extractWords(data));
  return groupsToCues(sentences.flatMap(splitLongSentence));
}

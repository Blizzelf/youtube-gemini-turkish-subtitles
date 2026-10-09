// Otomatik (asr) altyazıyı cümle ve yan cümle sınırlarında yeniden böler.
// content.js'ten önce yüklenir (aynı izole dünya).
//
// YouTube'un otomatik altyazısı satırları ekran genişliğine göre keser; bu kesimler cümle
// ortasına denk gelir ve çeviride anlam komşu satıra kayar. json3 formatındaki kelime
// zamanları (tOffsetMs) kullanılarak kelimeler cümle sonlarında ve duraklamalarda yeniden
// gruplanır. Ekrana sığmayan uzun cümleler virgüllerden ya da ortadan dengeli parçalara ayrılır.

const SEGMENT_MAX_CHARS = 90; // Bir altyazının en fazla karakteri (yaklaşık iki satır)
const SEGMENT_MAX_SECONDS = 7; // Bir altyazının en uzun süresi
const SEGMENT_MIN_SECONDS = 1; // Kısa altyazılar sonraki altyazıya kadar en az bu kadar kalır
const SEGMENT_PAUSE_SECONDS = 0.7; // Bu kadar sessizlik, cümle bitmese de altyazıyı böler
const SEGMENT_JOIN_GAP_SECONDS = 0.6; // Altyazılar arası kısa boşluklar kapatılır (titreme olmasın)
const WORD_MAX_SECONDS = 0.8; // json3 kelime bitişini vermez; bir kelimenin en uzun süresi varsayımı

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/u;
const CLAUSE_END = /[,;:，、；：]["'”’)\]]*$/u;
const ABBREVIATION = /^(mr|mrs|ms|dr|prof|st|vs|etc|e\.g|i\.e)\.$/i;
const SOUND_TAG = /^\[[^\]]*\]$/;
// Uzun cümleler bu bağlaçlardan önce bölünmeyi tercih eder (otomatik altyazının çoğu İngilizce).
const CONJUNCTION =
  /^(and|but|so|because|that|which|who|when|where|while|if|or|how|then|than|until|since|although|though|whether|after|before)$/i;
// Bu kelimelerden sonra kesmek ifadeyi böler ("the | leaderboards").
const NO_BREAK_AFTER =
  /^(the|a|an|of|to|in|on|at|for|with|from|by|my|your|his|her|its|our|their|this|these|those|some|very|really|more|most)$/i;
// Bu yazı sistemlerinde kelimeler arasında boşluk yoktur.
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

const roundTime = (seconds) => Math.round(seconds * 1000) / 1000;

// json3 olaylarından mutlak zamanlı kelime listesi çıkarır.
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
      // [Müzik] gibi etiketler satır boyunca sürer; kelimeler için kısa bir süre varsayılır.
      const maxEnd = SOUND_TAG.test(raw.trim()) ? eventEnd : start + WORD_MAX_SECONDS;
      words.push({ start, end: Math.min(maxEnd, eventEnd), raw, newLine: firstInLine });
      firstInLine = false;
    }
  }

  // Kelime, sonraki kelime başlamadan biter.
  for (let i = 0; i < words.length - 1; i++) {
    words[i].end = Math.max(words[i].start, Math.min(words[i].end, words[i + 1].start));
  }
  return words;
}

// Satır başındaki kelimelerde boşluk yoktur; gerekiyorsa eklenir.
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

// Kelimeleri cümle sonlarında, uzun duraklamalarda ve ses etiketlerinde gruplar.
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

// Kesim noktası puanı: hedefe uzaklık (düşük iyi). Virgül gibi yan cümle sınırları,
// bağlaçtan önceki aralar ve duraklamalar tercih edilir; artikel ve edattan sonrası kaçınılır.
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

// Ekrana sığmayan cümleyi gereken sayıda, yaklaşık eşit uzunlukta parçaya böler.
// (İkiye bölmeyi tekrarlamak gereksiz küçük parçalar üretir.)
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
    // Kalan her parçaya en az bir kelime bırakılır.
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

  // Tercihli kesimler parçayı sınırın biraz üstüne taşıyabilir; çok aşan parça tekrar bölünür.
  return pieces.flatMap((piece) => {
    const size = measure(piece);
    const tooLong = size.chars > SEGMENT_MAX_CHARS * 1.2 || size.seconds > SEGMENT_MAX_SECONDS * 1.2;
    return tooLong && piece.length < words.length ? splitLongSentence(piece) : [piece];
  });
}

// Gruplardan { start, duration, text } altyazıları üretir. Altyazılar üst üste binmez.
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

// json3 verisinden cümle bazlı altyazı dizisi üretir.
function buildAsrCues(data) {
  const sentences = splitIntoSentences(extractWords(data));
  return groupsToCues(sentences.flatMap(splitLongSentence));
}

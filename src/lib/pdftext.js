// Turns pdf.js text content into a single string for a page, remembering where
// every text run starts so the text layer and the reader can map offsets back
// to rendered words.

/** A gap this wide (in ems) between two runs on one line is a word space. */
const SPACE_GAP = 0.12;

/**
 * Make one run safe to speak and to compare. English PDFs are full of ligature
 * glyphs (ﬁ, ﬂ) and invisible marks, and a font that leans or is substituted
 * often leaves both behind; a voice reads "ofﬁce" as a single strange word, so
 * the letters are spelled out instead.
 */
function cleanRun(text) {
  if (!text) return "";
  let out = text;
  // Compatibility forms: ligatures become their letters, full-width and
  // presentation forms become the ordinary characters.
  if (out.normalize) out = out.normalize("NFKC");
  // Soft hyphens and zero-width marks are invisible, but they split a word for
  // a speech engine when they survive into the text.
  return out.replace(/[\u00ad\u200b-\u200d\ufeff\u2060]/g, "");
}

/** How far the run reaches from its origin, in text-space units. */
function advance(item) {
  if (Number.isFinite(item.width) && item.width > 0) return item.width;
  // Some fonts report no width at all. Guessing from the characters beats
  // treating the run as zero-width, which invents spaces in the middle of words.
  return item.str.length * (item.fontSize || 10) * 0.5;
}

/**
 * What separates two runs that sit on the same line. Many PDFs place each word
 * itself and rely on positioning rather than a space glyph, so the gap decides;
 * justified text and italic runs space words more tightly than a plain sample
 * page does, hence the small threshold. A gap of zero (or less) is a run split
 * inside a word, which must not be broken apart.
 */
function separate(prev, next) {
  const gap = next.transform[4] - (prev.transform[4] + advance(prev));
  if (!Number.isFinite(gap) || gap <= 0) return "";
  return gap > next.fontSize * SPACE_GAP ? " " : "";
}

/**
 * @param {{items: any[]}} textContent
 * @returns {{raw: string, items: {str: string, start: number, end: number, transform: number[], width: number, height: number, hasEOL: boolean}[]}}
 */
export function buildPageText(textContent) {
  const items = [];
  let raw = "";
  let prev = null;
  // The previous run ended a line; the break is only written once the next run
  // shows whether it continues the same word.
  let pendingBreak = false;

  for (const source of textContent.items ?? []) {
    if (!source || typeof source.str !== "string") continue;
    const str = cleanRun(source.str);
    if (!str) {
      if (source.hasEOL) pendingBreak = true;
      continue;
    }
    const transform = source.transform ?? [1, 0, 0, 1, 0, 0];
    const fontSize = Math.hypot(transform[2], transform[3]) || source.height || 10;
    const entry = {
      str,
      start: 0,
      end: 0,
      transform,
      width: source.width ?? 0,
      height: source.height ?? 0,
      fontSize,
      hasEOL: Boolean(source.hasEOL),
    };

    if (prev) {
      const sameLine = Math.abs(transform[5] - prev.transform[5]) <= fontSize * 0.5;
      // "exam-" at the end of one line and "ple" at the start of the next are
      // one word to a reader, not two; a hyphen before a capital ("well-" then
      // "Known") is a real hyphen and keeps its break.
      const brokenWord = /[-\u2010]$/.test(prev.str) && /^\p{Ll}/u.test(str);
      if ((pendingBreak || !sameLine) && brokenWord) {
        raw = raw.slice(0, -1);
        prev.str = prev.str.slice(0, -1);
        prev.end = raw.length;
      } else if (pendingBreak || !sameLine) {
        raw += "\n";
      } else if (!/\s$/.test(raw) && !/^\s/.test(str)) {
        raw += separate(prev, entry);
      }
    }
    pendingBreak = false;

    entry.start = raw.length;
    raw += str;
    entry.end = raw.length;
    items.push(entry);
    prev = entry;
    if (source.hasEOL) pendingBreak = true;
  }

  if (pendingBreak && raw && !raw.endsWith("\n")) raw += "\n";
  return { raw, items };
}

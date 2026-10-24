// Shared reading-range logic. Classic script so it can be loaded both as an ES
// module (via range.js) and as an injected content script.
((global) => {
  const NS = (global.__PDFREADER__ = global.__PDFREADER__ || {});

// Pure helpers that turn page text plus start/end word anchors into a reading
// range. No DOM and no pdf.js here so it can be unit tested in Node.

/**
 * Collapse every run of whitespace to a single space and trim the ends,
 * keeping a map from each collapsed index back to the original index.
 * @param {string} raw
 * @returns {{text: string, map: number[]}}
 */
function normalizeWhitespace(raw) {
  const chars = [];
  const map = [];
  let pendingSpace = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\u00a0") {
      if (chars.length) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      chars.push(" ");
      map.push(i);
      pendingSpace = false;
    }
    chars.push(ch);
    map.push(i);
  }
  return { text: chars.join(""), map };
}

/** Collapse whitespace in a search phrase so it matches normalised page text. */
function normalizeQuery(query) {
  return String(query ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function lower(text) {
  // Case-insensitive matching without changing string length.
  return text.replace(/[A-Z\u00c0-\u024f]/g, (c) => c.toLowerCase().length === 1 ? c.toLowerCase() : c);
}

/**
 * First index of `query` in `text` at or after `from`, case-insensitive.
 * @returns {number} -1 when there is no match.
 */
function findAnchor(text, query, from = 0) {
  const needle = normalizeQuery(query);
  if (!needle) return -1;
  const hay = lower(text);
  const idx = hay.indexOf(lower(needle), Math.max(0, from));
  return idx;
}

/** All match positions of `query` in `text`, case-insensitive. */
function findAllAnchors(text, query) {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  const hay = lower(text);
  const low = lower(needle);
  const hits = [];
  let at = 0;
  while (at <= hay.length) {
    const idx = hay.indexOf(low, at);
    if (idx === -1) break;
    hits.push(idx);
    at = idx + low.length;
  }
  return hits;
}

/**
 * Build a reading range as pages arrive. The viewer feeds this one page at a
 * time so a long PDF can start playing after the first page instead of waiting
 * for every page in the range to be parsed; `buildReadingRange` is the same
 * code handed all its pages at once.
 *
 * @param {{startWord?: string, endWord?: string}} [opts]
 */
function createRangeReader({ startWord, endWord } = {}) {
  const startQuery = normalizeQuery(startWord);
  const endQuery = normalizeQuery(endWord);
  const segments = [];
  let full = "";
  let from = -1;
  let emitted = 0;
  let endAt = -1;
  let closed = false;

  function pageAt(offset) {
    for (const seg of segments) {
      if (offset >= seg.start && offset < seg.end) return seg;
    }
    // Offset landed on a page separator space or past the last character.
    let chosen = segments[0];
    for (const seg of segments) {
      if (seg.start <= offset && seg.end > seg.start) chosen = seg;
    }
    return chosen ?? segments[segments.length - 1];
  }

  function endBound() {
    return endAt >= 0 ? endAt + endQuery.length : full.length;
  }

  const range = {
    /** Append one page's raw pdf.js text. Pages must arrive in reading order. */
    addPage(pageNumber, raw) {
      const { text, map } = normalizeWhitespace(raw ?? "");
      if (!text) {
        segments.push({ pageNumber, start: full.length, end: full.length, map });
        return;
      }
      if (full.length) full += " ";
      const start = full.length;
      segments.push({ pageNumber, start, end: start + text.length, map });
      full += text;
    },

    /**
     * Fix where reading begins. Stays false while the start word has not
     * appeared in the pages added so far.
     */
    begin() {
      if (from >= 0) return true;
      const idx = startQuery ? findAnchor(full, startQuery) : full.trim() ? 0 : -1;
      if (idx === -1) return false;
      from = idx;
      emitted = idx;
      return true;
    },

    /** True once the end word has been found at or after the start point. */
    resolveEnd() {
      if (endAt >= 0) return true;
      if (!endQuery || from < 0) return false;
      const at = findAnchor(full, endQuery, from);
      if (at !== -1) endAt = at;
      return endAt >= 0;
    },

    /**
     * Chunks for text added since the last call. Stops at the end word, so
     * nothing past it is ever handed to the reader.
     */
    takeChunks(maxLen = 280) {
      if (from < 0 || closed) return [];
      let to = full.length;
      if (range.resolveEnd()) {
        to = endAt + endQuery.length;
        closed = true;
      }
      if (to <= emitted) return [];
      const chunks = splitIntoChunks(full.slice(emitted, to), maxLen).map((chunk) => ({
        start: chunk.start + emitted,
        end: chunk.end + emitted,
        text: chunk.text,
      }));
      emitted = to;
      return chunks;
    },

    /** Whole range text available so far (useful for word counts). */
    text() {
      return from < 0 ? "" : full.slice(from, endBound()).trim();
    },

    wordCount() {
      const text = range.text();
      return text ? text.split(/\s+/).filter(Boolean).length : 0;
    },

    /** How many times an anchor appears in the pages loaded so far. */
    hits(query) {
      const needle = normalizeQuery(query);
      return needle ? findAllAnchors(full, needle).length : 0;
    },

    get started() {
      return from >= 0;
    },
    /** True once the end word has been reached: nothing more should be read. */
    get done() {
      return closed || endAt >= 0;
    },
    get full() {
      return full;
    },
    get segments() {
      return segments;
    },
    get startOffset() {
      return Math.max(0, from);
    },
    get endOffset() {
      return Math.max(0, endBound());
    },
    get startMatch() {
      return from >= 0 && startQuery ? { pageNumber: pageAt(from).pageNumber, offset: from } : undefined;
    },
    get endMatch() {
      return endAt >= 0 ? { pageNumber: pageAt(endAt).pageNumber, offset: endAt } : undefined;
    },
  };

  return range;
}

/**
 * Build the text that should be read for a page range with optional word
 * anchors.
 *
 * @param {{pageNumber: number, raw: string}[]} pages pages to read from; may be a
 *   contiguous subset of the document as long as `totalPages` is given
 * @param {{startPage?: number, endPage?: number, startWord?: string, endWord?: string, totalPages?: number}} opts
 * @returns {{
 *   ok: boolean, error?: string, text: string,
 *   segments: {pageNumber: number, start: number, end: number}[],
 *   startPage: number, endPage: number, startOffset: number, endOffset: number,
 *   startMatch?: {pageNumber: number, offset: number},
 *   endMatch?: {pageNumber: number, offset: number},
 *   startHits: number, endHits: number
 * }}
 */
function buildReadingRange(pages, opts = {}) {
  const byNumber = new Map(pages.map((p) => [p.pageNumber, p]));
  const total = opts.totalPages ?? Math.max(0, ...pages.map((p) => p.pageNumber));
  const clamp = (n, fallback) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 1), total) : fallback;
  };
  const startPage = clamp(opts.startPage, 1);
  const endPage = clamp(opts.endPage, total);
  const startWord = normalizeQuery(opts.startWord);
  const endWord = normalizeQuery(opts.endWord);

  const empty = {
    ok: false,
    text: "",
    segments: [],
    startPage,
    endPage,
    startOffset: 0,
    endOffset: 0,
    startHits: 0,
    endHits: 0,
  };

  if (!total) return { ...empty, error: "This PDF has no text pages to read." };
  if (startPage > endPage) {
    return { ...empty, error: `The start page (${startPage}) is after the end page (${endPage}).` };
  }

  const range = createRangeReader({ startWord, endWord });
  for (let n = startPage; n <= endPage; n++) {
    range.addPage(n, byNumber.get(n)?.raw ?? "");
  }

  if (!range.full.trim()) {
    return { ...empty, error: `No selectable text was found on pages ${startPage}–${endPage}.` };
  }
  if (!range.begin()) {
    return {
      ...empty,
      startHits: 0,
      error: `Start word “${startWord}” was not found on pages ${startPage}–${endPage}.`,
    };
  }
  if (endWord && !range.resolveEnd()) {
    return {
      ...empty,
      startHits: range.hits(startWord),
      error: `End word “${endWord}” does not appear after the start point on pages ${startPage}–${endPage}.`,
    };
  }

  const text = range.text();
  if (!text) {
    return {
      ...empty,
      startHits: range.hits(startWord),
      endHits: range.hits(endWord),
      error: "The start and end points are in the same place, so there is nothing to read.",
    };
  }

  return {
    ok: true,
    text,
    segments: range.segments,
    startPage,
    endPage,
    startOffset: range.startOffset,
    endOffset: range.endOffset,
    startHits: range.hits(startWord),
    endHits: range.hits(endWord),
    startMatch: range.startMatch,
    endMatch: range.endMatch,
  };
}

/**
 * Split text into speech-sized chunks, preferring sentence boundaries and
 * never cutting inside a word.
 * @param {string} text
 * @param {number} maxLen
 * @returns {{start: number, end: number, text: string}[]}
 */
function splitIntoChunks(text, maxLen = 280) {
  if (!text.trim()) return [];

  const sentences = [];
  let sentenceStart = 0;
  const ender = /([.!?…]+["'”’)\]]*)(?=\s|$)/g;
  let match;
  while ((match = ender.exec(text))) {
    const end = match.index + match[1].length;
    if (end > sentenceStart) {
      sentences.push([sentenceStart, end]);
      sentenceStart = end;
    }
  }
  if (sentenceStart < text.length) sentences.push([sentenceStart, text.length]);

  const chunks = [];
  let current = null;
  const flush = () => {
    if (current && current.end > current.start) {
      const t = text.slice(current.start, current.end).trim();
      if (t) chunks.push({ start: current.start, end: current.end, text: t });
    }
    current = null;
  };

  for (const [s, e] of sentences) {
    // A single sentence longer than the limit is split at word boundaries.
    if (e - s > maxLen) {
      flush();
      let at = s;
      while (at < e) {
        let stop = Math.min(at + maxLen, e);
        if (stop < e) {
          const space = text.lastIndexOf(" ", stop);
          if (space > at) stop = space;
          else {
            const next = text.indexOf(" ", stop);
            stop = next === -1 ? e : next;
          }
        }
        const piece = text.slice(at, stop).trim();
        if (piece) chunks.push({ start: at, end: stop, text: piece });
        at = stop;
        while (at < e && text[at] === " ") at++;
      }
      continue;
    }
    if (!current) current = { start: s, end: e };
    else if (e - current.start <= maxLen) current.end = e;
    else {
      flush();
      current = { start: s, end: e };
    }
  }
  flush();

  // Guarantee every chunk contains at least one non-space character.
  return chunks.filter((c) => /\S/.test(c.text));
}

  NS.range = {
    normalizeWhitespace,
    normalizeQuery,
    findAnchor,
    findAllAnchors,
    createRangeReader,
    buildReadingRange,
    splitIntoChunks,
  };
})(globalThis);

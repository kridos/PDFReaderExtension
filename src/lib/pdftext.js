// Turns pdf.js text content into a single string for a page, in reading order,
// remembering where every text run starts so the text layer and the reader can
// map offsets back to rendered words.

/** A gap this wide (in ems) between two runs on one line is a word space. */
const SPACE_GAP = 0.12;

/**
 * Text written right-to-left must keep the order the page draws it in: sorting
 * those runs by their left edge would reverse every line.
 */
const RTL = /[\u0590-\u05ff\u0600-\u06ff\u0700-\u074f\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;

/**
 * Make one run safe to speak and to compare. English PDFs are full of ligature
 * glyphs (ﬁ, ﬂ) and invisible marks, and a font that leans or is substituted
 * often leaves both behind; a voice reads "ofﬁce" as a single strange word, so
 * the letters are spelled out instead.
 *
 * Control characters and private-use glyph slots are dropped as well: they are
 * invisible, but some speech engines refuse an utterance that contains them and
 * then produce no sound at all, which is indistinguishable from a dead engine.
 */
function cleanRun(text) {
  if (!text) return "";
  let out = text;
  // Compatibility forms: ligatures become their letters, full-width and
  // presentation forms become the ordinary characters.
  if (out.normalize) out = out.normalize("NFKC");
  return out
    // Soft hyphens, zero-width marks, bidi controls and word joiners.
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    // C0/C1 controls, including the tabs and form feeds some producers leave in.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    // Private-use area: symbolic glyph slots with no readable character.
    .replace(/[\ue000-\uf8ff]/g, "")
    // A surrogate with no partner cannot be turned into a character at all.
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
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
  const gap = next.x - (prev.x + advance(prev));
  if (!Number.isFinite(gap) || gap <= 0) return "";
  return gap > next.fontSize * SPACE_GAP ? " " : "";
}

/** Everything with something to say, in the order the page's content stream drew it. */
function collectRuns(textContent) {
  const runs = [];
  for (const source of textContent.items ?? []) {
    if (!source || typeof source.str !== "string") continue;
    const str = cleanRun(source.str);
    if (!str) continue;
    const transform = source.transform ?? [1, 0, 0, 1, 0, 0];
    runs.push({
      str,
      transform,
      x: transform[4],
      y: transform[5],
      width: source.width ?? 0,
      height: source.height ?? 0,
      fontSize: Math.hypot(transform[2], transform[3]) || source.height || 10,
      hasEOL: Boolean(source.hasEOL),
      order: runs.length,
    });
  }
  return runs;
}

/**
 * Group runs into the lines they are actually drawn on. A content stream does
 * not have to draw a line left to right or one line at a time — headers,
 * footnotes and italic runs are often written at the end of the stream — and
 * taking that order as reading order put words out of place. Runs that share a
 * baseline belong together no matter when they were drawn; a run marked as the
 * end of a line starts a new one even if the next run is back on the same row.
 */
function groupLines(runs) {
  const lines = [];
  for (const run of runs) {
    const tolerance = Math.max(1.5, run.fontSize * 0.5);
    const previous = lines[lines.length - 1];
    let line = null;
    // The stream said this run ends a line, so the next run cannot join it.
    if (!previous || !previous.closed) {
      for (const candidate of lines) {
        if (candidate.closed) continue;
        if (Math.abs(candidate.y - run.y) <= tolerance) {
          line = candidate;
          break;
        }
      }
    }
    if (!line) {
      line = { y: run.y, runs: [], closed: false, order: run.order };
      lines.push(line);
    }
    line.runs.push(run);
    if (run.hasEOL) line.closed = true;
  }

  // Each line read from left to right, then the lines themselves put into
  // reading order. A baseline that carries two columns is split first.
  const ordered = [];
  for (const line of lines) {
    if (line.runs.some((run) => RTL.test(run.str))) {
      line.runs.sort((a, b) => a.order - b.order);
      ordered.push(line);
    } else {
      ordered.push(...splitBaseline(line));
    }
  }
  return orderLines(ordered);
}

/**
 * Cut one baseline into the pieces that are far apart: text in the next column
 * shares a baseline with the column beside it, and the stream may have written
 * either column first, so the runs are put in x order and then cut where the gap
 * is far wider than a word space. Each piece is a line of its own.
 */
function splitBaseline(line) {
  const runs = [...line.runs].sort((a, b) => a.x - b.x || a.order - b.order);
  const pieces = [];
  let piece = null;
  let reach = -Infinity;
  for (const run of runs) {
    if (!piece || run.x - reach > Math.max(run.fontSize * 1.5, 18)) {
      piece = { y: line.y, closed: line.closed, order: run.order, runs: [] };
      pieces.push(piece);
    }
    piece.runs.push(run);
    reach = Math.max(reach, run.x + advance(run));
  }
  return pieces;
}

/** Horizontal extent of a line, in text-space units. */
function lineSpan(line) {
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const run of line.runs) {
    x0 = Math.min(x0, run.x);
    x1 = Math.max(x1, run.x + advance(run));
  }
  return { x0, x1 };
}

/**
 * Vertical gutters: x positions that no line on the page covers. Text on both
 * sides of one is laid out in columns.
 */
function findGutters(spans) {
  const left = Math.min(...spans.map((span) => span.x0));
  const right = Math.max(...spans.map((span) => span.x1));
  const minGap = Math.max(8, (right - left) * 0.04);
  const byLeft = [...spans].sort((a, b) => a.x0 - b.x0);
  const gutters = [];
  let reach = byLeft[0].x1;
  for (const span of byLeft.slice(1)) {
    if (span.x0 - reach >= minGap) gutters.push((reach + span.x0) / 2);
    reach = Math.max(reach, span.x1);
  }
  return gutters;
}

/** One band of column text, read column by column from the left. */
function orderBand(band, gutters) {
  // One more column than there are gutters between them.
  const columns = Array.from({ length: gutters.length + 1 }, () => []);
  for (const item of band) {
    const centre = (item.span.x0 + item.span.x1) / 2;
    columns[gutters.filter((at) => centre > at).length].push(item.line);
  }
  return columns
    .filter((column) => column.length)
    .flatMap((column) => column.sort((a, b) => b.y - a.y || a.x - b.x || a.order - b.order));
}

/**
 * Put a page's lines into reading order: top to bottom, and on a page laid out
 * in columns, one column at a time from the left. The content stream's order is
 * not a reading order — a producer may write a footnote, heading or whole
 * paragraph before the line above it — so position decides, and the stream's
 * order only breaks ties. A line that spans the columns (a heading or a footer)
 * is read on its own, between the columns above and below it.
 */
function orderLines(lines) {
  if (lines.length < 2) return [...lines];
  const spans = new Map(lines.map((line) => [line, lineSpan(line)]));
  const topDown = [...lines].sort((a, b) => b.y - a.y || a.x - b.x || a.order - b.order);
  const gutters = findGutters([...spans.values()]);
  if (!gutters.length) return topDown;

  const out = [];
  let band = [];
  const flush = () => {
    if (!band.length) return;
    out.push(...orderBand(band, gutters));
    band = [];
  };
  for (const line of topDown) {
    const span = spans.get(line);
    const crosses = gutters.some((at) => span.x0 < at && span.x1 > at);
    if (crosses) {
      flush();
      out.push(line);
    } else {
      band.push({ line, span });
    }
  }
  flush();
  return out;
}

/**
 * @param {{items: any[]}} textContent
 * @returns {{raw: string, items: {str: string, start: number, end: number, transform: number[], x: number, y: number, width: number, height: number, fontSize: number, hasEOL: boolean}[]}}
 */
export function buildPageText(textContent) {
  const lines = groupLines(collectRuns(textContent));
  const items = [];
  let raw = "";
  let prev = null;
  // The first run of a line needs a break in front of it, but whether that is a
  // newline or nothing at all (a word hyphenated over the break) depends on the
  // run that follows.
  let startsLine = false;

  for (const line of lines) {
    for (const run of line.runs) {
      const entry = {
        str: run.str,
        start: 0,
        end: 0,
        transform: run.transform,
        x: run.x,
        y: run.y,
        width: run.width,
        height: run.height,
        fontSize: run.fontSize,
        hasEOL: run.hasEOL,
      };

      if (prev) {
        // "exam-" at the end of one line and "ple" at the start of the next are
        // one word to a reader, not two; a hyphen before a capital ("well-" then
        // "Known") is a real hyphen and keeps its break.
        const brokenWord = startsLine && /[-\u2010]$/.test(prev.str) && /^\p{Ll}/u.test(run.str);
        if (brokenWord) {
          raw = raw.slice(0, -1);
          prev.str = prev.str.slice(0, -1);
          prev.end = raw.length;
        } else if (startsLine) {
          raw += "\n";
        } else if (!/^\s/.test(run.str) && !/\s$/.test(raw)) {
          raw += separate(prev, run);
        }
      }
      startsLine = false;

      entry.start = raw.length;
      raw += entry.str;
      entry.end = raw.length;
      items.push(entry);
      prev = entry;
    }
    startsLine = true;
  }

  if (items.at(-1)?.hasEOL && raw && !raw.endsWith("\n")) raw += "\n";
  return { raw, items };
}

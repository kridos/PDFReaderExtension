// Turns pdf.js text content into a single string for a page, remembering where
// every text run starts so the text layer and the reader can map offsets back
// to rendered words.

/**
 * @param {{items: any[]}} textContent
 * @returns {{raw: string, items: {str: string, start: number, end: number, transform: number[], width: number, height: number, hasEOL: boolean}[]}}
 */
export function buildPageText(textContent) {
  const items = [];
  let raw = "";
  let prev = null;

  for (const item of textContent.items ?? []) {
    if (!item || typeof item.str !== "string") continue;
    if (!item.str) {
      // Empty runs still carry the line break that ends a line.
      if (item.hasEOL && raw && !raw.endsWith("\n")) raw += "\n";
      continue;
    }
    const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
    const fontSize = Math.hypot(transform[2], transform[3]) || 10;

    if (prev && raw && !/\s$/.test(raw) && !/^\s/.test(item.str)) {
      const vertical = Math.abs(transform[5] - prev.transform[5]);
      if (vertical > fontSize * 0.5) {
        // Next run sits on a different line.
        raw += "\n";
      } else {
        // Separate runs that are visibly apart; many PDFs emit one run per word.
        const gap = transform[4] - (prev.transform[4] + (prev.width ?? 0));
        if (!Number.isFinite(gap) || gap > fontSize * 0.18) raw += " ";
      }
    }

    const start = raw.length;
    raw += item.str;
    items.push({
      str: item.str,
      start,
      end: raw.length,
      transform,
      width: item.width ?? 0,
      height: item.height ?? 0,
      hasEOL: Boolean(item.hasEOL),
    });
    if (item.hasEOL) raw += "\n";
    prev = items[items.length - 1];
  }

  return { raw, items };
}

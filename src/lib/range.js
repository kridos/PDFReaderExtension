// ES module wrapper. The implementation lives in range.core.js so the injected
// page reader (a classic content script) can load the same code.
import "./range.core.js";

const {
  normalizeWhitespace,
  normalizeQuery,
  findAnchor,
  findAllAnchors,
  createRangeReader,
  buildReadingRange,
  splitIntoChunks,
} = globalThis.__PDFREADER__.range;

export {
  normalizeWhitespace,
  normalizeQuery,
  findAnchor,
  findAllAnchors,
  createRangeReader,
  buildReadingRange,
  splitIntoChunks,
};

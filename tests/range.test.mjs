import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReadingRange,
  createRangeReader,
  findAllAnchors,
  findAnchor,
  normalizeWhitespace,
  splitIntoChunks,
} from "../src/lib/range.js";

const PAGES = [
  { pageNumber: 1, raw: "Chapter one\nThis is the first page of the story.\n" },
  { pageNumber: 2, raw: "Chapter two\nHere the plot thickens considerably.\n" },
  { pageNumber: 3, raw: "Conclusion\nIn conclusion, everything ends well.\n" },
];

test("normalizeWhitespace collapses runs and keeps an index map", () => {
  const { text, map } = normalizeWhitespace("  Hello \n\n  world\t!\n");
  assert.equal(text, "Hello world !");
  assert.equal(map.length, text.length);
  assert.equal("  Hello \n\n  world\t!\n"[map[0]], "H");
  assert.equal("  Hello \n\n  world\t!\n"[map[6]], "w");
});

test("anchors are found case-insensitively", () => {
  assert.equal(findAnchor("The PLOT thickens", "plot"), 4);
  assert.equal(findAnchor("The plot thickens", "plot", 5), -1);
  assert.deepEqual(findAllAnchors("plot plot plot", "plot"), [0, 5, 10]);
  assert.equal(findAnchor("anything", ""), -1);
});

test("page range without word anchors reads whole pages", () => {
  const info = buildReadingRange(PAGES, { startPage: 1, endPage: 2 });
  assert.equal(info.ok, true);
  assert.equal(info.text, "Chapter one This is the first page of the story. Chapter two Here the plot thickens considerably.");
  assert.equal(info.segments.length, 2);
  assert.equal(info.segments[1].pageNumber, 2);
});

test("start and end word anchors trim the range to the words", () => {
  const info = buildReadingRange(PAGES, {
    startPage: 2,
    endPage: 3,
    startWord: "plot",
    endWord: "everything",
  });
  assert.equal(info.ok, true);
  assert.equal(info.text, "plot thickens considerably. Conclusion In conclusion, everything");
  assert.deepEqual(info.startMatch, { pageNumber: 2, offset: info.startOffset });
  assert.equal(info.endMatch.pageNumber, 3);
});

test("anchors can sit on the first and last page of the document", () => {
  const info = buildReadingRange(PAGES, {
    startPage: 1,
    endPage: 3,
    startWord: "first page",
    endWord: "ends well",
  });
  assert.equal(info.ok, true);
  assert.equal(info.text, "first page of the story. Chapter two Here the plot thickens considerably. Conclusion In conclusion, everything ends well");
});

test("pages served as a subset still map to absolute page numbers", () => {
  const subset = [PAGES[1], PAGES[2]];
  const info = buildReadingRange(subset, {
    startPage: 2,
    endPage: 3,
    startWord: "plot",
    endWord: "everything",
    totalPages: 3,
  });
  assert.equal(info.ok, true);
  assert.equal(info.text, "plot thickens considerably. Conclusion In conclusion, everything");
  assert.equal(info.startMatch.pageNumber, 2);
  assert.equal(info.endMatch.pageNumber, 3);
  // Segment offsets index into that page's collapsed text.
  const second = info.segments[1];
  assert.equal(second.pageNumber, 3);
  const local = info.endOffset - second.start;
  assert.equal("Conclusion In conclusion, everything ends well"[second.map[local]], "e");
});

test("missing start word is reported instead of silently reading everything", () => {
  const info = buildReadingRange(PAGES, { startPage: 1, endPage: 2, startWord: "zebra" });
  assert.equal(info.ok, false);
  assert.match(info.error, /zebra/);
  assert.match(info.error, /not found/);
});

test("an end word before the start point is reported", () => {
  const info = buildReadingRange(PAGES, {
    startPage: 1,
    endPage: 3,
    startWord: "conclusion",
    endWord: "plot",
  });
  assert.equal(info.ok, false);
  assert.match(info.error, /after the start point/);
});

test("inverted page range is reported", () => {
  const info = buildReadingRange(PAGES, { startPage: 3, endPage: 1 });
  assert.equal(info.ok, false);
  assert.match(info.error, /start page/i);
});

test("page range is clamped to the document", () => {
  const info = buildReadingRange(PAGES, { startPage: 0, endPage: 99 });
  assert.equal(info.startPage, 1);
  assert.equal(info.endPage, 3);
  assert.equal(info.ok, true);
});

test("image-only pages are skipped with a readable error", () => {
  const info = buildReadingRange(
    [{ pageNumber: 1, raw: "" }, { pageNumber: 2, raw: "   \n  " }],
    { startPage: 1, endPage: 2 },
  );
  assert.equal(info.ok, false);
  assert.match(info.error, /No selectable text/);
});

test("pages can arrive one at a time while the range is being read", () => {
  const range = createRangeReader({ startWord: "plot", endWord: "everything" });

  range.addPage(2, "Chapter two\nHere the plot thickens considerably.\n");
  assert.equal(range.begin(), true, "start word is on the page just added");
  assert.equal(range.done, false);
  const first = range.takeChunks();
  // Text before the start word is never spoken.
  assert.equal(first[0].start, range.startOffset);
  assert.doesNotMatch(first[0].text, /Chapter two/);
  assert.equal(first.map((c) => c.text).join(" "), "plot thickens considerably.");
  assert.equal(range.startMatch.pageNumber, 2);

  // Nothing new yet, so nothing more to say.
  assert.deepEqual(range.takeChunks(), []);

  range.addPage(3, "Conclusion\nIn conclusion, everything ends well. More text.");
  assert.equal(range.resolveEnd(), true);
  assert.equal(range.done, true);
  const second = range.takeChunks();
  const joined = second.map((c) => c.text).join(" ");
  assert.match(joined, /Conclusion In conclusion, everything$/);
  assert.doesNotMatch(joined, /ends well|More text/, "reading stops at the end word");
  assert.equal(range.endMatch.pageNumber, 3);
  assert.deepEqual(range.takeChunks(), [], "chunks are only handed out once");
});

test("the incremental reader agrees with the all-at-once builder", () => {
  const options = { startPage: 1, endPage: 3, startWord: "chapter two", endWord: "ends well" };
  const bulk = buildReadingRange(PAGES, options);

  // Same pages, but handed over one by one with chunks drained in between,
  // exactly as the viewer does while the voice is speaking.
  const range = createRangeReader(options);
  const chunks = [];
  for (const page of PAGES) {
    range.addPage(page.pageNumber, page.raw);
    range.begin();
    range.resolveEnd();
    chunks.push(...range.takeChunks());
  }

  assert.equal(range.text(), bulk.text);
  assert.equal(range.startMatch.pageNumber, bulk.startMatch.pageNumber);
  assert.equal(range.startMatch.offset, bulk.startMatch.offset);
  assert.equal(range.endMatch.pageNumber, bulk.endMatch.pageNumber);
  assert.equal(chunks.map((c) => c.text).join(" "), bulk.text);
  assert.deepEqual(
    range.segments.map((s) => s.pageNumber),
    bulk.segments.map((s) => s.pageNumber),
  );
});

test("chunks stay under the limit, never split words, and keep offsets usable", () => {
  const text =
    "This is a short sentence. Here is a rather longer sentence that runs on and on because it needs " +
    "to exceed the configured character budget for a single chunk. Final words here.";
  const chunks = splitIntoChunks(text, 60);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.equal(text.slice(chunk.start, chunk.end).trim(), chunk.text);
    assert.ok(chunk.text.length <= 60, `chunk too long: ${chunk.text.length}`);
    assert.doesNotMatch(chunk.text, /\s{2,}/);
  }
  // Adjacent chunks only skip whitespace between them.
  for (let i = 1; i < chunks.length; i++) {
    const gap = text.slice(chunks[i - 1].end, chunks[i].start);
    assert.equal(gap.trim(), "");
  }
  assert.match(chunks[0].text, /^This is a short sentence\.$/);
  assert.equal(chunks.at(-1).text, "Final words here.");
});

test("chunks fall back to word boundaries for a single huge sentence", () => {
  const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ") + ".";
  const chunks = splitIntoChunks(text, 50);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 50);
    assert.doesNotMatch(chunk.text, /wor$|^d\d/);
  }
  assert.equal(chunks.map((c) => c.text).join(" ").replace(/\s+/g, " "), text);
});

test("empty text produces no chunks", () => {
  assert.deepEqual(splitIntoChunks("   "), []);
});

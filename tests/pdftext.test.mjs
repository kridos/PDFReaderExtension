import test from "node:test";
import assert from "node:assert/strict";
import { buildPageText } from "../src/lib/pdftext.js";

const item = (str, x, width, hasEOL = false) => ({
  str,
  transform: [12, 0, 0, 12, x, 700],
  width,
  height: 12,
  hasEOL,
});

test("separate runs that are far apart get a space between them", () => {
  const { raw, items } = buildPageText({
    items: [item("Hello", 100, 30), item("world", 140, 30, true), item("Next", 100, 25)],
  });
  assert.equal(raw, "Hello world\nNext");
  assert.deepEqual(items.map((i) => i.str), ["Hello", "world", "Next"]);
  assert.deepEqual(items.map((i) => i.start), [0, 6, 12]);
});

test("runs that already contain spacing are not doubled up", () => {
  const { raw } = buildPageText({ items: [item("Hello ", 100, 30), item("world", 132, 30)] });
  assert.equal(raw, "Hello world");
});

test("explicit line ends become newlines", () => {
  const { raw } = buildPageText({ items: [item("line one", 100, 50, true), item("line two", 100, 50)] });
  assert.equal(raw, "line one\nline two");
});

test("non-text and empty items are ignored", () => {
  const { raw, items } = buildPageText({
    items: [{ type: "beginMarkedContent" }, item("", 0, 0), { str: "hi", transform: [12, 0, 0, 12, 50, 50] }],
  });
  assert.equal(raw, "hi");
  assert.equal(items.length, 1);
});

/** A run placed at an exact position, so gaps can be measured in ems. */
const run = (str, x, width, { y = 700, size = 12, hasEOL = false } = {}) => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width,
  height: size,
  hasEOL,
});

test("a tight word gap still separates two words", () => {
  // Justified and italic runs space words closer than a plain page does; 1.6pt
  // at 12pt is 0.13em, which is a space, not a split word.
  const { raw } = buildPageText({ items: [run("italic", 100, 36), run("words", 137.6, 40)] });
  assert.equal(raw, "italic words");
});

test("runs that meet exactly are one word, not two", () => {
  const { raw } = buildPageText({ items: [run("Hel", 100, 18), run("lo", 118, 12)] });
  assert.equal(raw, "Hello");
});

test("a word hyphenated over a line break becomes one word", () => {
  const { raw, items } = buildPageText({
    items: [run("exam-", 100, 30, { hasEOL: true }), run("ple", 100, 18, { y: 686 })],
  });
  assert.equal(raw, "example");
  assert.deepEqual(
    items.map((entry) => [entry.start, entry.end]),
    [
      [0, 4],
      [4, 7],
    ],
  );
  assert.equal(raw.slice(items[1].start, items[1].end), "ple");
});

test("a real hyphen at a line break keeps its break", () => {
  const { raw } = buildPageText({
    items: [run("well-", 100, 26, { hasEOL: true }), run("Known", 100, 36, { y: 686 })],
  });
  assert.equal(raw, "well-\nKnown");
});

test("runs drawn out of order are read left to right", () => {
  // A content stream may place the last word of a line first: the line is put
  // back together by where the runs sit, not by when they were drawn.
  const { raw, items } = buildPageText({
    items: [run("third", 164, 30), run("first", 100, 28), run("second", 132, 28)],
  });
  assert.equal(raw, "first second third");
  assert.deepEqual(items.map((i) => i.str), ["first", "second", "third"]);
});

test("a run drawn after a later line still belongs to its own line", () => {
  const { raw } = buildPageText({
    items: [
      run("line one", 100, 50, { y: 700 }),
      run("line two", 100, 50, { y: 686 }),
      run("tail of one", 160, 50, { y: 700 }),
    ],
  });
  assert.equal(raw, "line one tail of one\nline two");
});

test("text written right to left keeps the order it was drawn in", () => {
  const { items } = buildPageText({ items: [run("\u05e9\u05dc\u05d5\u05dd", 140, 30), run("\u05e2\u05d5\u05dc\u05dd", 100, 30)] });
  assert.deepEqual(
    items.map((i) => i.str),
    ["\u05e9\u05dc\u05d5\u05dd", "\u05e2\u05d5\u05dc\u05dd"],
  );
});

test("control characters and private-use glyphs never reach the voice", () => {
  // Some engines refuse an utterance containing these and then make no sound.
  const { raw } = buildPageText({ items: [run("of\u0000fice\u0007 \ue001works", 100, 60)] });
  assert.equal(raw, "office works");
});

test("ligatures and invisible marks are spelled out for the voice", () => {
  const { raw, items } = buildPageText({ items: [run("of\u00ad\ufb01ce", 100, 30)] });
  assert.equal(raw, "office");
  assert.deepEqual([items[0].start, items[0].end], [0, 6]);
});

test("lines are read top to bottom even when the page draws them out of order", () => {
  const { raw } = buildPageText({
    items: [
      run("second line", 100, 70, { y: 686 }),
      run("first line", 100, 60, { y: 700 }),
    ],
  });
  assert.equal(raw, "first line\nsecond line");
});

test("a page laid out in two columns is read one column at a time", () => {
  const { raw } = buildPageText({
    items: [
      run("right one", 320, 60, { y: 700 }),
      run("left one", 50, 55, { y: 700 }),
      run("right two", 320, 60, { y: 686 }),
      run("left two", 50, 55, { y: 686 }),
    ],
  });
  assert.equal(raw, "left one\nleft two\nright one\nright two");
});

test("a heading across the columns is read before them", () => {
  const { raw } = buildPageText({
    items: [
      run("left text", 50, 55, { y: 700 }),
      run("right text", 320, 60, { y: 700 }),
      run("A Heading Across Both Columns", 50, 300, { y: 740 }),
    ],
  });
  assert.equal(raw, "A Heading Across Both Columns\nleft text\nright text");
});

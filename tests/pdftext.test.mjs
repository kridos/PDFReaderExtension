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

test("ligatures and invisible marks are spelled out for the voice", () => {
  const { raw, items } = buildPageText({ items: [run("of\u00ad\ufb01ce", 100, 30)] });
  assert.equal(raw, "office");
  assert.deepEqual([items[0].start, items[0].end], [0, 6]);
});

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

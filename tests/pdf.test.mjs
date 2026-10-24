import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildPageText } from "../src/lib/pdftext.js";
import { buildReadingRange, splitIntoChunks } from "../src/lib/range.js";
import { buildEditedPdf, toPdfRect, toWinAnsi } from "../src/lib/exporter.js";

const FONT_DIR = new URL("../src/vendor/pdfjs/standard_fonts/", import.meta.url).href;

async function makeSample() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const content = [
    ["Chapter one", "Alpha page one begins here."],
    ["Chapter two", "Beta page two continues the plot."],
    ["Chapter three", "Gamma page three ends the plot."],
  ];
  for (const [heading, body] of content) {
    const page = doc.addPage([612, 792]);
    page.drawText(heading, { x: 72, y: 720, size: 18, font });
    page.drawText(body, { x: 72, y: 690, size: 12, font });
  }
  doc.getPage(0).setRotation(degrees(90));
  return new Uint8Array(await doc.save());
}

async function inspect(bytes) {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    standardFontDataUrl: FONT_DIR,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  const pages = [];
  const rotations = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    pages.push({ pageNumber: n, ...buildPageText(await page.getTextContent()) });
    rotations.push(page.rotate);
  }
  const numPages = doc.numPages;
  await loadingTask.destroy();
  return { pages, rotations, numPages };
}

const sample = await makeSample();

test("text extracted from a real PDF joins runs and pages in reading order", async () => {
  const { pages, rotations, numPages } = await inspect(sample);
  assert.equal(numPages, 3);
  assert.equal(rotations[0], 90);
  assert.match(pages[0].raw, /Chapter one/);
  assert.match(pages[0].raw, /Alpha page one begins here\./);
  assert.match(pages[1].raw, /Beta page two continues the plot\./);
  assert.match(pages[2].raw, /Gamma page three ends the plot\./);
});

test("word anchors pick the requested slice of a real document", async () => {
  const { pages } = await inspect(sample);
  const pageData = pages.map((p) => ({ pageNumber: p.pageNumber, raw: p.raw }));
  const info = buildReadingRange(pageData, {
    startPage: 2,
    endPage: 3,
    startWord: "Beta",
    endWord: "Gamma",
  });
  assert.equal(info.ok, true, info.error);
  assert.equal(info.text, "Beta page two continues the plot. Chapter three Gamma");
  assert.equal(info.startMatch.pageNumber, 2);
  assert.equal(info.endMatch.pageNumber, 3);
  assert.equal(splitIntoChunks(info.text).length >= 1, true);
});

test("export honours page order, additions of rotation and annotations", async () => {
  const out = await buildEditedPdf(sample, {
    pageOrder: [3, 1],
    rotations: { 1: 90 },
    annotations: [
      { id: "h1", page: 1, type: "highlight", color: "#facc15", rects: [{ x: 0.1, y: 0.8, w: 0.3, h: 0.02 }] },
      { id: "i1", page: 1, type: "ink", color: "#ef4444", strokeWidth: 0.003, points: [[0.2, 0.5], [0.4, 0.4], [0.6, 0.45]] },
      { id: "t1", page: 1, type: "text", color: "#2563eb", x: 0.2, y: 0.3, fontSize: 0.02, text: "Note added" },
      { id: "gone", page: 2, type: "highlight", color: "#facc15", rects: [{ x: 0, y: 0, w: 1, h: 1 }] },
    ],
  });

  const result = await inspect(out);
  assert.equal(result.numPages, 2);
  assert.match(result.pages[0].raw, /Gamma page three/);
  assert.match(result.pages[1].raw, /Alpha page one/);
  assert.match(result.pages[1].raw, /Note added/);
  assert.equal(result.pages.some((p) => /Beta page two/.test(p.raw)), false, "deleted page is gone");
  assert.equal(result.rotations[0], 0);
  assert.equal(result.rotations[1], 180, "90° page rotated another 90°");

});

test("normalised annotation coordinates map onto PDF points", () => {
  const rect = toPdfRect({ x: 0.1, y: 0.8, w: 0.3, h: 0.02 }, { x: 0, y: 0, width: 612, height: 792 });
  assert.ok(Math.abs(rect.x - 61.2) < 1e-9, `x was ${rect.x}`);
  assert.ok(Math.abs(rect.y - 633.6) < 1e-9, `y was ${rect.y}`);
  assert.ok(Math.abs(rect.width - 183.6) < 1e-9, `width was ${rect.width}`);
  assert.ok(Math.abs(rect.height - 15.84) < 1e-9, `height was ${rect.height}`);

  // Crop boxes that do not start at the origin keep their offset.
  assert.deepEqual(toPdfRect({ x: 0, y: 0, w: 1, h: 1 }, { x: 10, y: 20, width: 100, height: 200 }), {
    x: 10,
    y: 20,
    width: 100,
    height: 200,
  });
});

test("an empty page order falls back to the whole document", async () => {
  const out = await buildEditedPdf(sample, { pageOrder: [], rotations: {}, annotations: [] });
  const result = await inspect(out);
  assert.equal(result.numPages, 3);
});

test("annotations on later pages are drawn too", async () => {
  const out = await buildEditedPdf(sample, {
    pageOrder: [1, 2, 3],
    rotations: {},
    annotations: [
      { id: "t3", page: 3, type: "text", color: "#111827", x: 0.05, y: 0.05, fontSize: 0.03, text: "Footer note" },
    ],
  });
  const result = await inspect(out);
  assert.match(result.pages[2].raw, /Footer note/);
  assert.doesNotMatch(result.pages[0].raw, /Footer note/);
});

test("text outside WinAnsi is replaced instead of breaking the export", () => {
  assert.equal(toWinAnsi("Café — “quoted” 日本"), "Café ? ?quoted? ??");
});

// End-to-end test of src/viewer.html in a real Chromium, with a fake speech
// synthesiser so follow-along highlighting can be observed deterministically.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { chromium } from "playwright";

const ROOT = path.join(import.meta.dirname, "..");
const FONT_DIR = new URL("../src/vendor/pdfjs/standard_fonts/", import.meta.url).href;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".icc": "application/octet-stream",
};

async function makeSamplePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [
    ["Chapter one", "The river was cold that morning.", "Alpha opener sits on the first page."],
    ["Chapter two", "Beta marker appears here.", "The plot thickens slowly and then stops."],
    ["Chapter three", "Gamma marker closes the story.", "Delta tail text that must not be read."],
  ];
  for (const [heading, ...lines] of pages) {
    const page = doc.addPage([612, 792]);
    page.drawText(heading, { x: 72, y: 720, size: 18, font });
    lines.forEach((line, i) => {
      page.drawText(line, { x: 72, y: 680 - i * 24, size: 12, font });
    });
  }
  return new Uint8Array(await doc.save());
}

/** A PDF long enough that parsing every page up front would be obvious. */
async function makeLongPdf(pageCount = 30) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pageCount; n++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Chapter ${n}`, { x: 72, y: 720, size: 18, font });
    page.drawText(`Page ${n} marker opens the page.`, { x: 72, y: 690, size: 12, font });
  }
  return new Uint8Array(await doc.save());
}

async function startServer(sample) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/sample.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(Buffer.from(sample));
      return;
    }
    const filePath = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await fs.readFile(filePath);
      res.writeHead(200, { "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, origin: `http://127.0.0.1:${port}` };
}

const FAKE_TTS = (wordDelay = 25) => {
  class FakeUtterance {
    constructor(text) {
      this.text = text;
    }
  }
  window.SpeechSynthesisUtterance = FakeUtterance;
  const synth = {
    speaking: false,
    paused: false,
    current: null,
    getVoices: () => [{ name: "Test voice", lang: "en-US", voiceURI: "test-voice", localService: true }],
    addEventListener() {},
    removeEventListener() {},
    cancel() {
      this.current = null;
      this.speaking = false;
    },
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
    speak(utterance) {
      window.__spoken = window.__spoken || [];
      window.__spoken.push(utterance.text);
      window.__rates = window.__rates || [];
      window.__rates.push(utterance.rate);
      this.current = utterance;
      this.speaking = true;
      utterance.onstart?.();
      const positions = [];
      const re = /\S+/g;
      let match;
      while ((match = re.exec(utterance.text))) positions.push(match.index);
      let i = 0;
      const step = () => {
        if (this.current !== utterance) return;
        if (i >= positions.length) {
          this.speaking = false;
          utterance.onend?.();
          return;
        }
        utterance.onboundary?.({ name: "word", charIndex: positions[i] });
        i++;
        setTimeout(step, wordDelay);
      };
      setTimeout(step, 0);
    },
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
};

test("viewer renders, reads a word-anchored range, annotates and saves", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(FAKE_TTS);
  const page = await context.newPage();

  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  // Same shape the service worker produces: the raw URL is appended unencoded
  // and may itself carry a query string.
  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf?v=1&t=2`);

  // ---- Rendering ----
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, { timeout: 20000 });
  const canvas = await page.evaluate(() => {
    const c = document.querySelector("#pdfCanvas");
    return { width: c.width, height: c.height };
  });
  assert.ok(canvas.width > 300, `canvas not rendered (${canvas.width}x${canvas.height})`);
  const wordCount = await page.evaluate(() => document.querySelectorAll("#textLayer .w").length);
  assert.ok(wordCount > 5, `text layer has ${wordCount} words`);

  // Zoom shortcuts change the label, and Ctrl+0 returns to fit-to-width.
  const zoomBefore = await page.textContent("#btnZoomLabel");
  await page.keyboard.press("Control+=");
  await page.waitForFunction(
    (before) => document.querySelector("#btnZoomLabel").textContent !== before,
    zoomBefore,
    { timeout: 5000 },
  );
  await page.keyboard.press("Control+0");
  await page.waitForFunction((before) => document.querySelector("#btnZoomLabel").textContent === before, zoomBefore, {
    timeout: 5000,
  });

  // The speed slider reaches the 8× ceiling and the value is handed to the voice.
  const speedLabel = await page.evaluate(() => {
    const el = document.querySelector("#rate");
    el.value = "8";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return document.querySelector("#rateLabel").textContent;
  });
  assert.equal(speedLabel, "8.0×");

  // ---- Word-anchored range ----
  await page.fill("#startPage", "2");
  await page.fill("#endPage", "3");
  await page.fill("#startWord", "Beta");
  await page.fill("#endWord", "Gamma");
  await page.waitForFunction(
    () => /Pages 2–3/.test(document.querySelector("#rangeStatus")?.textContent ?? ""),
    null,
    { timeout: 20000 },
  );
  const status = await page.textContent("#rangeStatus");
  assert.match(status, /starts on page 2/);

  // ---- Reading follows along onto the next page ----
  // Record every word the viewer marks as being spoken, so the highlight can be
  // checked against the text, not just its existence.
  await page.evaluate(() => {
    window.__readWords = [];
    new MutationObserver((records) => {
      for (const record of records) {
        const el = record.target;
        if (record.attributeName !== "class" || !el.classList?.contains("reading")) continue;
        window.__readWords.push({ page: document.querySelector("#pageInput")?.value, word: el.textContent });
      }
    }).observe(document.querySelector("#textLayer"), {
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  });
  await page.click("#btnReadRange");
  await page.waitForFunction(() => Boolean(document.querySelector("#textLayer .w.reading")), null, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector("#pageInput")?.value === "3", null, { timeout: 10000 });
  await page.waitForFunction(() => window.__spoken?.length > 0, null, { timeout: 10000 });
  const spoken = await page.evaluate(() => window.__spoken.join(" "));
  const rates = await page.evaluate(() => window.__rates);
  assert.ok(rates.length > 0, "no utterance was ever spoken");
  assert.ok(
    rates.every((rate) => rate === 8),
    `utterance rates did not follow the slider: ${JSON.stringify(rates)}`,
  );
  assert.match(spoken, /^Beta marker appears here\./);
  assert.doesNotMatch(spoken, /Delta tail text/, "end word should stop the reading range");

  // The highlighted word is the one being spoken, on the right page.
  const readWords = await page.evaluate(() => window.__readWords);
  assert.ok(readWords.length > 3, `only ${readWords.length} words were highlighted`);
  assert.equal(readWords[0].word, "Beta", "highlight starts at the start anchor");
  assert.ok(
    readWords.every((entry) => !/Delta/.test(entry.word)),
    `words past the end anchor were highlighted: ${JSON.stringify(readWords.filter((w) => /Delta/.test(w.word)))}`,
  );
  assert.ok(
    readWords.every((entry) => entry.page === "2" || entry.page === "3"),
    `highlight landed on the wrong page: ${JSON.stringify(readWords.filter((w) => !["2", "3"].includes(w.page)))}`,
  );
  // The range may already have finished reading, disabling Stop mid-flight.
  await page.click("#btnStop", { timeout: 2000 }).catch(() => {});

  // ---- Highlighting a selection ----
  await page.fill("#pageInput", "1");
  await page.press("#pageInput", "Enter");
  await page.waitForFunction(() => document.querySelector("#pageInput")?.value === "1");
  await page.waitForFunction(() => document.querySelectorAll("#textLayer .ti").length > 0);
  // Move focus out of the page-number field so the tool shortcut is handled.
  await page.click("#stage", { position: { x: 5, y: 5 } });
  const selectedText = await page.evaluate(() => {
    const span = document.querySelector("#textLayer .ti");
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });

  // Picking an anchor by selecting a word on the page, instead of typing it.
  await page.click("#useStartSelection");
  assert.equal(await page.inputValue("#startWord"), selectedText.replace(/\s+/g, " ").trim());
  assert.equal(await page.inputValue("#startPage"), "1");

  // Re-select for the highlight step, which needs a live selection.
  await page.evaluate(() => {
    const span = document.querySelector("#textLayer .ti");
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press("h");
  await page.waitForFunction(() => document.querySelectorAll("#annotLayer .hl").length > 0, null, { timeout: 5000 });

  // ---- Freehand ink ----
  await page.click('.tool[data-tool="pen"]');
  // Reading scrolled the page; reset it so the drawing lands inside the viewport.
  await page.evaluate(() => {
    document.querySelector("#stage").scrollTop = 0;
  });
  const box = await page.locator("#pageWrap").boundingBox();
  assert.ok(box.y >= 0, `page top is off-screen (${box.y})`);
  await page.mouse.move(box.x + 120, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 260, { steps: 8 });
  await page.mouse.up();
  const inked = await page.evaluate(() => {
    const canvas = document.querySelector("#inkCanvas");
    const ctx = canvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
    return painted;
  });
  assert.ok(inked > 50, `ink canvas has ${inked} painted pixels`);

  // ---- Page deletion ----
  await page.click('.thumb[data-page="2"] button[data-act="delete"]');
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "2", null, { timeout: 10000 });

  // ---- Save and inspect the exported PDF ----
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.click("#btnSave"),
  ]);
  const savedPath = await download.path();
  const saved = new Uint8Array(await fs.readFile(savedPath));
  assert.equal(download.suggestedFilename(), "sample-edited.pdf");

  const task = pdfjs.getDocument({
    data: saved.slice(),
    isEvalSupported: false,
    standardFontDataUrl: FONT_DIR,
    verbosity: 0,
  });
  const exported = await task.promise;
  assert.equal(exported.numPages, 2);
  const text = [];
  for (let n = 1; n <= exported.numPages; n++) {
    const p = await exported.getPage(n);
    const content = await p.getTextContent();
    text.push(content.items.map((i) => i.str).join(" "));
  }
  await task.destroy();
  assert.match(text[0], /Chapter one/);
  assert.match(text[1], /Chapter three/);
  assert.equal(text.some((chunk) => /Chapter two/.test(chunk)), false, "deleted page is gone");

  assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
});

test("a long PDF is parsed page by page while it reads", async (t) => {
  const PAGES = 30;
  const long = await makeLongPdf(PAGES);
  const { server, origin } = await startServer(long);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  await context.addInitScript(FAKE_TTS, 12);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(
    (n) => document.querySelector("#pageTotal")?.textContent === String(n),
    String(PAGES),
    { timeout: 20000 },
  );

  // The whole document is the range: nothing to describe beyond "read it all".
  await page.fill("#startPage", "1");
  await page.fill("#endPage", String(PAGES));
  await page.waitForFunction(() => /Pages 1–30/.test(document.querySelector("#rangeStatus")?.textContent ?? ""), null, {
    timeout: 20000,
  });

  // Record every status line the panel shows, so the test does not have to win
  // a race against the voice to see how many pages had been parsed.
  await page.evaluate(() => {
    const el = document.querySelector("#rangeStatus");
    window.__statusLog = [el.textContent];
    new MutationObserver(() => window.__statusLog.push(el.textContent)).observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  await page.click("#btnReadRange");
  await page.waitForFunction(() => /Page 30 marker/.test((window.__spoken ?? []).join(" ")), null, { timeout: 30000 });
  await page.waitForFunction(() => /^Read /.test(document.querySelector("#rangeStatus")?.textContent ?? ""), null, {
    timeout: 30000,
  });

  const statusLog = await page.evaluate(() => window.__statusLog);
  const reading = statusLog
    .map((line) => /Reading · (\d+) of (\d+) pages loaded/.exec(line ?? ""))
    .filter(Boolean)
    .map((m) => ({ loaded: Number(m[1]), total: Number(m[2]) }));
  assert.ok(reading.length > 0, `no page-by-page progress reported: ${JSON.stringify(statusLog)}`);
  assert.equal(reading[0].total, PAGES);
  // Reading started after the first page, long before the rest were parsed.
  assert.ok(
    reading[0].loaded <= 3,
    `reading only started after ${reading[0].loaded} pages had been parsed`,
  );
  // The count climbs as playback moves through the document.
  for (let i = 1; i < reading.length; i++) {
    assert.ok(reading[i].loaded >= reading[i - 1].loaded, "page progress went backwards");
  }
  assert.equal(reading.at(-1).loaded, PAGES, "every page in the range was eventually read");

  const spoken = await page.evaluate(() => window.__spoken.join(" "));
  for (let n = 1; n <= PAGES; n++) {
    const hits = spoken.split(`Page ${n} marker`).length - 1;
    assert.equal(hits, 1, `page ${n} was spoken ${hits} times`);
  }
  assert.match(await page.textContent("#rangeStatus"), new RegExp(`^Read ${PAGES} of ${PAGES} pages`));
  assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
});

test("empty state and settings page load without errors", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto(`${origin}/src/viewer.html`);
  await page.waitForSelector("#emptyState:visible");
  assert.match(await page.textContent("#emptyState h1"), /Open a PDF/);
  assert.equal(await page.isDisabled("#btnSave"), true);

  await page.goto(`${origin}/src/options.html`);
  await page.waitForSelector("#autoOpenPdf");
  assert.equal(await page.isChecked("#autoOpenPdf"), true, "PDF takeover is on by default");
  assert.ok((await page.locator("#voiceURI option").count()) >= 1);
  await page.uncheck("#autoOpenPdf");
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "Saved.");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("pdfreader.settings")));
  assert.equal(stored.autoOpenPdf, false);

  assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
});

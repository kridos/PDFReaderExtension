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

/** A word hyphenated over a line break: one word to the voice, two runs on the page. */
async function makeHyphenatedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("The exam-", { x: 72, y: 720, size: 14, font });
  page.drawText("ple continues here.", { x: 72, y: 700, size: 14, font });
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
    // Same bytes, but named by the server rather than by the URL.
    if (url.pathname === "/download") {
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": "attachment; filename*=UTF-8''Quarterly%20report.pdf",
      });
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

/** The voices a machine offers unless a test asks for different ones. */
const VOICES = [{ name: "Test voice", lang: "en-US", voiceURI: "test-voice", localService: true }];
// Named to sort after the default voice: with no voice chosen the reader uses the
// first installed voice by name, and this test needs a change to be a change.
const ALT_VOICE = { name: "Zeta voice", lang: "en-US", voiceURI: "test-voice-2", localService: true };

/**
 * @param {number|{wordDelay?: number, fail?: string, silent?: boolean, failVoice?: string, drop?: number, noStart?: boolean, voices?: object[]}} options
 *   `fail` makes every utterance error with that reason, `silent` mimics Chrome
 *   swallowing an utterance without any event at all, `drop` swallows only the
 *   first N utterances (the engine-was-busy case), `failVoice` makes only
 *   utterances using that voice fail, `noStart` speaks without ever firing
 *   onstart (some installed voices do exactly that), and `voices` replaces the
 *   list of installed voices.
 */
const FAKE_TTS = (options = {}) => {
  const opts = typeof options === "number" ? { wordDelay: options } : options;
  const {
    wordDelay = 25,
    fail = "",
    silent = false,
    failVoice = "",
    drop = 0,
    noStart = false,
    // Spelled out here rather than taken from the module: this function is
    // serialised into the page, where module constants do not exist.
    voices = [{ name: "Test voice", lang: "en-US", voiceURI: "test-voice", localService: true }],
  } = opts;
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
    getVoices: () => voices,
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
      window.__voices = window.__voices || [];
      window.__voices.push(utterance.voice?.voiceURI ?? null);
      this.current = utterance;
      this.speaking = true;
      if (silent) {
        // Accepted and then forgotten: the engine reports nothing at all and
        // claims to be doing nothing, which is the "is it hung?" state.
        this.current = null;
        this.speaking = false;
        return;
      }
      // Nothing at all happens to this utterance: no start, no end, no error.
      if (window.__spoken.length <= drop) {
        this.current = null;
        this.speaking = false;
        return;
      }
      if (fail || (failVoice && utterance.voice?.voiceURI === failVoice)) {
        setTimeout(() => {
          this.speaking = false;
          utterance.onerror?.({ error: fail || "synthesis-failed" });
        }, 0);
        return;
      }
      if (!noStart) utterance.onstart?.();
      const positions = [];
      const re = /\S+/g;
      let match;
      while ((match = re.exec(utterance.text))) positions.push(match.index);
      let i = 0;
      const step = () => {
        if (this.current !== utterance) return;
        // A paused voice stays exactly where it is until it is resumed.
        if (this.paused) {
          setTimeout(step, wordDelay);
          return;
        }
        if (i >= positions.length) {
          this.speaking = false;
          utterance.onend?.();
          return;
        }
        window.__words = window.__words || [];
        window.__words.push({ text: utterance.text, charIndex: positions[i] });
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

  // The invisible text layer has to sit on top of the glyphs actually painted.
  // A flipped y offset mirrored every line, which put text selection and the
  // follow-along highlight on blank paper.
  const alignment = await page.evaluate(() => {
    const canvas = document.querySelector("#pdfCanvas");
    const rootRect = document.querySelector("#pageWrap").getBoundingClientRect();
    const scale = canvas.width / rootRect.width;
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const ink = (x0, y0, x1, y1) => {
      let n = 0;
      const X0 = Math.max(0, Math.floor(x0));
      const X1 = Math.min(canvas.width, Math.ceil(x1));
      const Y0 = Math.max(0, Math.floor(y0));
      const Y1 = Math.min(canvas.height, Math.ceil(y1));
      for (let y = Y0; y < Y1; y++) {
        for (let x = X0; x < X1; x++) {
          const i = (y * canvas.width + x) * 4;
          if (pixels[i] < 160 && pixels[i + 1] < 160 && pixels[i + 2] < 160) n++;
        }
      }
      return n;
    };
    const spans = [...document.querySelectorAll("#textLayer .ti")];
    const blank = [];
    for (const span of spans) {
      const r = span.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const inside = ink(
        (r.left - rootRect.left) * scale,
        (r.top - rootRect.top) * scale,
        (r.right - rootRect.left) * scale,
        (r.bottom - rootRect.top) * scale,
      );
      if (inside < 4) blank.push(span.textContent.slice(0, 24));
    }
    const heading = spans.find((span) => /Chapter one/.test(span.textContent));
    const headingTop = heading
      ? heading.getBoundingClientRect().top - rootRect.top
      : null;
    return { total: spans.length, blank, headingTop, pageHeight: rootRect.height };
  });
  assert.ok(alignment.total >= 3, `text layer has ${alignment.total} runs`);
  assert.equal(alignment.blank.length, 0, `text boxes over blank paper: ${JSON.stringify(alignment.blank)}`);

  assert.ok(
    alignment.headingTop !== null && alignment.headingTop < alignment.pageHeight * 0.25,
    `the heading sits ${Math.round(alignment.headingTop)}px down a ${Math.round(alignment.pageHeight)}px page`,
  );

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

  // ---- Testing one voice on its own ----
  // The button speaks a fixed sample, so a voice can be checked without a range
  // and without the page text being involved at all.
  await page.evaluate(() => {
    window.__spoken = [];
  });
  await page.click("#btnTestVoice");
  await page.waitForFunction(() => window.__spoken?.length === 1, null, { timeout: 5000 });
  assert.match(
    await page.evaluate(() => window.__spoken[0]),
    /PDF Reader will read your document aloud/,
  );
  assert.match(await page.textContent("#rangeStatus"), /started speaking/);

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

test("reading can start from a page with no stopping point", async (t) => {
  const PAGES = 30;
  const long = await makeLongPdf(PAGES);
  const { server, origin } = await startServer(long);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  await context.addInitScript(FAKE_TTS, 8);
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

  // Cleared "To page" means "keep going to the end of the document".
  await page.fill("#startPage", "12");
  await page.fill("#endPage", "");
  await page.waitForFunction(
    () => {
      const status = document.querySelector("#rangeStatus")?.textContent ?? "";
      return /Pages 12–30/.test(status) && /to the end of the document/.test(status);
    },
    null,
    { timeout: 20000 },
  );

  await page.click("#btnReadRange");
  await page.waitForFunction(() => /Page 30 marker/.test((window.__spoken ?? []).join(" ")), null, {
    timeout: 30000,
  });
  await page.waitForFunction(() => /^Read /.test(document.querySelector("#rangeStatus")?.textContent ?? ""), null, {
    timeout: 30000,
  });

  const spoken = await page.evaluate(() => window.__spoken.join(" "));
  assert.match(spoken, /^Chapter 12/, "reading starts at the page typed into From page");
  assert.doesNotMatch(spoken, /Page 11 marker/, "nothing before the start page is read");
  assert.match(await page.textContent("#rangeStatus"), new RegExp(`^Read ${PAGES - 11} of ${PAGES - 11} pages`));
  assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
});

test("a speech engine that cannot speak says why instead of going quiet", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  await context.addInitScript(FAKE_TTS, { wordDelay: 8, fail: "synthesis-failed" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, { timeout: 20000 });
  await page.fill("#startPage", "1");
  await page.waitForFunction(() => /Pages 1–3/.test(document.querySelector("#rangeStatus")?.textContent ?? ""), null, {
    timeout: 20000,
  });

  await page.click("#btnReadRange");
  await page.waitForFunction(
    () => /could not produce sound/i.test(document.querySelector("#rangeStatus")?.textContent ?? ""),
    null,
    { timeout: 15000 },
  );

  const status = await page.textContent("#rangeStatus");
  assert.match(status, /synthesis-failed/);
  assert.match(status, /different voice/i, "the message tells the user what to try");
  // The panel must not look like it is still reading. Chrome fires no end event
  // when it refuses an utterance, so without this the player stayed on \"playing\".
  assert.equal(await page.textContent("#btnPlayPause"), "▶");
  assert.equal(await page.isDisabled("#btnStop"), true);
  assert.ok(
    (await page.locator("#transcript .sentence").count()) > 0,
    "the text that was queued is still shown",
  );
  assert.equal(await page.isVisible("#toast"), true);
  assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
});

test("an engine that swallows the utterance is reported instead of hanging", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  await context.addInitScript(FAKE_TTS, { silent: true });
  const page = await context.newPage();

  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, { timeout: 20000 });
  await page.click("#btnReadRange");

  // No start, no end, no error: exactly the "is it hung?" case. Every voice is
  // tried and every attempt waits five seconds first, so this takes a while.
  await page.waitForFunction(
    () => /never started/i.test(document.querySelector("#rangeStatus")?.textContent ?? ""),
    null,
    { timeout: 45000 },
  );
  assert.equal(await page.textContent("#btnPlayPause"), "▶");
  assert.equal(await page.isDisabled("#btnStop"), true);
  const attempts = await page.evaluate(() => window.__spoken?.length ?? 0);
  assert.equal(attempts, 6, `the chunk should be tried on both voices, not ${attempts} times`);
});

test("an utterance the engine drops is spoken again instead of being reported", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  // The first utterance is accepted and then forgotten, which is what Chrome
  // does after a cancel while it is still tearing the previous one down.
  await context.addInitScript(FAKE_TTS, { wordDelay: 6, drop: 1 });
  const page = await context.newPage();

  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, { timeout: 20000 });
  await page.click("#btnReadRange");

  await page.waitForFunction(() => /^Read /.test(document.querySelector("#rangeStatus")?.textContent ?? ""), null, {
    timeout: 25000,
  });

  const spoken = await page.evaluate(() => window.__spoken.join(" "));
  assert.equal(await page.evaluate(() => window.__spoken.length > 1), true, "the chunk was never spoken again");
  assert.match(spoken, /Chapter one/, "the reading carries on after the retry");
  assert.doesNotMatch(
    await page.textContent("#rangeStatus"),
    /did not start/,
    "a dropped utterance must not be reported as a broken engine",
  );
});

test("the range preset decides where a reading starts and stops", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  await context.addInitScript(FAKE_TTS, 6);
  const page = await context.newPage();

  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, { timeout: 20000 });

  // "Word/phrase → end of its page": the To field is not used at all.
  await page.selectOption("#rangeMode", "word-to-page");
  assert.equal(await page.isDisabled("#endPage"), true, "To page is not used by this preset");
  await page.fill("#startWord", "Beta");
  await page.waitForFunction(
    () => /Page 2 · from the start word/.test(document.querySelector("#rangeStatus")?.textContent ?? ""),
    null,
    { timeout: 20000 },
  );

  await page.click("#btnReadRange");
  await page.waitForFunction(() => /^Read /.test(document.querySelector("#rangeStatus")?.textContent ?? ""), null, {
    timeout: 25000,
  });

  const spoken = await page.evaluate(() => window.__spoken.join(" "));
  assert.match(spoken, /^Beta marker appears here\./, "reading starts at the word");
  assert.match(spoken, /The plot thickens slowly and then stops\./, "the rest of that page is read");
  assert.doesNotMatch(spoken, /Gamma|Delta/, "reading stops at the end of the word's page");
  assert.match(await page.textContent("#rangeStatus"), /^Read 2 of 2 pages/);

  // Picking the plain range clears the anchors the preset no longer uses.
  await page.selectOption("#rangeMode", "whole");
  assert.equal(await page.inputValue("#startWord"), "");
  assert.equal(await page.isDisabled("#endPage"), false);
  await page.waitForFunction(() => /^Pages 1–3/.test(document.querySelector("#rangeStatus")?.textContent ?? ""), null, {
    timeout: 20000,
  });
});

test("a chosen voice that cannot speak falls back to the default voice", async (t) => {
  // The only installed voice is the chosen one, so the default voice is the next
  // thing left to try.
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  await context.addInitScript(FAKE_TTS, { wordDelay: 8, failVoice: "test-voice" });
  const page = await context.newPage();

  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll("#voiceSelect option").length > 0, null, { timeout: 10000 });
  await page.selectOption("#voiceSelect", "test-voice");

  await page.click("#btnReadRange");
  // The retry lands a tick after the first attempt is refused.
  await page.waitForFunction(() => (window.__voices ?? []).length >= 2, null, { timeout: 15000 });

  const used = await page.evaluate(() => window.__voices);
  assert.equal(used[0], "test-voice", "the picked voice is tried first");
  assert.equal(used[1], null, "the retry drops the voice that could not speak");
  const spoken = await page.evaluate(() => window.__spoken.join(" "));
  assert.match(spoken, /^Chapter one/, "reading continues with the default voice");
  assert.match(await page.textContent("#toast"), /default voice/i);
});

test("a saved copy keeps the name the server gave the file", async (t) => {
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

  await page.goto(`${origin}/src/viewer.html?file=${origin}/download`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, { timeout: 20000 });
  assert.equal(await page.textContent("#docName"), "Quarterly report.pdf");

  // Nothing was edited, so the download is a plain copy under its own name.
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.click("#btnSave"),
  ]);
  assert.equal(download.suggestedFilename(), "Quarterly report.pdf");
  assert.match(await page.textContent("#toast"), /Saved a copy as Quarterly report\.pdf\./);
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

test("a voice that never fires a start event is read, not repeated", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  // The engine takes the text and speaks it, but never reports a start.
  await context.addInitScript(FAKE_TTS, { wordDelay: 2, noStart: true });
  const page = await context.newPage();
  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, {
    timeout: 20000,
  });

  await page.click("#btnReadRange");
  await page.waitForFunction(
    () => /^Read \d+ of \d+ pages/.test(document.querySelector("#rangeStatus")?.textContent ?? ""),
    null,
    { timeout: 20000 },
  );

  const status = await page.textContent("#rangeStatus");
  assert.doesNotMatch(status, /never started|did not start/);
  const spoken = await page.evaluate(() => window.__spoken.join(" "));
  assert.match(spoken, /Chapter one/);
  // A missing start event is not a failure: nothing may be spoken twice.
  const first = spoken.indexOf("Chapter one");
  assert.equal(spoken.indexOf("Chapter one", first + 1), -1, `chunk was re-spoken: ${spoken}`);
});

test("the start button is visible and clickable in a short window", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  await context.addInitScript(FAKE_TTS, 2);
  const page = await context.newPage();
  // A laptop-sized window is short enough that the range form has to scroll.
  await page.setViewportSize({ width: 1180, height: 620 });
  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, {
    timeout: 20000,
  });

  const button = await page.evaluate(() => {
    const btn = document.querySelector("#btnReadRange");
    const rect = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      disabled: btn.disabled,
      inWindow: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 0,
      covered: !(hit === btn || btn.contains(hit)),
      hit: hit ? `${hit.tagName}.${hit.className}` : "nothing",
    };
  });
  assert.equal(button.disabled, false, "the start button never becomes usable");
  assert.ok(button.inWindow, "the start button is outside the visible window");
  assert.ok(!button.covered, `the start button is covered by ${button.hit}`);

  // The voice test is in the same fixed bar, so it is reachable without
  // scrolling the panel: further down it could not be found at all.
  const testButton = await page.evaluate(() => {
    const btn = document.querySelector("#btnTestVoice");
    if (!btn) return { missing: true };
    const rect = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      inWindow: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 0,
      covered: !(hit === btn || btn.contains(hit)),
      hit: hit ? `${hit.tagName}.${hit.className}` : "nothing",
      text: btn.textContent.trim(),
    };
  });
  assert.ok(!testButton.missing, "there is no voice test button");
  assert.ok(testButton.inWindow, "the voice test button is outside the visible window");
  assert.ok(!testButton.covered, `the voice test button is covered by ${testButton.hit}`);
  assert.equal(testButton.text, "Test voice");

  // Clicking it (which fails outright when it is covered) starts a reading.
  await page.click("#btnReadRange");
  await page.waitForFunction(() => Boolean(document.querySelector("#textLayer .w.reading")), null, {
    timeout: 15000,
  });
});

test("the reading list has room of its own and scrolls with the voice", async (t) => {
  const sample = await makeLongPdf(60);
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  await context.addInitScript(FAKE_TTS, { wordDelay: 1 });
  const page = await context.newPage();
  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "60", null, {
    timeout: 20000,
  });

  const box = await page.evaluate(() => {
    const el = document.querySelector("#transcript");
    const style = getComputedStyle(el);
    return { clientHeight: el.clientHeight, overflowY: style.overflowY, resize: style.resize };
  });
  assert.equal(box.overflowY, "auto", "the reading list is not scrollable on its own");
  assert.equal(box.resize, "vertical", "the reading list cannot be made taller");
  assert.ok(box.clientHeight >= 180, `the reading list is only ${box.clientHeight}px tall`);

  await page.click("#btnReadRange");
  await page.waitForFunction(
    () => /^Read 60 of 60 pages/.test(document.querySelector("#rangeStatus")?.textContent ?? ""),
    null,
    { timeout: 40000 },
  );
  const list = await page.evaluate(() => {
    const el = document.querySelector("#transcript");
    return { top: el.scrollTop, count: el.querySelectorAll(".sentence").length };
  });
  assert.ok(list.count > 5, `only ${list.count} sentences were listed`);
  assert.ok(list.top > 0, "the reading list never followed the voice down");
});

test("the thumbnail rail keeps the current page in the middle", async (t) => {
  const sample = await makeLongPdf(20);
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  await context.addInitScript(FAKE_TTS, 2);
  const page = await context.newPage();

  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "20", null, {
    timeout: 20000,
  });
  await page.click("#btnViewScroll");
  await page.waitForFunction(() => document.querySelectorAll("#pageStream .page").length === 20, null, {
    timeout: 15000,
  });

  await page.fill("#pageInput", "15");
  await page.press("#pageInput", "Enter");
  await page.waitForFunction(() => document.querySelector(".thumb.current")?.dataset.page === "15", null, {
    timeout: 15000,
  });
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector(".thumb.current canvas");
      return Boolean(canvas && canvas.width > 0);
    },
    null,
    { timeout: 15000 },
  );

  const geometry = await page.evaluate(() => {
    const rail = document.querySelector("#thumbs");
    const card = document.querySelector(".thumb.current");
    const railRect = rail.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      offset: cardRect.top + cardRect.height / 2 - (railRect.top + railRect.height / 2),
      visible: cardRect.top >= railRect.top - 1 && cardRect.bottom <= railRect.bottom + 1,
      scrollTop: rail.scrollTop,
      previewWidth: card.querySelector("canvas").width,
    };
  });

  assert.ok(geometry.scrollTop > 0, "the rail did not follow the page that is shown");
  assert.ok(geometry.visible, "the current page is outside the visible part of the rail");
  assert.ok(
    Math.abs(geometry.offset) < 60,
    `the current page sits ${Math.round(geometry.offset)}px from the middle of the rail`,
  );
  assert.ok(geometry.previewWidth <= 120, `the preview is ${geometry.previewWidth}px wide`);
});

test("the layout toggle stacks every page and keeps the page number in step", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  await context.addInitScript(FAKE_TTS, 6);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, { timeout: 20000 });
  assert.equal(await page.isVisible("#pageWrap"), true, "the page layout starts on one page");
  assert.equal(await page.isVisible("#pageStream"), false);

  await page.click("#btnViewScroll");
  await page.waitForFunction(() => document.querySelectorAll("#pageStream .page").length === 3, null, { timeout: 10000 });
  assert.equal(await page.isVisible("#pageWrap"), false);
  assert.equal(await page.getAttribute("#btnViewScroll", "aria-pressed"), "true");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("pdfreader.settings")));
  assert.equal(stored.viewMode, "scroll", "the layout choice is remembered");

  // Every page has its own text layer, and the one for page 2 is rendered.
  await page.waitForFunction(
    () => document.querySelectorAll('#pageStream .page[data-page="2"] .text-layer .w').length > 0,
    null,
    { timeout: 15000 },
  );
  const firstWords = await page.textContent('#pageStream .page[data-page="2"] .text-layer');
  assert.match(firstWords, /Beta marker appears here\./, "page 2 has its own selectable text");

  // Jumping to a page scrolls it to the top of the stage.
  await page.fill("#pageInput", "3");
  await page.press("#pageInput", "Enter");
  await page.waitForFunction(
    () => {
      const stage = document.querySelector("#stage").getBoundingClientRect();
      const third = document.querySelector('#pageStream .page[data-page="3"]');
      return Boolean(third) && Math.abs(third.getBoundingClientRect().top - stage.top) < 40;
    },
    null,
    { timeout: 10000 },
  );
  assert.equal(await page.inputValue("#pageInput"), "3");
  await page.waitForFunction(
    () => document.querySelectorAll('#pageStream .page[data-page="3"] .text-layer .w').length > 0,
    null,
    { timeout: 15000 },
  );
  assert.match(await page.textContent('#pageStream .page[data-page="3"] .text-layer'), /Gamma marker/);

  // Back to one page at a time, still on page 3.
  await page.click("#btnViewPaged");
  await page.waitForSelector("#pageWrap:not([hidden])");
  assert.equal(await page.isVisible("#pageStream"), false);
  await page.waitForFunction(
    () => (document.querySelector("#pdfCanvas")?.width ?? 0) > 300,
    null,
    { timeout: 15000 },
  );
  assert.equal(await page.inputValue("#pageInput"), "3");
  assert.match(await page.textContent("#textLayer"), /Gamma marker/, "the page layout follows the scroll position");

  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
});

test("a highlight can be added from the continuous layout", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  await context.addInitScript(FAKE_TTS, 6);
  const page = await context.newPage();

  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, { timeout: 20000 });
  await page.click("#btnViewScroll");
  await page.waitForFunction(
    () => document.querySelectorAll('#pageStream .page[data-page="2"] .text-layer .w').length > 0,
    null,
    { timeout: 15000 },
  );

  await page.click('.tool[data-tool="highlight"]');
  await page.evaluate(() => {
    const word = document.querySelector('#pageStream .page[data-page="2"] .text-layer .w');
    const range = document.createRange();
    range.selectNodeContents(word);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  await page.waitForFunction(
    () => document.querySelectorAll('#pageStream .page[data-page="2"] .annot-layer .hl').length > 0,
    null,
    { timeout: 10000 },
  );
  const others = await page.evaluate(
    () => document.querySelectorAll('#pageStream .page:not([data-page="2"]) .annot-layer .hl').length,
  );
  assert.equal(others, 0, "the highlight belongs to the page it was drawn on");
  assert.match(await page.textContent("#toast"), /Highlight added\./);
});

test("the toolbar can choose whether PDF links open in the reader", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const page = await browser.newPage();
  await page.goto(`${origin}/src/viewer.html`);
  await page.waitForSelector("#emptyState:visible");

  assert.equal(await page.getAttribute("#btnAutoOpen", "aria-pressed"), "true", "PDFs are taken over by default");
  await page.click("#btnAutoOpen");
  assert.equal(await page.getAttribute("#btnAutoOpen", "aria-pressed"), "false");
  assert.match(await page.textContent("#toast"), /open in Chrome's viewer/);
  assert.match(await page.textContent("#autoOpenHint"), /Chrome's own viewer/);
  let stored = await page.evaluate(() => JSON.parse(localStorage.getItem("pdfreader.settings")));
  assert.equal(stored.autoOpenPdf, false);

  // The choice is what the service worker reads on the next PDF link.
  await page.reload();
  await page.waitForSelector("#emptyState:visible");
  assert.equal(await page.getAttribute("#btnAutoOpen", "aria-pressed"), "false");
  assert.match(await page.textContent("#autoOpenHint"), /Chrome's own viewer/);

  await page.click("#btnAutoOpen");
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem("pdfreader.settings")));
  assert.equal(stored.autoOpenPdf, true);
  assert.equal(await page.getAttribute("#btnAutoOpen", "aria-pressed"), "true");
});

test("pages far down the scrolling column are released and drawn again on the way back", async (t) => {
  const sample = await makeLongPdf(12);
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const page = await browser.newPage();
  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "12", null, { timeout: 20000 });
  await page.click("#btnViewScroll");
  await page.waitForFunction(() => document.querySelectorAll("#pageStream .page").length === 12, null, { timeout: 10000 });
  await page.waitForFunction(
    () => (document.querySelector('#pageStream .page[data-page="1"] .pdf-canvas')?.width ?? 0) > 300,
    null,
    { timeout: 20000 },
  );

  // Jump to the end: the first page is now far away and its bitmap is freed.
  await page.fill("#pageInput", "12");
  await page.press("#pageInput", "Enter");
  await page.waitForFunction(
    () => document.querySelectorAll('#pageStream .page[data-page="12"] .text-layer .w').length > 0,
    null,
    { timeout: 20000 },
  );
  await page.waitForFunction(
    () => (document.querySelector('#pageStream .page[data-page="1"] .pdf-canvas')?.width ?? 0) === 0,
    null,
    { timeout: 15000 },
  );

  // Coming back draws it again from scratch.
  await page.fill("#pageInput", "1");
  await page.press("#pageInput", "Enter");
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('#pageStream .page[data-page="1"] .pdf-canvas');
      const words = document.querySelectorAll('#pageStream .page[data-page="1"] .text-layer .w');
      return (canvas?.width ?? 0) > 300 && words.length > 0;
    },
    null,
    { timeout: 20000 },
  );
  assert.match(await page.textContent('#pageStream .page[data-page="1"] .text-layer'), /Page 1 marker/);
});

test("a page engine that never starts hands the reading to the system speech service", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  // The page's speech engine takes every chunk and never says a word.
  await context.addInitScript(FAKE_TTS, { silent: true });
  // The system service is a different way in, and its events are shaped
  // differently, so the handover is exercised for real.
  await context.addInitScript(() => {
    const service = {
      tts: {
        stop() {},
        pause() {},
        resume() {},
        speak(text, options, callback) {
          window.__systemSpoken = window.__systemSpoken || [];
          window.__systemSpoken.push(text);
          setTimeout(() => options.onEvent({ type: "start" }), 5);
          setTimeout(() => options.onEvent({ type: "end" }), 15);
          callback?.();
        },
      },
      runtime: {},
    };
    try {
      window.chrome = service;
    } catch {
      Object.defineProperty(window, "chrome", { value: service, configurable: true });
    }
  });
  const page = await context.newPage();
  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, {
    timeout: 20000,
  });
  await page.click("#btnReadRange");
  await page.waitForFunction(() => (window.__systemSpoken?.length ?? 0) > 0, null, { timeout: 60000 });
  assert.match(await page.evaluate(() => window.__systemSpoken.join(" ")), /Chapter one/);
  // The handover is announced, rather than the panel looking stuck or failed.
  assert.match(
    await page.evaluate(() => document.querySelector("#toast")?.textContent ?? ""),
    /system's own speech service/i,
  );
  assert.doesNotMatch(await page.textContent("#rangeStatus"), /never started/);
});

test("a word hyphenated over a line break is highlighted on both lines", async (t) => {
  const sample = await makeHyphenatedPdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  // Speaks the sentence and reports one boundary, at the joined word, so the
  // highlight stays there long enough to be inspected.
  await context.addInitScript(() => {
    class FakeUtterance {
      constructor(text) {
        this.text = text;
      }
    }
    window.SpeechSynthesisUtterance = FakeUtterance;
    const synth = {
      speaking: false,
      paused: false,
      pending: false,
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
        this.current = utterance;
        this.speaking = true;
        utterance.onstart?.();
        // "The example …": index 4 is the joined word.
        setTimeout(() => utterance.onboundary?.({ name: "word", charIndex: 4 }), 20);
      },
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "1", null, {
    timeout: 20000,
  });
  await page.click("#btnReadRange");
  await page.waitForFunction(() => document.querySelectorAll("#textLayer .w.reading").length === 2, null, {
    timeout: 15000,
  });
  const parts = await page.evaluate(() => {
    const words = [...document.querySelectorAll("#textLayer .w.reading")];
    return words.map((el) => ({ text: el.textContent, top: el.getBoundingClientRect().top }));
  });
  assert.deepEqual(parts.map((part) => part.text), ["exam", "ple"]);
  assert.ok(
    Math.abs(parts[0].top - parts[1].top) > 8,
    `both halves were highlighted on one line: ${JSON.stringify(parts)}`,
  );
});

test("a paused reading carries on from its place instead of starting over", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  await context.addInitScript(FAKE_TTS, 50);
  const page = await context.newPage();

  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, {
    timeout: 20000,
  });
  await page.click("#btnReadRange");
  await page.waitForFunction(() => (window.__words?.length ?? 0) >= 2, null, { timeout: 20000 });

  // Pause with the play button, which used to stay disabled for the whole
  // reading and left “Start reading” — which begins at the top — as the only way
  // to hear anything again.
  await page.click("#btnPlayPause");
  assert.equal(await page.isDisabled("#btnPlayPause"), false, "play is available while paused");
  assert.equal(
    await page.getAttribute("#btnPlayPause", "aria-label"),
    "Resume from where it stopped (space)",
  );
  assert.match(await page.textContent("#rangeStatus"), /^Paused/);
  assert.equal(await page.textContent("#btnReadRange"), "Start over", "the big button says it starts over");

  const paused = await page.evaluate(() => window.__words.length);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__words.length), paused, "the voice read on while paused");

  await page.click("#btnPlayPause");
  await page.waitForFunction((count) => window.__words.length > count, paused, { timeout: 10000 });
  assert.match(await page.textContent("#rangeStatus"), /^Reading/);

  // Resumed, not restarted: the first sentence is not spoken a second time.
  const spoken = await page.evaluate(() => window.__spoken);
  assert.equal(
    spoken.filter((text) => text.startsWith("Chapter one")).length,
    1,
    `the reading started over: ${JSON.stringify(spoken)}`,
  );
});

test("the voice can be changed while it is reading", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  await context.addInitScript(FAKE_TTS, { wordDelay: 50, voices: [VOICES[0], ALT_VOICE] });
  const page = await context.newPage();

  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, {
    timeout: 20000,
  });
  await page.waitForFunction(() => document.querySelectorAll("#voiceSelect option").length >= 3, null, {
    timeout: 10000,
  });
  await page.click("#btnReadRange");
  // Far enough into the sentence that the rest is a genuine remainder.
  await page.waitForFunction(() => (window.__words?.length ?? 0) >= 3, null, { timeout: 20000 });

  const before = await page.evaluate(() => ({
    said: window.__spoken.length,
    text: window.__spoken.at(-1),
    voice: window.__voices.at(-1),
  }));
  assert.equal(before.voice, "test-voice", "the reading starts on the installed default voice");

  await page.selectOption("#voiceSelect", "test-voice-2");
  await page.waitForFunction((count) => (window.__voices ?? []).length > count, before.said, {
    timeout: 15000,
  });

  const { spoken, used } = await page.evaluate(() => ({ spoken: window.__spoken, used: window.__voices }));
  assert.equal(used.at(-1), "test-voice-2", "the new voice is used at once");
  // The sentence is queued again from the word it had reached, so the new voice
  // takes over mid-sentence rather than after it.
  const tail = spoken.at(-1);
  assert.ok(
    before.text.length > tail.length && before.text.endsWith(tail),
    `the rest of the sentence was not re-queued: ${JSON.stringify(spoken)}`,
  );
});

test("the invisible text is set in the page's own font, so the highlight covers the word", async (t) => {
  const doc = await PDFDocument.create();
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const pdfPage = doc.addPage([612, 792]);
  pdfPage.drawText("Serif words line up with the ink", { x: 72, y: 700, size: 18, font: serif });
  const sample = new Uint8Array(await doc.save());

  const { server, origin } = await startServer(sample);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const context = await browser.newContext();
  await context.addInitScript(FAKE_TTS);
  const page = await context.newPage();

  await page.goto(`${origin}/src/viewer.html?file=${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "1", null, {
    timeout: 20000,
  });
  await page.waitForFunction(() => document.querySelectorAll("#textLayer .w").length >= 7, null, {
    timeout: 20000,
  });

  const measured = await page.evaluate(() => {
    const rootRect = document.querySelector("#pageWrap").getBoundingClientRect();
    const canvas = document.querySelector("#pdfCanvas");
    const scale = canvas.width / rootRect.width;
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const dark = (x, y) => {
      const i = (y * canvas.width + x) * 4;
      return pixels[i] < 160 && pixels[i + 1] < 160 && pixels[i + 2] < 160;
    };
    // The fourth word sits in the middle of the line, where a text layer set in
    // the wrong font has drifted furthest from the glyphs.
    const word = [...document.querySelectorAll("#textLayer .w")][3];
    const box = word.getBoundingClientRect();
    const y0 = Math.max(0, Math.floor((box.top - rootRect.top) * scale));
    const y1 = Math.min(canvas.height, Math.ceil((box.bottom - rootRect.top) * scale));
    const x0 = Math.floor((box.left - rootRect.left - 18) * scale);
    const x1 = Math.ceil((box.right - rootRect.left + 18) * scale);
    const ink = [];
    for (let x = Math.max(0, x0); x < x1; x++) {
      let found = false;
      for (let y = y0; y < y1 && !found; y++) found = dark(x, y);
      ink.push(found);
    }
    // Letters are a pixel or two apart, words several; the runs are words.
    const gap = Math.max(4, Math.round(5 * scale));
    const runs = [];
    let start = -1;
    let last = -1;
    for (let i = 0; i < ink.length; i++) {
      if (ink[i]) {
        if (start < 0) start = i;
        last = i;
      } else if (start >= 0 && i - last >= gap) {
        runs.push([start, last + 1]);
        start = -1;
      }
    }
    if (start >= 0) runs.push([start, last + 1]);
    const centre = ((box.left + box.right) / 2 - rootRect.left) * scale - Math.max(0, x0);
    const nearest = runs.sort(
      (a, b) => Math.abs((a[0] + a[1]) / 2 - centre) - Math.abs((b[0] + b[1]) / 2 - centre),
    )[0];
    return {
      family: getComputedStyle(document.querySelector("#textLayer .ti")).fontFamily,
      word: word.textContent,
      ink: nearest ? [nearest[0] + Math.max(0, x0), nearest[1] + Math.max(0, x0)] : null,
      box: [
        Math.round((box.left - rootRect.left) * scale),
        Math.round((box.right - rootRect.left) * scale),
      ],
    };
  });

  assert.match(measured.family, /serif/, `the text layer uses ${measured.family}`);
  assert.ok(measured.ink, `no ink found near “${measured.word}”`);
  const [inkLeft, inkRight] = measured.ink;
  const [boxLeft, boxRight] = measured.box;
  assert.ok(
    Math.abs(inkLeft - boxLeft) <= 6 && Math.abs(inkRight - boxRight) <= 6,
    `highlight box ${boxLeft}..${boxRight} does not cover the ink ${inkLeft}..${inkRight} for “${measured.word}”`,
  );
});

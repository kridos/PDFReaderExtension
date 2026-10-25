// Loads the unpacked extension in full Chromium (headless) and drives both
// halves of it: PDF interception into the viewer, and the injected page reader.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { chromium } from "playwright";

const ROOT = path.join(import.meta.dirname, "..");
const READER_FILES = ["src/lib/range.core.js", "src/lib/reader.core.js", "src/content/page-reader.js"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".icc": "application/octet-stream",
};

const ARTICLE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Reading test article</title></head>
  <body>
    <nav><a href="/">NavigationHomeAbout</a></nav>
    <article>
      <h1>Reading test article</h1>
      <p>
        Alpha intro sentence sits here. The river was cold that morning, and the
        boatman said nothing at all as the mist lifted off the water.
      </p>
      <p>
        Filler paragraph one exists only to give the reader enough text to prefer
        the article element over the whole document body when it extracts.
      </p>
      <p>
        Filler paragraph two keeps going for a little while longer so the word
        count is comfortably above the threshold used by the extractor.
      </p>
      <p>Beta marker appears here. The plot thickens slowly.</p>
      <p>Gamma marker closes the story. Delta tail text should never be read.</p>
      <div style="display:none">HiddenWords should be skipped.</div>
      <p hidden>AlsoHiddenWords</p>
      <button type="button">ButtonNoise</button>
    </article>
    <script>var ScriptNoise = "ScriptNoise";</script>
  </body>
</html>`;

const DOWNLOAD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Downloads</title></head>
<body>
  <a id="attached" href="/attachment.pdf">Download the report</a>
  <a id="forced" href="/sample.pdf" download>Save this PDF</a>
</body></html>`;

async function makeSamplePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const index of [1, 2, 3]) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Page ${index}`, { x: 72, y: 720, size: 18, font });
    page.drawText(`Body text for page ${index}.`, { x: 72, y: 690, size: 12, font });
  }
  return new Uint8Array(await doc.save());
}

async function startServer(sample) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/sample.pdf" || url.pathname === "/no-extension") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(Buffer.from(sample));
      return;
    }
    if (url.pathname === "/attachment.pdf") {
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": "attachment; filename*=UTF-8''Quarterly%20report.pdf",
      });
      res.end(Buffer.from(sample));
      return;
    }
    if (url.pathname === "/download.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DOWNLOAD_PAGE);
      return;
    }
    if (url.pathname === "/article" || url.pathname === "/article-tt") {
      const headers = { "content-type": "text/html; charset=utf-8" };
      if (url.pathname === "/article-tt") {
        headers["content-security-policy"] = "require-trusted-types-for 'script'";
      }
      res.writeHead(200, headers);
      res.end(ARTICLE);
      return;
    }
    try {
      const filePath = path.join(ROOT, decodeURIComponent(url.pathname));
      const data = await fs.readFile(filePath);
      res.writeHead(200, { "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function launchExtension() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "pdfreader-profile-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      "--no-first-run",
    ],
  });
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30000 }));
  return {
    context,
    worker,
    extensionId: new URL(worker.url()).host,
    cleanup: async () => {
      await context.close();
      await fs.rm(profile, { recursive: true, force: true });
    },
  };
}

const FAKE_TTS = () => {
  class FakeUtterance {
    constructor(text) {
      this.text = text;
    }
  }
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
    pause() {},
    resume() {},
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
      const tick = () => {
        if (this.current !== utterance) return;
        if (i >= positions.length) {
          this.speaking = false;
          utterance.onend?.();
          return;
        }
        utterance.onboundary?.({ name: "word", charIndex: positions[i] });
        i++;
        setTimeout(tick, 30);
      };
      setTimeout(tick, 0);
    },
  };
  // speechSynthesis is a read-only accessor on Window.prototype.
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = FakeUtterance;
  window.__stubTts = true;
};

test("the loaded extension intercepts PDFs and opens its viewer", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const { context, worker, extensionId, cleanup } = await launchExtension();

  t.after(async () => {
    await cleanup();
    await new Promise((resolve) => server.close(resolve));
  });

  // No URL rewriting: a rule cannot tell a PDF to display from one to save, and
  // hijacking .pdf URLs made download links open the viewer instead.
  const permissions = await worker.evaluate(() => chrome.runtime.getManifest().permissions);
  assert.equal(permissions.includes("declarativeNetRequest"), false);

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));

  // 1. A PDF opened as a page is taken over from its response headers.
  await page.goto(`${origin}/sample.pdf`);
  await page.waitForURL(
    (url) => url.href.startsWith("chrome-extension://") && url.pathname.endsWith("/src/viewer.html"),
    { timeout: 20000 },
  );
  const viewerUrl = new URL(page.url());
  assert.equal(viewerUrl.host, extensionId);
  assert.equal(viewerUrl.searchParams.get("file"), `${origin}/sample.pdf`);
  await page.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, {
    timeout: 30000,
  });

  // 2. A download link saves the file instead of opening the viewer.
  const downloads = await context.newPage();
  await downloads.goto(`${origin}/download.html`);
  const [attached] = await Promise.all([
    downloads.waitForEvent("download", { timeout: 20000 }),
    downloads.click("#attached"),
  ]);
  assert.equal(attached.suggestedFilename(), "Quarterly report.pdf");
  assert.equal(new URL(downloads.url()).pathname, "/download.html", "the tab stayed on the page");

  // The download attribute means the same thing, even for a .pdf URL.
  const forced = await context.newPage();
  await forced.goto(`${origin}/download.html`);
  const [saved] = await Promise.all([
    forced.waitForEvent("download", { timeout: 20000 }),
    forced.click("#forced"),
  ]);
  assert.equal(saved.suggestedFilename(), "sample.pdf");
  assert.equal(new URL(forced.url()).pathname, "/download.html", "the tab stayed on the page");

  // 3. Turning the setting off leaves PDFs to the browser.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options.html`);
  await options.waitForSelector("#autoOpenPdf");
  await options.uncheck("#autoOpenPdf");
  await options.waitForFunction(() => document.querySelector("#status")?.textContent === "Saved.");
  const untouched = await context.newPage();
  await untouched.goto(`${origin}/sample.pdf`).catch(() => {});
  await untouched.waitForTimeout(1500);
  assert.equal(
    untouched.url().startsWith("chrome-extension://"),
    false,
    "a PDF is not taken over when the setting is off",
  );
  await untouched.close();

  await options.check("#autoOpenPdf");
  await options.waitForFunction(() => document.querySelector("#status")?.textContent === "Saved.");

  // 4. A PDF served from a URL without a .pdf suffix is caught too.
  const extensionless = await context.newPage();
  await extensionless.goto(`${origin}/no-extension`);
  await extensionless.waitForURL(
    (url) => url.href.startsWith("chrome-extension://") && url.pathname.endsWith("/src/viewer.html"),
    { timeout: 20000 },
  );
  await extensionless.waitForFunction(() => document.querySelector("#pageTotal")?.textContent === "3", null, {
    timeout: 30000,
  });

  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
});

test("the page reader extracts a web page and reads between word anchors", async (t) => {
  const sample = await makeSamplePdf();
  const { server, origin } = await startServer(sample);
  const { context, worker, cleanup } = await launchExtension();

  t.after(async () => {
    await cleanup();
    await new Promise((resolve) => server.close(resolve));
  });

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`${origin}/article`);
  const tabId = await worker.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === target)?.id ?? null;
  }, `${origin}/article`);
  assert.ok(tabId, "article tab is visible to the extension");

  // A stub synthesiser has to live in the extension's isolated world, where the
  // injected reader runs.
  await worker.evaluate(
    async ({ tabId: id, source }) => {
      // Wrapped in an IIFE so executeScript actually runs the body.
      await chrome.scripting.executeScript({ target: { tabId: id }, func: new Function(`(${source})()`) });
    },
    { tabId, source: FAKE_TTS.toString() },
  );
  const stubReady = await worker.evaluate(async ({ tabId: id }) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: () => window.__stubTts === true,
    });
    return result.result;
  }, { tabId });
  assert.equal(stubReady, true, "the test synthesiser is installed in the reader's world");
  const injected = await worker.evaluate(
    async ({ tabId: id, files }) => {
      await chrome.scripting.executeScript({ target: { tabId: id }, files });
      return true;
    },
    { tabId, files: READER_FILES },
  );
  assert.equal(injected, true);

  await page.waitForFunction(
    () => {
      const host = document.getElementById("pdfreader-host");
      return Boolean(host?.shadowRoot?.querySelector(".status")?.textContent.match(/words/));
    },
    null,
    { timeout: 15000 },
  );

  const extracted = await worker.evaluate(async ({ tabId: id }) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: () => globalThis.__PDFREADER__.pageReader.getText(),
    });
    return result.result;
  }, { tabId });
  assert.match(extracted, /Alpha intro sentence/);
  assert.match(extracted, /Gamma marker closes the story/);
  for (const noise of ["HiddenWords", "AlsoHiddenWords", "ButtonNoise", "ScriptNoise", "NavigationHomeAbout"]) {
    assert.doesNotMatch(extracted, new RegExp(noise), `${noise} should not be extracted`);
  }

  // The panel's speed slider reaches 8× and is honoured when speaking.
  const panelSpeed = await page.evaluate(() => {
    const root = document.getElementById("pdfreader-host").shadowRoot;
    const el = root.querySelector(".rate");
    const ceiling = el.max;
    el.value = "8";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ceiling, label: root.querySelector(".rate-out").textContent };
  });
  assert.equal(panelSpeed.ceiling, "8", "page-reader speed slider should top out at 8×");
  assert.equal(panelSpeed.label, "8.0×");

  // Anchors typed into the panel.
  await page.evaluate(() => {
    const root = document.getElementById("pdfreader-host").shadowRoot;
    const start = root.querySelector(".start-word");
    const end = root.querySelector(".end-word");
    start.value = "Beta";
    start.dispatchEvent(new Event("input", { bubbles: true }));
    end.value = "Gamma";
    end.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(
    () =>
      document.getElementById("pdfreader-host")?.shadowRoot?.querySelector(".status")?.textContent.includes("words"),
    null,
    { timeout: 10000 },
  );

  await page.locator("#pdfreader-host .read").click();

  const spokenOf = () =>
    worker.evaluate(async ({ tabId: id }) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => (window.__spoken || []).join(" "),
      });
      return result.result;
    }, { tabId });

  let spoken = "";
  for (let i = 0; i < 60; i++) {
    spoken = await spokenOf();
    if (spoken.length) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(spoken, /^Beta marker appears here\./);
  assert.match(spoken, /Gamma$/, "reading stops right after the end word");
  assert.doesNotMatch(spoken, /closes the story/, "end anchor should stop the reading");
  assert.doesNotMatch(spoken, /Delta tail text/, "text after the end anchor is never read");
  assert.doesNotMatch(spoken, /Alpha intro/, "text before the start anchor is never read");

  const pageRates = await worker.evaluate(async ({ tabId: id }) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: () => window.__rates || [],
    });
    return result.result;
  }, { tabId });
  assert.ok(pageRates.length > 0, "no utterance was spoken with a rate");
  assert.ok(
    pageRates.every((rate) => rate === 8),
    `page reader ignored the 8× slider: ${JSON.stringify(pageRates)}`,
  );

  // The followed word is highlighted through the CSS Custom Highlight API.
  let highlighted = false;
  for (let i = 0; i < 40; i++) {
    highlighted = await page.evaluate(() => CSS.highlights.has("pdfreader-word"));
    if (highlighted) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(highlighted, true, "current word is highlighted on the page");

  // The toolbar toggle hides the panel and stops the reading.
  const toggledOff = await worker.evaluate(
    async ({ tabId: id }) => chrome.tabs.sendMessage(id, { type: "pdfreader:toggle" }),
    { tabId },
  );
  assert.equal(toggledOff.open, false);
  assert.equal(await page.locator("#pdfreader-host").isVisible(), false);

  // Sharing the same files again re-opens the existing panel instead of duplicating it.
  await worker.evaluate(
    async ({ tabId: id, files }) => {
      await chrome.scripting.executeScript({ target: { tabId: id }, files });
    },
    { tabId, files: READER_FILES },
  );
  assert.equal(await page.locator("#pdfreader-host").isVisible(), true);
  assert.equal(await page.locator("#pdfreader-host").count(), 1, "one panel host only");

  // Trusted Types pages block innerHTML, so the panel is built through DOMParser.
  const strict = await context.newPage();
  const strictErrors = [];
  strict.on("pageerror", (err) => strictErrors.push(err.message));
  await strict.goto(`${origin}/article-tt`);
  const trustedTypesEnforced = await strict.evaluate(() => {
    try {
      const probe = document.createElement("div");
      probe.innerHTML = "<b>probe</b>";
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(trustedTypesEnforced, true, "test page really enforces Trusted Types");
  const strictTab = await worker.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === target)?.id ?? null;
  }, `${origin}/article-tt`);
  assert.ok(strictTab, "Trusted Types tab is visible to the extension");
  await worker.evaluate(
    async ({ tabId: id, files }) => {
      await chrome.scripting.executeScript({ target: { tabId: id }, files });
    },
    { tabId: strictTab, files: READER_FILES },
  );
  await strict.waitForFunction(
    () =>
      Boolean(
        document.getElementById("pdfreader-host")?.shadowRoot?.querySelector(".status")?.textContent.match(/words/),
      ),
    null,
    { timeout: 15000 },
  );
  assert.deepEqual(strictErrors, [], `Trusted Types page errors: ${strictErrors.join(" | ")}`);

  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
});

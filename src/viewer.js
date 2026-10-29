import * as pdfjs from "./vendor/pdfjs/pdf.mjs";
import { buildPageText } from "./lib/pdftext.js";
import { createRangeReader, normalizeQuery } from "./lib/range.js";
import { buildEditedPdf } from "./lib/exporter.js";
import { Reader } from "./lib/reader.js";
import { loadSettings, saveSettings } from "./lib/settings.js";

const VENDOR = new URL("./vendor/pdfjs/", import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;

const $ = (id) => document.getElementById(id);
const ui = {
  stage: $("stage"),
  pageWrap: $("pageWrap"),
  canvas: $("pdfCanvas"),
  inkCanvas: $("inkCanvas"),
  textLayer: $("textLayer"),
  annotLayer: $("annotLayer"),
  empty: $("emptyState"),
  docName: $("docName"),
  pageInput: $("pageInput"),
  pageTotal: $("pageTotal"),
  pageCountLabel: $("pageCountLabel"),
  thumbs: $("thumbs"),
  zoomLabel: $("btnZoomLabel"),
  colorInput: $("colorInput"),
  rangeStatus: $("rangeStatus"),
  rangeMode: $("rangeMode"),
  startPage: $("startPage"),
  endPage: $("endPage"),
  startWord: $("startWord"),
  endWord: $("endWord"),
  readRange: $("btnReadRange"),
  stop: $("btnStop"),
  playPause: $("btnPlayPause"),
  rate: $("rate"),
  rateLabel: $("rateLabel"),
  voiceSelect: $("voiceSelect"),
  transcript: $("transcript"),
  progressLabel: $("progressLabel"),
  readerPanel: $("readerPanel"),
  toast: $("toast"),
  dropHint: $("dropHint"),
  fileInput: $("fileInput"),
  save: $("btnSave"),
  undo: $("btnUndo"),
  prevPage: $("btnPrevPage"),
  nextPage: $("btnNextPage"),
  btnReader: $("btnReader"),
  stream: $("pageStream"),
  btnViewPaged: $("btnViewPaged"),
  btnViewScroll: $("btnViewScroll"),
  btnAutoOpen: $("btnAutoOpen"),
  autoOpenHint: $("autoOpenHint"),
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const clampInt = (value, min, max) => clamp(Math.round(Number(value) || min), min, max);
const uid = () => Math.random().toString(36).slice(2, 10);

const state = {
  doc: null,
  bytes: null,
  fileName: "document.pdf",
  pageNumber: 1,
  scale: 1,
  zoomMode: "fit",
  tool: "select",
  color: "#facc15",
  rotations: {},
  pageOrder: [],
  annotations: [],
  history: [],
  future: [],
  dirty: false,
  settings: {},
  range: null,
  chunks: [],
  lastWord: null,
  viewMode: "paged",
};

let liveStroke = null;
let followBusy = false;
let transcriptEls = [];
let toastTimer = 0;
let previewTimer = 0;
let previewSeq = 0;
let thumbToken = 0;

const pageCache = new Map();
const textCache = new Map();

const reader = new Reader({
  onState: (s) => {
    const playing = s === "playing";
    ui.playPause.textContent = playing ? "❚❚" : "▶";
    ui.stop.disabled = s === "idle" || s === "ended";
    if (s === "ended") {
      ui.progressLabel.textContent = "Finished";
      // The summary waits for the voice to drain: the text being loaded is not
      // the same thing as the range having been read out.
      reportReadingFinished();
    }
  },
  onProgress: ({ absolute, chunkIndex }) => {
    followReading(absolute);
    updateTranscriptProgress(chunkIndex);
    // Top up before the voice runs dry, so the next page is ready in time.
    if (feed && reader.chunks.length - reader.index <= 1) void pumpReading();
  },
  onStarved: () => void pumpReading(),
  onError: ({ reason }) => reportSpeechFailure(reason),
  onVoiceFallback: ({ stage } = {}) =>
    toast(
      stage === 2
        ? "That voice could not speak here, so the browser's default voice is being used instead."
        : "That voice could not speak here, so a voice installed on this computer is being used instead.",
      6000,
    ),
});

/**
 * The speech engine refusing to speak is otherwise invisible: the panel empties
 * its queue and looks idle with no sound and no explanation.
 */
function reportSpeechFailure(reason) {
  // Nothing is being read any more: stop pulling pages in, and keep the status
  // line from being overwritten by a progress update.
  if (feed) {
    feed.finished = true;
    feed = null;
  }
  const voices = Reader.supported ? window.speechSynthesis.getVoices().length : 0;
  let message;
  if (!voices) {
    message = "This browser has no voices installed, so nothing can be read aloud. Install a text-to-speech voice in your system settings.";
  } else if (reason === "did-not-start") {
    message = `The speech engine never started (${voices} voice${voices === 1 ? "" : "s"} found), not even with a voice installed on this machine. Reload the tab, then press play again.`;
  } else if (reason === "stalled") {
    message = "The speech engine stopped reporting progress mid-sentence. Press play again, or pick a different voice in Settings.";
  } else if (reason === "not-allowed") {
    message = "The browser blocked speech. Click the page, then press play again.";
  } else if (reason === "synthesis-failed" || reason === "voice-unavailable") {
    message = `The speech engine could not produce sound (${reason}). Pick a different voice in Settings, or slow the speed down.`;
  } else {
    message = `Speech stopped: ${reason}. Try another voice in Settings.`;
  }
  setRangeStatus(message, "error");
  toast(message, 7000);
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function toast(message, ms = 3400) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, ms);
}

function setRangeStatus(message, kind = "") {
  ui.rangeStatus.textContent = message;
  ui.rangeStatus.classList.toggle("error", kind === "error");
  ui.rangeStatus.classList.toggle("ok", kind === "ok");
}

/** pdf.js' Util.transform, inlined so we do not depend on that internal export. */
function combine(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

const measureCanvas = document.createElement("canvas");
const measureCtx = measureCanvas.getContext("2d");
measureCtx.font = "100px sans-serif";
const ASCENT = (() => {
  const metrics = measureCtx.measureText("Hxgp");
  const asc = metrics.fontBoundingBoxAscent;
  const desc = metrics.fontBoundingBoxDescent;
  return asc && asc + desc > 0 ? asc / (asc + desc) : 0.8;
})();
function measureWidth(text, sizePx) {
  return (measureCtx.measureText(text).width / 100) * sizePx;
}

const pageBox = (page) => {
  const view = page?.view ?? [0, 0, 612, 792];
  return { x0: view[0], y0: view[1], w: view[2] - view[0], h: view[3] - view[1] };
};

/** Viewport CSS pixels -> normalised PDF user space (0..1, origin bottom-left). */
function toNorm(page, vp, x, y) {
  const [px, py] = vp.convertToPdfPoint(x, y);
  const box = pageBox(page);
  return [(px - box.x0) / box.w, (py - box.y0) / box.h];
}

/** Normalised PDF user space -> viewport CSS pixels. */
function fromNorm(page, vp, nx, ny) {
  const box = pageBox(page);
  return vp.convertToViewportPoint(box.x0 + nx * box.w, box.y0 + ny * box.h);
}

/* ------------------------------------------------------------------ */
/* Page views                                                          */
/* ------------------------------------------------------------------ */

/**
 * One page on screen: its element, its canvases, and the pdf.js page and
 * viewport behind them. Page mode keeps a single view (the markup already in
 * viewer.html); scroll mode makes one per page and renders each as it comes
 * into view.
 */
function makeView(visible, parts) {
  const view = {
    visible,
    root: parts.root,
    canvas: parts.canvas,
    textLayer: parts.textLayer,
    inkCanvas: parts.inkCanvas,
    annotLayer: parts.annotLayer,
    proxy: null,
    viewport: null,
    scale: 1,
    wordMap: [],
    rendered: false,
    rendering: null,
    seq: 0,
  };
  wireView(view);
  return view;
}

const pagedView = makeView(0, {
  root: ui.pageWrap,
  canvas: ui.canvas,
  textLayer: ui.textLayer,
  inkCanvas: ui.inkCanvas,
  annotLayer: ui.annotLayer,
});

/** The page views in the continuous layout, keyed by the page number shown. */
const streamViews = new Map();
let streamObserver = null;
let scrollTick = 0;

const isScroll = () => state.viewMode === "scroll";
const isLive = (view) => Boolean(view?.proxy && view?.viewport);
const activeView = () => (isScroll() ? streamViews.get(state.pageNumber) ?? null : pagedView);
const allViews = () => (isScroll() ? [...streamViews.values()] : [pagedView]);

function resetView(view) {
  view.seq++;
  view.rendered = false;
  view.rendering = null;
  view.proxy = null;
  view.viewport = null;
  view.wordMap = [];
}

/** Pointers are wired per page, so every page can be drawn on, not just one. */
function wireView(view) {
  view.root.addEventListener("pointerdown", (event) => {
    if (state.tool !== "text") return;
    if (event.target.closest("[data-annot]") && event.target.isContentEditable) return;
    createTextBox(event, view);
  });

  view.root.addEventListener("click", (event) => {
    if (state.tool !== "erase") return;
    const node = event.target.closest("[data-annot]");
    if (node) removeAnnotation(node.dataset.annot);
  });

  view.inkCanvas.addEventListener("pointerdown", (event) => {
    if (state.tool === "pen") startInk(event, view);
    else if (state.tool === "erase") eraseAt(event, view);
  });
  view.inkCanvas.addEventListener("pointermove", (event) => moveInk(event, view));
  view.inkCanvas.addEventListener("pointerup", (event) => endInk(event, view));
  view.inkCanvas.addEventListener("pointercancel", (event) => endInk(event, view));
}

/** The page view a DOM node belongs to, or null when it belongs to none. */
function viewForNode(node) {
  const element = node instanceof Element ? node : node?.parentElement;
  const root = element?.closest(".page");
  if (!root) return null;
  if (root === ui.pageWrap) return pagedView;
  return streamViews.get(Number(root.dataset.page)) ?? null;
}

function createStreamView(visible) {
  const root = document.createElement("div");
  root.className = "page";
  root.dataset.page = String(visible);
  root.dataset.tool = state.tool;
  root.dataset.placeholder = "1";

  const canvas = document.createElement("canvas");
  canvas.className = "pdf-canvas";
  const textLayer = document.createElement("div");
  textLayer.className = "text-layer";
  textLayer.setAttribute("aria-hidden", "true");
  const inkCanvas = document.createElement("canvas");
  inkCanvas.className = "ink-canvas";
  const annotLayer = document.createElement("div");
  annotLayer.className = "annot-layer";
  root.append(canvas, textLayer, inkCanvas, annotLayer);

  return makeView(visible, { root, canvas, textLayer, inkCanvas, annotLayer });
}

function disposeStream() {
  if (streamObserver) streamObserver.disconnect();
  streamObserver = null;
  // Bumping the sequence leaves any render still in flight with nothing to draw.
  for (const view of streamViews.values()) view.seq++;
  streamViews.clear();
  ui.stream.replaceChildren();
}

async function buildStream() {
  disposeStream();
  if (!state.doc) return;
  streamObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const view = streamViews.get(Number(entry.target.dataset.page));
        if (view) void ensureRendered(view);
      }
    },
    // Render well before a page is on screen, so scrolling does not show blanks.
    { root: ui.stage, rootMargin: "900px 0px" },
  );
  for (let visible = 1; visible <= state.pageOrder.length; visible++) {
    const view = createStreamView(visible);
    streamViews.set(visible, view);
    ui.stream.append(view.root);
    streamObserver.observe(view.root);
  }
  await ensureRendered(streamViews.get(state.pageNumber) ?? streamViews.get(1));
  scrollToPage(state.pageNumber);
}

/**
 * Jump the stage to a page. The jump is instant on purpose: an animated scroll
 * passes over the pages in between, which changes the page number and lets the
 * page being scrolled to be released again before it is reached.
 */
function scrollToPage(visible) {
  const view = streamViews.get(visible);
  if (!view) return;
  ui.stage.scrollTop = Math.max(0, view.root.offsetTop - 24);
}

/** Keep the page number in step with what the reader is looking at. */
function onStageScroll() {
  if (!isScroll() || !state.doc || scrollTick) return;
  scrollTick = requestAnimationFrame(() => {
    scrollTick = 0;
    if (!isScroll() || !state.doc) return;
    const stageTop = ui.stage.getBoundingClientRect().top;
    const line = stageTop + Math.min(120, ui.stage.clientHeight * 0.25);
    let visible = state.pageNumber;
    for (const view of streamViews.values()) {
      const rect = view.root.getBoundingClientRect();
      if (rect.top > line) break;
      visible = view.visible;
    }
    if (visible !== state.pageNumber) {
      state.pageNumber = visible;
      updatePageUi();
      const view = streamViews.get(visible);
      if (view) ui.zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
    }
    releaseDistantPages();
  });
}

/**
 * Free the bitmaps of pages that are well away from the screen, so a long
 * document does not keep every page it has passed in memory. The page boxes
 * keep their size, so nothing moves; a released page is drawn again by the
 * observer as soon as it comes back into view.
 */
function releaseDistantPages() {
  if (!isScroll()) return;
  const stageRect = ui.stage.getBoundingClientRect();
  const margin = Math.max(1200, ui.stage.clientHeight * 2);
  for (const view of streamViews.values()) {
    if (!view.rendered) continue;
    const rect = view.root.getBoundingClientRect();
    if (rect.bottom > stageRect.top - margin && rect.top < stageRect.bottom + margin) continue;
    resetView(view);
    view.canvas.width = 0;
    view.canvas.height = 0;
    view.inkCanvas.width = 0;
    view.inkCanvas.height = 0;
    view.textLayer.replaceChildren();
    view.annotLayer.replaceChildren();
  }
}

/** Switch between one page at a time and a continuous, scrolling layout. */
async function setViewMode(mode, { persist = true } = {}) {
  state.viewMode = mode === "scroll" ? "scroll" : "paged";
  ui.btnViewPaged.setAttribute("aria-pressed", String(state.viewMode === "paged"));
  ui.btnViewScroll.setAttribute("aria-pressed", String(state.viewMode === "scroll"));
  ui.pageWrap.hidden = isScroll();
  ui.stream.hidden = !isScroll();
  if (persist) saveSettings({ viewMode: state.viewMode }).catch(() => {});
  if (isScroll()) {
    await buildStream();
  } else {
    disposeStream();
    if (state.doc) await renderPage();
  }
  setTool(state.tool);
}

/* ------------------------------------------------------------------ */
/* Document lifecycle                                                  */
/* ------------------------------------------------------------------ */

function visibleToOriginal(visible) {
  return state.pageOrder[visible - 1];
}

function teardownDocument() {
  stopReading();
  state.range = null;
  state.chunks = [];
  transcriptEls = [];
  ui.transcript.replaceChildren();
  ui.progressLabel.textContent = "";
  if (state.doc) state.doc.destroy().catch(() => {});
  state.doc = null;
  pageCache.clear();
  textCache.clear();
  state.annotations = [];
  state.history = [];
  state.future = [];
  state.rotations = {};
  state.pageOrder = [];
  state.lastWord = null;
  thumbToken++;
  if (thumbObserver) thumbObserver.disconnect();
  ui.thumbs.replaceChildren();
  ui.annotLayer.replaceChildren();
  ui.textLayer.replaceChildren();
  ui.canvas.width = 0;
  ui.canvas.height = 0;
  ui.inkCanvas.width = 0;
  ui.inkCanvas.height = 0;
  resetView(pagedView);
  disposeStream();
}

async function openBytes(bytes, name, sourceUrl = "") {
  teardownDocument();
  ui.docName.textContent = "Opening…";
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: new URL("cmaps/", VENDOR).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("standard_fonts/", VENDOR).href,
    wasmUrl: new URL("wasm/", VENDOR).href,
    iccUrl: new URL("iccs/", VENDOR).href,
    isEvalSupported: false,
  });

  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => {});
    ui.empty.hidden = false;
    ui.docName.textContent = "No PDF open";
    document.title = "PDF Reader";
    throw new Error(`That file could not be opened (${error.message}).`);
  }

  state.doc = doc;
  state.bytes = bytes;
  state.fileName = name || "document.pdf";
  state.pageOrder = Array.from({ length: doc.numPages }, (_, i) => i + 1);
  state.pageNumber = 1;
  state.scale = 1;
  state.zoomMode = "fit";

  ui.empty.hidden = true;
  ui.docName.textContent = state.fileName;
  ui.docName.title = sourceUrl || state.fileName;
  document.title = `${state.fileName} — PDF Reader`;
  ui.startPage.value = 1;
  ui.endPage.value = doc.numPages;
  ui.startPage.max = doc.numPages;
  ui.endPage.max = doc.numPages;
  ui.startWord.value = "";
  ui.endWord.value = "";
  ui.pageInput.value = 1;
  ui.save.disabled = false;

  await refreshStage({ rebuild: true });
  buildThumbs();
  updateRangePreview();
  state.dirty = false;
  updateUndoButton();
}

async function openUrl(url) {
  ui.docName.textContent = "Downloading…";
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`Could not download that PDF (HTTP ${response.status}).`);
  const type = (response.headers.get("content-type") || "").toLowerCase();
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error("That link returned an empty file.");
  if (type.includes("text/html")) {
    throw new Error("That link returned a web page, not a PDF. It may need you to sign in first.");
  }
  // The name the server suggests wins, so a saved copy is called what the site
  // calls it rather than after the download URL.
  let name = filenameFromDisposition(response.headers.get("content-disposition"));
  if (!name) {
    try {
      const last = new URL(url).pathname.split("/").filter(Boolean).pop();
      if (last) name = decodeURIComponent(last);
    } catch {
      /* keep the default name */
    }
  }
  name = name.replace(/[\\/]+/g, "-").trim() || "document.pdf";
  if (!/\.pdf$/i.test(name)) name += ".pdf";
  await openBytes(bytes, name, url);
}

/** True when the open document differs from the file it was loaded from. */
function documentIsEdited() {
  const originalPages = state.doc?.numPages ?? 0;
  if (state.annotations.length) return true;
  if (state.pageOrder.length !== originalPages) return true;
  if (state.pageOrder.some((pageNumber, index) => pageNumber !== index + 1)) return true;
  return Object.values(state.rotations).some((degrees) => degrees);
}

/** The `filename` (or RFC 5987 `filename*`) of a Content-Disposition header. */
function filenameFromDisposition(value) {
  if (!value) return "";
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(value);
  if (extended) {
    const raw = extended[1].trim().replace(/^["']|["']$/g, "");
    // charset'lang'percent-encoded-name
    const parts = raw.split("''");
    const encoded = parts.length > 1 ? parts.slice(1).join("''") : raw;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(value);
  if (!plain) return "";
  return (plain[1] ?? plain[2] ?? "").trim();
}

async function openFile(file) {
  if (!file) return;
  if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    toast("That file is not a PDF.");
    return;
  }
  await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

async function getPage(pageNumber) {
  if (!pageCache.has(pageNumber)) pageCache.set(pageNumber, state.doc.getPage(pageNumber));
  return pageCache.get(pageNumber);
}

async function getPageTextData(pageNumber) {
  if (textCache.has(pageNumber)) return textCache.get(pageNumber);
  const page = await getPage(pageNumber);
  const content = await page.getTextContent();
  const data = { pageNumber, ...buildPageText(content) };
  textCache.set(pageNumber, data);
  return data;
}

/** Draw the single page of the page layout, starting from scratch. */
async function renderPage() {
  if (!state.doc) return;
  pagedView.visible = state.pageNumber;
  await ensureRendered(pagedView, { fresh: true });
}

/**
 * Render a page view unless it is already on screen. `fresh` throws away the
 * current picture first, which is what zoom, resize and page changes need.
 */
async function ensureRendered(view, { fresh = false } = {}) {
  if (!view || !state.doc) return null;
  if (fresh) {
    view.rendered = false;
    view.seq++;
    view.rendering = null;
  }
  if (view.rendered) return view;
  if (!view.rendering) {
    const task = renderView(view).catch((error) => {
      console.warn("[PDF Reader] the page could not be drawn", error);
      return view;
    });
    view.rendering = task;
    task.finally(() => {
      if (view.rendering === task) view.rendering = null;
    });
  }
  await view.rendering;
  return view;
}

async function renderView(view) {
  const seq = ++view.seq;
  const original = visibleToOriginal(view.visible);
  if (!original) return view;
  const page = await getPage(original);
  if (seq !== view.seq) return view;

  const extra = state.rotations[original] ?? 0;
  const rotation = (((page.rotate ?? 0) + extra) % 360 + 360) % 360;
  const base = page.getViewport({ scale: 1, rotation });
  if (state.zoomMode === "fit") {
    // Each page fills the width of its own slot, so a document with mixed page
    // sizes stays readable either way round.
    const available = Math.max(200, ui.stage.clientWidth - 48);
    view.scale = clamp(available / base.width, 0.1, 4);
  } else {
    view.scale = state.scale;
  }
  const vp = page.getViewport({ scale: view.scale, rotation });
  view.proxy = page;
  view.viewport = vp;
  delete view.root.dataset.placeholder;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  view.canvas.width = Math.max(1, Math.floor(vp.width * dpr));
  view.canvas.height = Math.max(1, Math.floor(vp.height * dpr));
  view.canvas.style.width = `${vp.width}px`;
  view.canvas.style.height = `${vp.height}px`;
  view.inkCanvas.width = view.canvas.width;
  view.inkCanvas.height = view.canvas.height;
  view.inkCanvas.style.width = `${vp.width}px`;
  view.inkCanvas.style.height = `${vp.height}px`;
  view.textLayer.style.width = `${vp.width}px`;
  view.textLayer.style.height = `${vp.height}px`;
  view.root.style.width = `${vp.width}px`;
  view.root.style.height = `${vp.height}px`;

  const ctx = view.canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, view.canvas.width, view.canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;
  if (seq !== view.seq) return view;

  const textData = await getPageTextData(original);
  if (seq !== view.seq) return view;
  buildTextLayer(view, vp, textData);
  view.rendered = true;

  drawInk(view);
  renderAnnotations(view);
  if (view === pagedView) state.scale = view.scale;
  if (view === activeView()) {
    ui.zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
    updatePageUi();
  }

  if (state.lastWord && state.lastWord.page === view.visible) {
    highlightWord(view, state.lastWord.raw);
  }
  return view;
}

function buildTextLayer(view, vp, textData) {
  view.textLayer.replaceChildren();
  view.wordMap = [];
  const frag = document.createDocumentFragment();

  for (const item of textData.items) {
    if (!item.str.trim()) continue;
    const matrix = combine(vp.transform, item.transform);
    const fontSize = Math.hypot(matrix[2], matrix[3]);
    if (!fontSize || fontSize < 0.5) continue;
    const angle = Math.atan2(matrix[1], matrix[0]);

    const span = document.createElement("span");
    span.className = "ti";
    span.style.fontSize = `${fontSize}px`;
    span.style.left = `${matrix[4]}px`;
    // `matrix[5]` is the baseline already measured down from the top of the
    // page: the viewport transform flips the PDF's y axis. Subtracting it from
    // the page height again mirrored every line, which put the invisible text
    // (and the reading highlight) on the wrong part of the page.
    span.style.top = `${matrix[5] - fontSize * ASCENT}px`;

    let scaleX = 1;
    const desired = item.width * vp.scale;
    const natural = measureWidth(item.str, fontSize);
    if (desired > 0 && natural > 0) {
      scaleX = clamp(desired / natural, 0.4, 3);
      if (Math.abs(scaleX - 1) < 0.08) scaleX = 1;
    }
    span.style.transform = `rotate(${angle}rad) scaleX(${scaleX})`;

    const words = [];
    const re = /\S+/g;
    let match;
    let last = 0;
    while ((match = re.exec(item.str))) {
      if (match.index > last) {
        span.append(document.createTextNode(item.str.slice(last, match.index)));
      }
      const word = document.createElement("span");
      word.className = "w";
      word.textContent = match[0];
      span.append(word);
      words.push({
        start: item.start + match.index,
        end: item.start + match.index + match[0].length,
        el: word,
      });
      last = match.index + match[0].length;
    }
    if (last < item.str.length) span.append(document.createTextNode(item.str.slice(last)));

    frag.append(span);
    view.wordMap.push(...words);
  }

  view.textLayer.append(frag);
  view.wordMap.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ */
/* Annotations                                                         */
/* ------------------------------------------------------------------ */

function snapshot() {
  return {
    annotations: structuredClone(state.annotations),
    pageOrder: [...state.pageOrder],
    rotations: { ...state.rotations },
  };
}

function pushHistory() {
  state.history.push(snapshot());
  if (state.history.length > 60) state.history.shift();
  state.future = [];
  updateUndoButton();
}

function restore(entry) {
  state.annotations = entry.annotations;
  state.pageOrder = entry.pageOrder;
  state.rotations = entry.rotations;
  state.dirty = true;
  state.pageNumber = clamp(state.pageNumber, 1, Math.max(1, state.pageOrder.length));
  buildThumbs();
  void refreshStage({ rebuild: true });
  scheduleRangePreview();
  updateUndoButton();
}

function undo() {
  const previous = state.history.pop();
  if (!previous) return;
  state.future.push(snapshot());
  restore(previous);
}

function updateUndoButton() {
  ui.undo.disabled = state.history.length === 0;
}

function addHighlightFromSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  const view = viewForNode(range.commonAncestorContainer);
  if (!view || !isLive(view) || !view.textLayer.contains(range.commonAncestorContainer)) return false;

  const pageRect = view.root.getBoundingClientRect();
  const rects = [];
  for (const r of range.getClientRects()) {
    const left = Math.max(r.left, pageRect.left);
    const right = Math.min(r.right, pageRect.right);
    const top = Math.max(r.top, pageRect.top);
    const bottom = Math.min(r.bottom, pageRect.bottom);
    if (right - left < 1 || bottom - top < 1) continue;
    const a = toNorm(view.proxy, view.viewport, left - pageRect.left, top - pageRect.top);
    const b = toNorm(view.proxy, view.viewport, right - pageRect.left, bottom - pageRect.top);
    rects.push({
      x: Math.min(a[0], b[0]),
      y: Math.min(a[1], b[1]),
      w: Math.abs(b[0] - a[0]),
      h: Math.abs(b[1] - a[1]),
    });
  }
  if (!rects.length) return false;

  pushHistory();
  state.annotations.push({
    id: uid(),
    page: visibleToOriginal(view.visible),
    type: "highlight",
    color: state.color,
    rects,
  });
  state.dirty = true;
  selection.removeAllRanges();
  refreshOverlays();
  toast("Highlight added.");
  return true;
}

/** Redraw the ink and annotations of every page that is on screen. */
function refreshOverlays() {
  for (const view of allViews()) {
    if (!isLive(view)) continue;
    drawInk(view);
    renderAnnotations(view);
  }
}

function renderAnnotations(view) {
  view.annotLayer.replaceChildren();
  if (!isLive(view)) return;
  const original = visibleToOriginal(view.visible);
  const vp = view.viewport;

  for (const a of state.annotations) {
    if (a.page !== original) continue;

    if (a.type === "highlight") {
      for (const r of a.rects) {
        const bottomLeft = fromNorm(view.proxy, vp, r.x, r.y);
        const topRight = fromNorm(view.proxy, vp, r.x + r.w, r.y + r.h);
        const left = Math.min(bottomLeft[0], topRight[0]);
        const top = Math.min(bottomLeft[1], topRight[1]);
        const width = Math.abs(topRight[0] - bottomLeft[0]);
        const height = Math.abs(topRight[1] - bottomLeft[1]);
        const div = document.createElement("div");
        div.className = "hl";
        div.dataset.annot = a.id;
        div.style.left = `${left}px`;
        div.style.top = `${top}px`;
        div.style.width = `${width}px`;
        div.style.height = `${height}px`;
        div.style.background = a.color;
        div.style.opacity = "0.38";
        view.annotLayer.append(div);
      }
      continue;
    }

    if (a.type === "text") {
      const point = fromNorm(view.proxy, vp, a.x, a.y);
      const fontPx = Math.max(6, a.fontSize * vp.height);
      const div = document.createElement("div");
      div.className = "tx";
      div.dataset.annot = a.id;
      div.contentEditable = "true";
      div.spellcheck = false;
      div.textContent = a.text ?? "";
      div.style.left = `${point[0]}px`;
      div.style.top = `${point[1] - fontPx * ASCENT}px`;
      div.style.fontSize = `${fontPx}px`;
      div.style.color = a.color;
      div.style.minWidth = `${fontPx * 3}px`;
      div.addEventListener("input", () => {
        a.text = div.textContent;
        state.dirty = true;
      });
      div.addEventListener("focus", () => {
        if (!div.dataset.snapshotted) {
          pushHistory();
          div.dataset.snapshotted = "1";
        }
      });
      div.addEventListener("blur", () => {
        if (!div.textContent.trim()) {
          state.annotations = state.annotations.filter((x) => x.id !== a.id);
          refreshOverlays();
        }
        state.dirty = true;
      });
      view.annotLayer.append(div);
    }
  }
}

function drawInk(view) {
  const ctx = view.inkCanvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, view.inkCanvas.width, view.inkCanvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (!isLive(view)) return;
  const original = visibleToOriginal(view.visible);
  const strokes = state.annotations.filter((a) => a.type === "ink" && a.page === original);
  // The stroke being drawn belongs to the page it started on, and nowhere else.
  if (liveStroke && liveStroke.page === original) strokes.push(liveStroke);

  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(0.6, stroke.strokeWidth * view.viewport.height);
    ctx.beginPath();
    stroke.points.forEach((point, i) => {
      const [x, y] = fromNorm(view.proxy, view.viewport, point[0], point[1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (stroke.points.length === 1) {
      const [x, y] = fromNorm(view.proxy, view.viewport, stroke.points[0][0], stroke.points[0][1]);
      ctx.lineTo(x + 0.1, y);
    }
    ctx.stroke();
  }
}

function removeAnnotation(id) {
  const found = state.annotations.find((a) => a.id === id);
  if (!found) return;
  pushHistory();
  state.annotations = state.annotations.filter((a) => a.id !== id);
  state.dirty = true;
  refreshOverlays();
}

/* ------------------------------------------------------------------ */
/* Toolbar / navigation                                                */
/* ------------------------------------------------------------------ */

function setTool(tool) {
  state.tool = tool;
  ui.pageWrap.dataset.tool = tool;
  for (const view of allViews()) view.root.dataset.tool = tool;
  for (const button of document.querySelectorAll(".tool")) {
    button.classList.toggle("active", button.dataset.tool === tool);
  }
  if (tool === "highlight") addHighlightFromSelection();
  else if (tool !== "select" && tool !== "text") window.getSelection()?.removeAllRanges();
}

async function goToPage(pageNumber) {
  if (!state.doc) return;
  const target = clampInt(pageNumber, 1, Math.max(1, state.pageOrder.length));
  if (isScroll()) {
    state.pageNumber = target;
    const view = await ensureRendered(streamViews.get(target));
    if (view) scrollToPage(target);
    updatePageUi();
    return;
  }
  if (target === state.pageNumber && isLive(pagedView)) {
    updatePageUi();
    return;
  }
  state.pageNumber = target;
  await renderPage();
}

/**
 * Redraw the open document after the zoom, the window or the pages themselves
 * changed. `rebuild` also replaces the page elements, which is needed when the
 * page order or a rotation changed.
 */
async function refreshStage({ rebuild = false } = {}) {
  if (!state.doc) return;
  if (!isScroll()) {
    await renderPage();
    return;
  }
  if (rebuild || streamViews.size !== state.pageOrder.length) {
    await buildStream();
    return;
  }
  // Every page that is on screen has to be drawn again at the new zoom.
  await Promise.all(
    [...streamViews.values()].filter((view) => view.rendered).map((view) => ensureRendered(view, { fresh: true })),
  );
}

function updatePageUi() {
  if (!state.doc) return;
  const total = state.pageOrder.length;
  ui.pageInput.value = String(state.pageNumber);
  ui.pageTotal.textContent = String(total);
  ui.pageCountLabel.textContent = `${total} ${total === 1 ? "page" : "pages"}`;
  ui.pageInput.max = String(total);
  ui.prevPage.disabled = state.pageNumber <= 1;
  ui.nextPage.disabled = state.pageNumber >= total;
  for (const thumb of ui.thumbs.querySelectorAll(".thumb")) {
    thumb.classList.toggle("current", Number(thumb.dataset.page) === state.pageNumber);
  }
  centreThumb(state.pageNumber);
}

/**
 * Keep the page on screen in the middle of the thumbnail rail. The rail is its
 * own scroller: without this the highlight walks off the bottom of it while the
 * document is scrolled, leaving no overview of where you are.
 */
function centreThumb(pageNumber) {
  const card = ui.thumbs.querySelector(`.thumb[data-page="${pageNumber}"]`);
  if (!card) return;
  const wanted = card.offsetTop + card.offsetHeight / 2 - ui.thumbs.clientHeight / 2;
  const max = Math.max(0, ui.thumbs.scrollHeight - ui.thumbs.clientHeight);
  const next = clamp(wanted, 0, max);
  if (Math.abs(ui.thumbs.scrollTop - next) < 2) return;
  ui.thumbs.scrollTop = next;
}

function setZoom(delta) {
  // In the continuous layout each page fits its own width, so the first step
  // away from fit has to start where the page actually is.
  if (state.zoomMode === "fit") state.scale = activeView()?.scale ?? state.scale;
  state.zoomMode = "manual";
  state.scale = clamp(state.scale + delta, 0.15, 4);
  void refreshStage();
}

/* ------------------------------------------------------------------ */
/* Thumbnails and page operations                                      */
/* ------------------------------------------------------------------ */

let thumbObserver = null;
let thumbResize = null;

function buildThumbs() {
  thumbToken++;
  const token = thumbToken;
  if (thumbObserver) thumbObserver.disconnect();
  // Previews are drawn lazily and change height as they arrive, which moves the
  // page being read away from the middle of the rail; follow them.
  if (thumbResize) thumbResize.disconnect();
  thumbResize = typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver(() => {
        if (state.doc) centreThumb(state.pageNumber);
      });
  ui.thumbs.replaceChildren();

  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      thumbObserver.unobserve(entry.target);
      renderThumb(entry.target, token);
    }
  }, { root: ui.thumbs, rootMargin: "200px" });

  state.pageOrder.forEach((original, index) => {
    const visible = index + 1;
    const card = document.createElement("div");
    card.className = "thumb";
    card.dataset.page = String(visible);
    card.dataset.original = String(original);
    card.draggable = true;

    const slot = document.createElement("div");
    slot.className = "thumb-slot";
    slot.dataset.slot = "1";

    const bar = document.createElement("div");
    bar.className = "thumb-bar";
    const label = document.createElement("span");
    label.className = "thumb-label";
    label.textContent = String(visible);
    const actions = document.createElement("span");
    actions.className = "thumb-actions";
    for (const [act, glyph, title] of [
      ["rotate-left", "⟲", "Rotate left"],
      ["rotate-right", "⟳", "Rotate right"],
      ["delete", "✕", "Delete page"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.act = act;
      button.title = `${title} (page ${visible})`;
      button.textContent = glyph;
      actions.append(button);
    }
    bar.append(label, actions);
    card.append(slot, bar);

    card.addEventListener("click", (event) => {
      const action = event.target.closest("button")?.dataset.act;
      if (action === "delete") {
        event.stopPropagation();
        deletePage(visible);
        return;
      }
      if (action === "rotate-left" || action === "rotate-right") {
        event.stopPropagation();
        rotatePage(visible, action === "rotate-left" ? -90 : 90);
        return;
      }
      goToPage(visible);
    });

    card.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", String(visible));
      event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragover", (event) => {
      event.preventDefault();
      card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      card.classList.remove("drag-over");
      const from = Number(event.dataTransfer.getData("text/plain"));
      if (from) movePage(from, visible);
    });

    ui.thumbs.append(card);
    thumbObserver.observe(card);
    thumbResize?.observe(card);
  });

  updatePageUi();
}

async function renderThumb(card, token) {
  const original = Number(card.dataset.original);
  const slot = card.querySelector("[data-slot]");
  if (!slot || !state.doc) return;
  try {
    const page = await getPage(original);
    if (token !== thumbToken) return;
    const extra = state.rotations[original] ?? 0;
    const rotation = (((page.rotate ?? 0) + extra) % 360 + 360) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    // A small preview: the rail is an overview, and smaller pages mean more of
    // them fit around the one being read.
    const scale = Math.min(1, 104 / base.width);
    const vp = page.getViewport({ scale, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    if (token !== thumbToken) return;
    slot.replaceChildren(canvas);
  } catch {
    /* thumbnails are decorative */
  }
}

function refreshThumb(visible) {
  const card = ui.thumbs.querySelector(`.thumb[data-page="${visible}"]`);
  if (!card) return;
  const slot = card.querySelector("[data-slot]");
  if (slot) slot.replaceChildren();
  renderThumb(card, thumbToken);
}

function rotatePage(visible, delta) {
  const original = visibleToOriginal(visible);
  if (!original) return;
  pushHistory();
  state.rotations[original] = (((state.rotations[original] ?? 0) + delta) % 360 + 360) % 360;
  state.dirty = true;
  refreshThumb(visible);
  void refreshStage({ rebuild: true });
}

function deletePage(visible) {
  if (state.pageOrder.length <= 1) {
    toast("A PDF needs at least one page.");
    return;
  }
  pushHistory();
  const original = visibleToOriginal(visible);
  state.pageOrder = state.pageOrder.filter((n) => n !== original);
  state.dirty = true;
  if (state.pageNumber > state.pageOrder.length) state.pageNumber = state.pageOrder.length;
  buildThumbs();
  void refreshStage({ rebuild: true });
  scheduleRangePreview();
  toast(`Page ${visible} removed. Save the PDF to keep the change.`);
}

function movePage(fromVisible, toVisible) {
  if (fromVisible === toVisible) return;
  pushHistory();
  const order = [...state.pageOrder];
  const [moved] = order.splice(fromVisible - 1, 1);
  order.splice(toVisible - 1, 0, moved);
  state.pageOrder = order;
  state.dirty = true;
  state.pageNumber = toVisible;
  buildThumbs();
  void refreshStage({ rebuild: true });
  scheduleRangePreview();
}

/* ------------------------------------------------------------------ */
/* Reading range                                                       */
/* ------------------------------------------------------------------ */

/** How many chunks to keep queued ahead of the voice before pausing the page loading. */
const READ_AHEAD_CHUNKS = 3;
/** Beyond this the transcript list stops growing; the audio keeps going. */
const TRANSCRIPT_LIMIT = 400;

/** The range being read right now, or null. */
let feed = null;
let pumping = false;
/** True while the status line belongs to a reading, so the range preview leaves it alone. */
let rangeStatusLocked = false;

/**
 * Reading range that pulls its text in one page at a time, so playback can
 * start as soon as the first page is parsed instead of after the whole range.
 */
function createReadFeed(inputs, { preview = false } = {}) {
  const range = createRangeReader({ startWord: inputs.startWord, endWord: inputs.endWord });
  let nextPage = inputs.startPage;

  const active = {
    range,
    inputs,
    preview,
    /** Pages still left to look at, ignoring the end word being found. */
    get exhausted() {
      return nextPage > inputs.endPage;
    },
    get span() {
      return inputs.endPage - inputs.startPage + 1;
    },
    get loaded() {
      return range.segments.length;
    },
    /** Parse the next page's text. False once the range has run out of pages. */
    async loadNext() {
      while (nextPage <= inputs.endPage) {
        const visible = nextPage++;
        const original = visibleToOriginal(visible);
        if (!original) continue;
        const data = await getPageTextData(original);
        range.addPage(visible, data.raw);
        return true;
      }
      return false;
    },
    /** Load pages until the start word shows up, or report why it did not. */
    async resolveStart() {
      for (;;) {
        if (range.begin()) return { ok: true };
        if (!(await active.loadNext())) {
          return {
            ok: false,
            error: normalizeQuery(inputs.startWord)
              ? `Start word “${normalizeQuery(inputs.startWord)}” was not found on pages ${inputs.startPage}–${inputs.endPage}.`
              : `No selectable text was found on pages ${inputs.startPage}–${inputs.endPage}.`,
          };
        }
        // A newer Read (or a new document) took over while this page loaded.
        if (!preview && active !== feed) return { ok: false, error: "Reading was cancelled." };
      }
    },
    /** Turn the newly loaded text into chunks and queue it for speech. */
    emit() {
      const chunks = range.takeChunks();
      if (!chunks.length) return 0;
      state.chunks.push(...chunks);
      appendTranscript(chunks);
      reader.append(chunks);
      return chunks.length;
    },
  };
  return active;
}

/** Keep the queue topped up while the voice is working through it. */
async function pumpReading() {
  const active = feed;
  if (!active || pumping) return;
  pumping = true;
  try {
    while (!active.range.done && reader.chunks.length - reader.index < READ_AHEAD_CHUNKS) {
      if (!(await active.loadNext())) break;
      if (active !== feed) return;
      active.emit();
      updateReadingStatus(active);
    }
    if (active !== feed) return;
    if (active.range.done || active.exhausted) {
      // Nothing more is coming: let the queue drain, then report the result.
      reader.close();
    }
  } finally {
    pumping = false;
  }
}

function updateReadingStatus(active) {
  if (active !== feed || active.finished) return;
  setRangeStatus(`Reading · ${active.loaded} of ${active.span} pages loaded`);
}

/** The voice has run out of queued text: report how much was read. */
function reportReadingFinished() {
  const active = feed;
  if (!active || active.finished) return;
  active.finished = true;
  const words = active.range.wordCount();
  setRangeStatus(`Read ${active.loaded} of ${active.span} pages · ${words.toLocaleString()} words.`, "ok");
}

/**
 * Range presets. Each one decides which anchors are used, so the panel offers a
 * plain choice instead of making you work out which fields to leave empty.
 */
const RANGE_MODES = {
  whole: { usesStart: false, usesEnd: false, endsWithPage: false },
  "to-word": { usesStart: false, usesEnd: true, endsWithPage: false },
  "from-word": { usesStart: true, usesEnd: false, endsWithPage: false },
  "word-to-word": { usesStart: true, usesEnd: true, endsWithPage: false },
  "word-to-page": { usesStart: true, usesEnd: false, endsWithPage: true },
};

function currentMode() {
  const mode = ui.rangeMode.value;
  return RANGE_MODES[mode] ? mode : "whole";
}

/** Switch presets, clearing the anchors the new one does not use. */
function setRangeMode(mode, { clear = true, notify = true } = {}) {
  const id = RANGE_MODES[mode] ? mode : "whole";
  const preset = RANGE_MODES[id];
  ui.rangeMode.value = id;
  if (clear) {
    if (!preset.usesStart) ui.startWord.value = "";
    if (!preset.usesEnd) ui.endWord.value = "";
  }
  // Fields the preset ignores are dimmed rather than removed: the form keeps
  // its shape, and it stays obvious which anchors are being used.
  ui.startWord.closest("label").classList.toggle("unused", !preset.usesStart);
  ui.endWord.closest("label").classList.toggle("unused", !preset.usesEnd);
  ui.endPage.disabled = preset.endsWithPage;
  ui.endPage.placeholder = preset.endsWithPage ? "end of that page" : "end of document";
  if (preset.endsWithPage) ui.endPage.value = "";
  if (notify) {
    // Choosing a preset is an edit of the range, so the status line goes back
    // to describing what would be read.
    rangeStatusLocked = false;
    scheduleRangePreview();
  }
}

/** Typing an anchor picks the preset that uses it. */
function syncModeWithFields() {
  const start = ui.startWord.value.trim();
  const end = ui.endWord.value.trim();
  const mode = currentMode();
  if (start && end) {
    if (mode !== "word-to-word") setRangeMode("word-to-word", { clear: false });
  } else if (end) {
    if (mode !== "to-word") setRangeMode("to-word", { clear: false });
  } else if (start) {
    // A start word with no end word keeps "end of that page" when it is chosen.
    if (mode !== "from-word" && mode !== "word-to-page") setRangeMode("from-word", { clear: false });
  }
}

function rangeInputs() {
  const total = Math.max(1, state.pageOrder.length);
  const mode = currentMode();
  const preset = RANGE_MODES[mode];
  // Both page fields are optional: an empty "To page" means "no stopping point",
  // so reading continues to the end of the document.
  const from = String(ui.startPage.value ?? "").trim();
  const to = String(ui.endPage.value ?? "").trim();
  const startPage = from ? clampInt(from, 1, total) : 1;
  const endPage = to ? clampInt(to, 1, total) : total;
  return {
    mode,
    endsWithPage: preset.endsWithPage,
    startPage: Math.min(startPage, endPage),
    endPage: Math.max(startPage, endPage),
    openEnded: !to,
    startWord: preset.usesStart ? ui.startWord.value : "",
    endWord: preset.usesEnd ? ui.endWord.value : "",
  };
}

/** "Word/phrase → its page" needs a word to know where the page ends. */
function missingStartWord(inputs) {
  return inputs.endsWithPage && !normalizeQuery(inputs.startWord)
    ? "Type a word or phrase to start at, or choose a different “Read” option."
    : "";
}

/** The text selected inside one page's text layer, with that page's view. */
function selectedPage() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const view = viewForNode(range.startContainer);
  if (!view || view !== viewForNode(range.endContainer) || !isLive(view)) return null;
  if (!view.textLayer.contains(range.startContainer) || !view.textLayer.contains(range.endContainer)) {
    return null;
  }
  const text = selection.toString().replace(/\s+/g, " ").trim();
  return text ? { text, view } : null;
}

/** Use the selected word as the start or end anchor for the page you are on. */
function useSelectionAsAnchor(which) {
  const selected = selectedPage();
  if (!selected) {
    toast("Select a word or phrase on the page first.");
    return;
  }
  const { text } = selected;
  const page = selected.view.visible || state.pageNumber;
  // An empty bound means "first page" / "to the end", so only move bounds that
  // are actually set — otherwise picking a start word would silently cap an
  // open-ended range.
  if (which === "start") {
    ui.startWord.value = text;
    ui.startPage.value = String(page);
    if (ui.endPage.value && Number(ui.endPage.value) < page) ui.endPage.value = String(page);
  } else {
    ui.endWord.value = text;
    ui.endPage.value = String(page);
    if (ui.startPage.value && Number(ui.startPage.value) > page) ui.startPage.value = String(page);
  }
  scheduleRangePreview();
  // Picking an anchor implies a range that uses it, so the preset follows.
  syncModeWithFields();
  const shown = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  toast(`Range ${which} set to “${shown}”.`);
}

function scheduleRangePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updateRangePreview, 260);
}

function previewSummary(range, inputs) {
  const pages = `Pages ${inputs.startPage}–${inputs.endPage}`;
  let where = pages;
  if (inputs.endsWithPage) where = `Page ${inputs.endPage} · from the start word to the end of the page`;
  else if (inputs.openEnded) where = `${pages} · to the end of the document`;
  const bits = [where];
  if (range.startMatch && !inputs.endsWithPage) bits.push(`starts on page ${range.startMatch.pageNumber}`);
  // Without an end word the range is fully described by its page numbers, and
  // guessing a duration would mean parsing every page first — which is the cost
  // this range is meant to avoid. The real word count appears once it is read.
  if (!inputs.endWord.trim()) return bits.join(" · ");
  if (!range.done) return null;
  const words = range.wordCount();
  const minutes = words / (165 * (Number(state.settings.rate) || 1));
  bits.push(`${words.toLocaleString()} words`, minutes < 1 ? "under a minute" : `about ${Math.round(minutes)} min`);
  if (range.endMatch) bits.push(`ends on page ${range.endMatch.pageNumber}`);
  return bits.join(" · ");
}

async function updateRangePreview() {
  // A reading (or the reason one stopped) owns the status line until it is over.
  if (rangeStatusLocked) return;
  const seq = ++previewSeq;
  if (!state.doc) {
    setRangeStatus("Open a PDF to set a reading range.");
    ui.readRange.disabled = true;
    return;
  }
  const inputs = rangeInputs();
  const missing = missingStartWord(inputs);
  if (missing) {
    setRangeStatus(missing, "error");
    ui.readRange.disabled = true;
    return;
  }
  const span = inputs.endPage - inputs.startPage + 1;
  if (span > 60 && !inputs.endsWithPage) {
    const end = inputs.openEnded ? " (to the end of the document)" : "";
    setRangeStatus(`Pages ${inputs.startPage}–${inputs.endPage}${end}. Press “Start reading” to begin.`);
    ui.readRange.disabled = !Reader.supported;
    return;
  }
  setRangeStatus("Checking the range…");
  const preview = createReadFeed(inputs, { preview: true });
  const start = await preview.resolveStart();
  if (seq !== previewSeq) return; // A newer range was requested while loading.
  if (!start.ok) {
    setRangeStatus(start.error, "error");
    ui.readRange.disabled = true;
    return;
  }
  // The page the start word landed on is where "end of that page" stops.
  if (inputs.endsWithPage && preview.range.startMatch) {
    inputs.endPage = preview.range.startMatch.pageNumber;
  }
  // An end word can be anywhere up to the last page, so look for it page by page
  // and stop as soon as it turns up.
  if (inputs.endWord.trim()) {
    while (!preview.range.done && !preview.exhausted) {
      if (!(await preview.loadNext())) break;
      preview.range.resolveEnd();
      if (seq !== previewSeq) return;
    }
  }
  const line = previewSummary(preview.range, inputs);
  if (!line) {
    setRangeStatus(
      `End word “${normalizeQuery(inputs.endWord)}” does not appear after the start point on pages ${inputs.startPage}–${inputs.endPage}.`,
      "error",
    );
    ui.readRange.disabled = true;
    return;
  }
  setRangeStatus(line, "ok");
  ui.readRange.disabled = !Reader.supported;
}

/** Stop whatever is reading and forget the range being streamed. */
function stopReading() {
  feed = null;
  rangeStatusLocked = false;
  reader.stop();
  ui.playPause.textContent = "▶";
  ui.stop.disabled = true;
}

async function startReading() {
  if (!state.doc) return;
  const inputs = rangeInputs();
  const missing = missingStartWord(inputs);
  if (missing) {
    setRangeStatus(missing, "error");
    return;
  }
  stopReading();
  rangeStatusLocked = true;
  clearTranscript();
  state.range = null;
  state.chunks = [];
  ui.readRange.disabled = true;
  setRangeStatus("Looking for the start of the range…");

  const active = createReadFeed(inputs);
  feed = active;
  try {
    const start = await active.resolveStart();
    if (feed !== active) return;
    if (!start.ok) {
      setRangeStatus(start.error, "error");
      return;
    }
    // "Word/phrase → end of that page": the anchor's page is the stop, so the
    // page stream ends there no matter what the To field said.
    if (inputs.endsWithPage && active.range.startMatch) {
      inputs.endPage = active.range.startMatch.pageNumber;
    }

    reader.rate = Number(state.settings.rate) || 1;
    reader.pitch = Number(state.settings.pitch) || 1;
    reader.voiceURI = state.settings.voiceURI || "";
    reader.load({ chunks: [], open: true });
    // The page map grows as pages are parsed, so follow-along highlighting works
    // for text that has not been looked at yet. Chunk offsets are absolute
    // offsets into that text, the same space as `segments`.
    state.range = {
      segments: active.range.segments,
      startPage: inputs.startPage,
      endPage: inputs.endPage,
    };
    if (!active.emit()) {
      reader.close();
      setRangeStatus("There is nothing to read in that range.", "error");
      return;
    }
    updateReadingStatus(active);

    // Start the voice before touching the page: a slow or stuck page render
    // must never hold up the audio.
    reader.play();
    ui.stop.disabled = false;
    void pumpReading();

    if (active.range.startMatch) {
      try {
        await goToPage(active.range.startMatch.pageNumber);
      } catch {
        // A page that will not render is not a reason to stop reading.
      }
    }
  } catch (error) {
    setRangeStatus(`Could not read: ${error.message}`, "error");
  } finally {
    ui.readRange.disabled = false;
  }
}

function clearTranscript() {
  transcriptEls = [];
  ui.transcript.replaceChildren();
  ui.progressLabel.textContent = "";
}

/** Add the newest chunks to the reading list as they arrive. */
function appendTranscript(chunks) {
  const frag = document.createDocumentFragment();
  for (const chunk of chunks) {
    if (transcriptEls.length >= TRANSCRIPT_LIMIT) break;
    const index = transcriptEls.length;
    const p = document.createElement("p");
    p.className = "sentence";
    p.textContent = chunk.text;
    p.addEventListener("click", () => reader.seekToChunk(index));
    transcriptEls.push(p);
    frag.append(p);
  }
  ui.transcript.append(frag);
}


function updateTranscriptProgress(chunkIndex) {
  transcriptEls.forEach((node, index) => node.classList.toggle("current", index === chunkIndex));
  const active = transcriptEls[chunkIndex];
  if (active) {
    // Scroll the reading list itself, so following the voice never scrolls the
    // whole panel and takes the range fields out of reach.
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < ui.transcript.scrollTop + 4 || bottom > ui.transcript.scrollTop + ui.transcript.clientHeight - 4) {
      ui.transcript.scrollTop = Math.max(0, top - ui.transcript.clientHeight / 2 + active.offsetHeight / 2);
    }
  }
  if (chunkIndex >= 0) ui.progressLabel.textContent = `${chunkIndex + 1} / ${state.chunks.length}`;
}

function locateRangeOffset(absolute) {
  if (!state.range) return null;
  const segments = state.range.segments ?? [];
  let segment = segments.find((s) => absolute >= s.start && absolute < s.end);
  if (!segment) {
    for (const s of segments) {
      if (s.start <= absolute && s.end > s.start) segment = s;
    }
  }
  if (!segment || !segment.map?.length) return null;
  const local = clamp(absolute - segment.start, 0, segment.map.length - 1);
  return { pageNumber: segment.pageNumber, raw: segment.map[local] };
}

async function followReading(absolute) {
  const location = locateRangeOffset(absolute);
  if (!location) return;
  state.lastWord = location;
  if (location.pageNumber !== state.pageNumber) {
    if (!state.settings.followPage || followBusy) return;
    followBusy = true;
    try {
      await goToPage(location.pageNumber);
    } finally {
      followBusy = false;
    }
  }
  // Highlight the word on its own page view, even if the page has not been
  // drawn yet (a jump back to a page whose bitmap was released).
  const view = isScroll() ? await ensureRendered(streamViews.get(location.pageNumber)) : pagedView;
  if (isLive(view)) highlightWord(view, location.raw);
}

function highlightWord(view, rawOffset) {
  if (!view.wordMap.length) return;
  let previous = view.textLayer.querySelector(".w.reading");
  if (previous) previous.classList.remove("reading");

  let found = null;
  let low = 0;
  let high = view.wordMap.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const entry = view.wordMap[mid];
    if (rawOffset < entry.start) high = mid - 1;
    else if (rawOffset >= entry.end) low = mid + 1;
    else {
      found = entry;
      break;
    }
  }
  if (!found) found = view.wordMap[clamp(low, 0, view.wordMap.length - 1)];

  found.el.classList.add("reading");
  const wordRect = found.el.getBoundingClientRect();
  const stageRect = ui.stage.getBoundingClientRect();
  if (wordRect.top < stageRect.top + 32 || wordRect.bottom > stageRect.bottom - 32) {
    found.el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

async function savePdf() {
  if (!state.doc) return;
  ui.save.disabled = true;
  const edited = documentIsEdited();
  try {
    const bytes = await buildEditedPdf(state.bytes, {
      annotations: state.annotations,
      pageOrder: state.pageOrder,
      rotations: state.rotations,
    });
    const blob = new Blob([bytes], { type: "application/pdf" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    // An untouched document keeps its own name; only edits get a suffix.
    link.download = `${state.fileName.replace(/\.pdf$/i, "")}${edited ? "-edited" : ""}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    state.dirty = false;
    toast(edited ? "Saved a copy with your edits." : `Saved a copy as ${link.download}.`);
  } catch (error) {
    toast(`Could not save: ${error.message}`, 5000);
  } finally {
    ui.save.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Pointer input                                                       */
/* ------------------------------------------------------------------ */

function pagePoint(event, view) {
  const rect = view.root.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function startInk(event, view) {
  if (state.tool !== "pen" || !isLive(view)) return;
  const point = pagePoint(event, view);
  liveStroke = {
    id: uid(),
    page: visibleToOriginal(view.visible),
    type: "ink",
    color: state.color,
    strokeWidth: 1.8 / view.viewport.height,
    points: [toNorm(view.proxy, view.viewport, point.x, point.y)],
  };
  try {
    view.inkCanvas.setPointerCapture(event.pointerId);
  } catch {
    /* The pointer may already be gone; drawing still works without capture. */
  }
  drawInk(view);
}

function moveInk(event, view) {
  if (!liveStroke || state.tool !== "pen" || !isLive(view)) return;
  const point = pagePoint(event, view);
  const last = liveStroke.points[liveStroke.points.length - 1];
  const next = toNorm(view.proxy, view.viewport, point.x, point.y);
  if (Math.hypot(next[0] - last[0], next[1] - last[1]) < 0.0015) return;
  liveStroke.points.push(next);
  drawInk(view);
}

function endInk(event, view) {
  if (!liveStroke) return;
  if (event?.type === "pointerup" && isLive(view)) {
    const point = pagePoint(event, view);
    liveStroke.points.push(toNorm(view.proxy, view.viewport, point.x, point.y));
  }
  if (liveStroke.points.length > 1) {
    pushHistory();
    state.annotations.push(liveStroke);
    state.dirty = true;
  }
  liveStroke = null;
  refreshOverlays();
}

function createTextBox(event, view) {
  if (!isLive(view)) return;
  const point = pagePoint(event, view);
  const [nx, ny] = toNorm(view.proxy, view.viewport, point.x, point.y);
  pushHistory();
  const annotation = {
    id: uid(),
    page: visibleToOriginal(view.visible),
    type: "text",
    color: state.color,
    x: nx,
    y: ny,
    fontSize: 16 / view.viewport.height,
    text: "",
  };
  state.annotations.push(annotation);
  state.dirty = true;
  renderAnnotations(view);
  const node = view.annotLayer.querySelector(`[data-annot="${annotation.id}"]`);
  if (node) {
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function eraseAt(event, view) {
  if (!isLive(view)) return;
  const point = pagePoint(event, view);
  const aspect = pageBox(view.proxy).w / pageBox(view.proxy).h;
  const target = toNorm(view.proxy, view.viewport, point.x, point.y);
  const [tx, ty] = [target[0] * aspect, target[1]];

  let bestId = null;
  let bestDistance = Infinity;
  for (const annotation of state.annotations) {
    if (annotation.type !== "ink" || annotation.page !== visibleToOriginal(view.visible)) continue;
    const points = annotation.points.map(([x, y]) => [x * aspect, y]);
    for (let i = 1; i < points.length; i++) {
      const distance = pointSegmentDistance(tx, ty, points[i - 1], points[i]);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = annotation.id;
      }
    }
  }
  if (bestId && bestDistance < 0.02) removeAnnotation(bestId);
}

function pointSegmentDistance(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (!lengthSq) return Math.hypot(px - a[0], py - a[1]);
  const t = clamp(((px - a[0]) * dx + (py - a[1]) * dy) / lengthSq, 0, 1);
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/* ------------------------------------------------------------------ */
/* Settings / UI wiring                                                */
/* ------------------------------------------------------------------ */

function fillVoices() {
  const selected = state.settings.voiceURI || "";
  ui.voiceSelect.replaceChildren(new Option("Browser default", ""));
  for (const voice of reader.voices) {
    const suffix = voice.localService ? "" : " — network";
    ui.voiceSelect.append(new Option(`${voice.name} (${voice.lang})${suffix}`, voice.voiceURI));
  }
  ui.voiceSelect.value = selected;
  if (ui.voiceSelect.value !== selected) ui.voiceSelect.value = "";
}

function applySettings() {
  state.color = state.settings.highlightColor || "#facc15";
  ui.colorInput.value = state.color;
  ui.rate.value = String(state.settings.rate ?? 1);
  ui.rateLabel.textContent = `${Number(ui.rate.value).toFixed(1)}×`;
  fillVoices();
  reader.rate = Number(state.settings.rate) || 1;
  reader.voiceURI = state.settings.voiceURI || "";
  applyAutoOpen();
}

/** The toolbar mirror of the “Open PDF links in PDF Reader” setting. */
function applyAutoOpen() {
  const on = state.settings.autoOpenPdf !== false;
  ui.btnAutoOpen.setAttribute("aria-pressed", String(on));
  ui.btnAutoOpen.title = on
    ? "PDF links open in PDF Reader — click to let Chrome open them instead"
    : "PDF links open in Chrome's viewer — click to open them in PDF Reader";
  if (ui.autoOpenHint) {
    ui.autoOpenHint.textContent = on
      ? "PDF links you click open here too. Turn that off with “Open PDFs here” in the toolbar."
      : "PDF links currently open in Chrome's own viewer. Drag a PDF here or use Open.";
  }
}

function toggleAutoOpen() {
  const on = state.settings.autoOpenPdf === false;
  state.settings.autoOpenPdf = on;
  applyAutoOpen();
  saveSettings({ autoOpenPdf: on }).catch(() => {});
  toast(on ? "PDF links will now open in PDF Reader." : "PDF links will now open in Chrome's viewer.");
}

function toggleReaderPanel(force) {
  const currentlyHidden = ui.readerPanel.parentElement.classList.contains("reader-hidden");
  const hidden = force ?? !currentlyHidden;
  ui.readerPanel.parentElement.classList.toggle("reader-hidden", hidden);
  ui.btnReader.setAttribute("aria-pressed", String(!hidden));
}

function wireEvents() {
  $("btnOpen").addEventListener("click", () => ui.fileInput.click());
  $("btnOpenBig").addEventListener("click", () => ui.fileInput.click());
  ui.fileInput.addEventListener("change", () => {
    const file = ui.fileInput.files?.[0];
    ui.fileInput.value = "";
    openFile(file).catch((error) => toast(error.message));
  });

  ui.prevPage.addEventListener("click", () => goToPage(state.pageNumber - 1));
  ui.nextPage.addEventListener("click", () => goToPage(state.pageNumber + 1));
  ui.pageInput.addEventListener("change", () => goToPage(ui.pageInput.value));
  ui.pageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      goToPage(ui.pageInput.value);
    }
  });

  $("btnZoomIn").addEventListener("click", () => setZoom(0.15));
  $("btnZoomOut").addEventListener("click", () => setZoom(-0.15));
  ui.zoomLabel.addEventListener("click", () => {
    state.zoomMode = "fit";
    void refreshStage();
  });

  for (const button of document.querySelectorAll(".tool")) {
    button.addEventListener("click", () => setTool(button.dataset.tool));
  }
  setTool("select");

  ui.colorInput.addEventListener("input", () => {
    state.color = ui.colorInput.value;
    saveSettings({ highlightColor: state.color }).catch(() => {});
  });
  ui.undo.addEventListener("click", undo);
  ui.save.addEventListener("click", savePdf);

  ui.btnReader.addEventListener("click", () => toggleReaderPanel());

  $("btnOptions").addEventListener("click", () => {
    if (chrome?.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(new URL("./options.html", import.meta.url).href, "_blank");
  });

  ui.rangeMode.addEventListener("change", () => setRangeMode(ui.rangeMode.value));
  setRangeMode(currentMode(), { clear: false });
  for (const input of [ui.startWord, ui.endWord]) {
    input.addEventListener("input", syncModeWithFields);
  }

  for (const input of [ui.startPage, ui.endPage, ui.startWord, ui.endWord]) {
    const edited = () => {
      // Editing the range hands the status line back to the preview.
      rangeStatusLocked = false;
      scheduleRangePreview();
    };
    input.addEventListener("input", edited);
    input.addEventListener("change", edited);
  }
  for (const [id, which] of [
    ["useStartSelection", "start"],
    ["useEndSelection", "end"],
  ]) {
    const button = $(id);
    button.addEventListener("pointerdown", (event) => {
      // Keep the page selection alive while the button is pressed.
      event.preventDefault();
      useSelectionAsAnchor(which);
    });
    // Keyboard activation (Enter/Space) has no pointer click detail.
    button.addEventListener("click", (event) => {
      if (event.detail === 0) useSelectionAsAnchor(which);
    });
  }

  ui.readRange.addEventListener("click", startReading);
  ui.stop.addEventListener("click", stopReading);

  ui.playPause.addEventListener("click", () => {
    if (reader.state === "playing" || reader.state === "paused") reader.toggle();
    else startReading();
  });

  ui.rate.addEventListener("input", () => {
    state.settings.rate = Number(ui.rate.value);
    ui.rateLabel.textContent = `${Number(ui.rate.value).toFixed(1)}×`;
    reader.rate = state.settings.rate;
  });
  ui.rate.addEventListener("change", () => {
    saveSettings({ rate: Number(ui.rate.value) }).catch(() => {});
    scheduleRangePreview();
  });

  ui.voiceSelect.addEventListener("change", () => {
    state.settings.voiceURI = ui.voiceSelect.value;
    reader.voiceURI = ui.voiceSelect.value;
    saveSettings({ voiceURI: ui.voiceSelect.value }).catch(() => {});
  });

  // Selection -> highlight. Page pointers are wired per page by wireView().
  document.addEventListener("mouseup", () => {
    if (state.tool === "highlight") addHighlightFromSelection();
  });

  ui.btnViewPaged.addEventListener("click", () => void setViewMode("paged"));
  ui.btnViewScroll.addEventListener("click", () => void setViewMode("scroll"));
  ui.btnAutoOpen.addEventListener("click", toggleAutoOpen);
  ui.stage.addEventListener("scroll", onStageScroll, { passive: true });

  // Drag and drop files.
  let dragDepth = 0;
  window.addEventListener("dragenter", (event) => {
    if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
    dragDepth++;
    ui.dropHint.hidden = false;
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) ui.dropHint.hidden = true;
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    ui.dropHint.hidden = true;
    const file = event.dataTransfer?.files?.[0];
    if (file) openFile(file).catch((error) => toast(error.message));
  });

  // Keyboard shortcuts.
  window.addEventListener("keydown", (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
    if (event.key === "Escape") {
      stopReading();
      return;
    }
    if (typing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
      event.preventDefault();
      ui.fileInput.click();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom(0.15);
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setZoom(-0.15);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        state.zoomMode = "fit";
        void refreshStage();
        return;
      }
    }
    if (event.key === "ArrowRight" || event.key === "PageDown") {
      goToPage(state.pageNumber + 1);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "PageUp") {
      goToPage(state.pageNumber - 1);
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      if (reader.state === "playing" || reader.state === "paused") reader.toggle();
      else startReading();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      const selected = ui.annotLayer.querySelector(".tx:focus");
      if (selected?.dataset.annot) removeAnnotation(selected.dataset.annot);
      return;
    }
    const shortcuts = { v: "select", h: "highlight", p: "pen", t: "text", e: "erase" };
    if (shortcuts[event.key.toLowerCase()]) setTool(shortcuts[event.key.toLowerCase()]);
  });

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.doc && state.zoomMode === "fit") void refreshStage();
    }, 180);
  });

  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function parseViewerParams() {
  const index = location.search.indexOf("file=");
  if (index === -1) return {};
  const raw = location.search.slice(index + 5);
  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  for (const candidate of [raw, decoded]) {
    if (/^(https?|file):\/\//i.test(candidate)) return { file: candidate };
  }
  return { file: raw };
}

async function boot() {
  state.settings = await loadSettings();
  applySettings();
  wireEvents();
  await setViewMode(state.settings.viewMode === "scroll" ? "scroll" : "paged", { persist: false });
  if (!Reader.supported) {
    ui.readRange.disabled = true;
    ui.playPause.disabled = true;
    setRangeStatus("This browser cannot read text aloud.", "error");
  }
  reader.whenVoicesReady().then(fillVoices);

  const params = parseViewerParams();
  if (params.file) {
    openUrl(params.file).catch((error) => {
      ui.empty.hidden = false;
      ui.docName.textContent = "No PDF open";
      toast(error.message, 6000);
    });
  } else {
    ui.empty.hidden = false;
    ui.docName.textContent = "No PDF open";
  }
}

boot();

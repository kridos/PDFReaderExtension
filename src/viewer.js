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
  wordMap: [],
};

let pageProxy = null;
let viewport = null;
let renderSeq = 0;
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
    if (s === "ended") ui.progressLabel.textContent = "Finished";
  },
  onProgress: ({ absolute, chunkIndex }) => {
    followReading(absolute);
    updateTranscriptProgress(chunkIndex);
    // Top up before the voice runs dry, so the next page is ready in time.
    if (feed && reader.chunks.length - reader.index <= 1) void pumpReading();
  },
  onStarved: () => void pumpReading(),
  onError: ({ reason }) => reportSpeechFailure(reason),
  onVoiceFallback: () =>
    toast("That voice could not speak here, so the system default voice is being used.", 6000),
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
    message = "The speech engine did not start. Press play again, or pick another voice in Settings.";
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
  pageProxy = null;
  viewport = null;
  state.wordMap = [];
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

  await renderPage();
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
  let name = "document.pdf";
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last) name = decodeURIComponent(last);
  } catch {
    /* keep the default name */
  }
  if (!/\.pdf$/i.test(name)) name += ".pdf";
  await openBytes(bytes, name, url);
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

async function renderPage() {
  if (!state.doc) return;
  const seq = ++renderSeq;
  const pageNo = state.pageNumber;
  const page = await getPage(visibleToOriginal(pageNo));
  if (seq !== renderSeq) return;

  const extra = state.rotations[visibleToOriginal(pageNo)] ?? 0;
  const rotation = (((page.rotate ?? 0) + extra) % 360 + 360) % 360;
  const base = page.getViewport({ scale: 1, rotation });
  if (state.zoomMode === "fit") {
    const available = Math.max(200, ui.stage.clientWidth - 48);
    state.scale = clamp(available / base.width, 0.1, 4);
  }
  const vp = page.getViewport({ scale: state.scale, rotation });
  pageProxy = page;
  viewport = vp;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ui.canvas.width = Math.max(1, Math.floor(vp.width * dpr));
  ui.canvas.height = Math.max(1, Math.floor(vp.height * dpr));
  ui.canvas.style.width = `${vp.width}px`;
  ui.canvas.style.height = `${vp.height}px`;
  ui.inkCanvas.width = ui.canvas.width;
  ui.inkCanvas.height = ui.canvas.height;
  ui.inkCanvas.style.width = `${vp.width}px`;
  ui.inkCanvas.style.height = `${vp.height}px`;
  ui.textLayer.style.width = `${vp.width}px`;
  ui.textLayer.style.height = `${vp.height}px`;
  ui.pageWrap.style.width = `${vp.width}px`;
  ui.pageWrap.style.height = `${vp.height}px`;

  const ctx = ui.canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;
  if (seq !== renderSeq) return;

  const textData = await getPageTextData(visibleToOriginal(pageNo));
  if (seq !== renderSeq) return;
  buildTextLayer(vp, textData);

  drawInk();
  renderAnnotations();
  updatePageUi();
  ui.zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;

  if (state.lastWord && state.lastWord.page === state.pageNumber) {
    highlightWord(state.lastWord.raw);
  }
}

function buildTextLayer(vp, textData) {
  ui.textLayer.replaceChildren();
  state.wordMap = [];
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
    span.style.top = `${vp.height - matrix[5] - fontSize * ASCENT}px`;

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
    state.wordMap.push(...words);
  }

  ui.textLayer.append(frag);
  state.wordMap.sort((a, b) => a.start - b.start);
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
  renderPage();
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
  if (!ui.textLayer.contains(range.commonAncestorContainer)) return false;
  if (!pageProxy || !viewport) return false;

  const pageRect = ui.pageWrap.getBoundingClientRect();
  const rects = [];
  for (const r of range.getClientRects()) {
    const left = Math.max(r.left, pageRect.left);
    const right = Math.min(r.right, pageRect.right);
    const top = Math.max(r.top, pageRect.top);
    const bottom = Math.min(r.bottom, pageRect.bottom);
    if (right - left < 1 || bottom - top < 1) continue;
    const a = toNorm(pageProxy, viewport, left - pageRect.left, top - pageRect.top);
    const b = toNorm(pageProxy, viewport, right - pageRect.left, bottom - pageRect.top);
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
    page: visibleToOriginal(state.pageNumber),
    type: "highlight",
    color: state.color,
    rects,
  });
  state.dirty = true;
  selection.removeAllRanges();
  renderAnnotations();
  toast("Highlight added.");
  return true;
}

function renderAnnotations() {
  ui.annotLayer.replaceChildren();
  if (!pageProxy || !viewport) return;
  const original = visibleToOriginal(state.pageNumber);
  const vp = viewport;

  for (const a of state.annotations) {
    if (a.page !== original) continue;

    if (a.type === "highlight") {
      for (const r of a.rects) {
        const bottomLeft = fromNorm(pageProxy, vp, r.x, r.y);
        const topRight = fromNorm(pageProxy, vp, r.x + r.w, r.y + r.h);
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
        ui.annotLayer.append(div);
      }
      continue;
    }

    if (a.type === "text") {
      const point = fromNorm(pageProxy, vp, a.x, a.y);
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
          renderAnnotations();
        }
        state.dirty = true;
      });
      ui.annotLayer.append(div);
    }
  }
}

function drawInk() {
  const ctx = ui.inkCanvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ui.inkCanvas.width, ui.inkCanvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (!pageProxy || !viewport) return;
  const original = visibleToOriginal(state.pageNumber);
  const strokes = state.annotations.filter((a) => a.type === "ink" && a.page === original);
  if (liveStroke) strokes.push(liveStroke);

  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(0.6, stroke.strokeWidth * viewport.height);
    ctx.beginPath();
    stroke.points.forEach((point, i) => {
      const [x, y] = fromNorm(pageProxy, viewport, point[0], point[1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (stroke.points.length === 1) {
      const [x, y] = fromNorm(pageProxy, viewport, stroke.points[0][0], stroke.points[0][1]);
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
  renderAnnotations();
  drawInk();
}

/* ------------------------------------------------------------------ */
/* Toolbar / navigation                                                */
/* ------------------------------------------------------------------ */

function setTool(tool) {
  state.tool = tool;
  ui.pageWrap.dataset.tool = tool;
  for (const button of document.querySelectorAll(".tool")) {
    button.classList.toggle("active", button.dataset.tool === tool);
  }
  if (tool === "highlight") addHighlightFromSelection();
  else if (tool !== "select" && tool !== "text") window.getSelection()?.removeAllRanges();
}

async function goToPage(pageNumber) {
  if (!state.doc) return;
  const target = clampInt(pageNumber, 1, Math.max(1, state.pageOrder.length));
  if (target === state.pageNumber && pageProxy) {
    updatePageUi();
    return;
  }
  state.pageNumber = target;
  await renderPage();
}

function updatePageUi() {
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
}

function setZoom(delta) {
  state.zoomMode = "manual";
  state.scale = clamp(state.scale + delta, 0.15, 4);
  renderPage();
}

/* ------------------------------------------------------------------ */
/* Thumbnails and page operations                                      */
/* ------------------------------------------------------------------ */

let thumbObserver = null;

function buildThumbs() {
  thumbToken++;
  const token = thumbToken;
  if (thumbObserver) thumbObserver.disconnect();
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
    const scale = Math.min(1, 150 / base.width);
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
  if (visible === state.pageNumber) renderPage();
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
  renderPage();
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
  renderPage();
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
      // Nothing more is coming: let the queue drain and report the result.
      reader.close();
      if (!active.finished) {
        active.finished = true;
        const r = active.range;
        const words = r.wordCount();
        setRangeStatus(
          `Read ${active.loaded} of ${active.span} pages · ${words.toLocaleString()} words.`,
          "ok",
        );
      }
    }
  } finally {
    pumping = false;
  }
}

function updateReadingStatus(active) {
  if (active !== feed || active.finished) return;
  setRangeStatus(`Reading · ${active.loaded} of ${active.span} pages loaded`);
}

function rangeInputs() {
  const total = Math.max(1, state.pageOrder.length);
  // Both page fields are optional: an empty "To page" means "no stopping point",
  // so reading continues to the end of the document.
  const from = String(ui.startPage.value ?? "").trim();
  const to = String(ui.endPage.value ?? "").trim();
  const startPage = from ? clampInt(from, 1, total) : 1;
  const endPage = to ? clampInt(to, 1, total) : total;
  return {
    startPage: Math.min(startPage, endPage),
    endPage: Math.max(startPage, endPage),
    openEnded: !to,
    startWord: ui.startWord.value,
    endWord: ui.endWord.value,
  };
}

/** Text currently selected inside the page's text layer. */
function selectedPageText() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
  const range = selection.getRangeAt(0);
  if (!ui.textLayer.contains(range.startContainer) || !ui.textLayer.contains(range.endContainer)) {
    return "";
  }
  return selection.toString().replace(/\s+/g, " ").trim();
}

/** Use the selected word as the start or end anchor for the page you are on. */
function useSelectionAsAnchor(which) {
  const text = selectedPageText();
  if (!text) {
    toast("Select a word or phrase on the page first.");
    return;
  }
  const page = state.pageNumber;
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
  const shown = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  toast(`Range ${which} set to “${shown}”.`);
}

function scheduleRangePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updateRangePreview, 260);
}

function previewSummary(range, inputs) {
  const pages = `Pages ${inputs.startPage}–${inputs.endPage}`;
  const bits = [inputs.openEnded ? `${pages} · to the end of the document` : pages];
  if (range.startMatch) bits.push(`starts on page ${range.startMatch.pageNumber}`);
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
  const span = inputs.endPage - inputs.startPage + 1;
  if (span > 60) {
    const end = inputs.openEnded ? " (to the end of the document)" : "";
    setRangeStatus(`Pages ${inputs.startPage}–${inputs.endPage}${end}. Press “Read range” to start reading them.`);
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
  if (active) active.scrollIntoView({ block: "nearest" });
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
  if (location.pageNumber === state.pageNumber) highlightWord(location.raw);
}

function highlightWord(rawOffset) {
  if (!state.wordMap.length) return;
  let previous = ui.textLayer.querySelector(".w.reading");
  if (previous) previous.classList.remove("reading");

  let found = null;
  let low = 0;
  let high = state.wordMap.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const entry = state.wordMap[mid];
    if (rawOffset < entry.start) high = mid - 1;
    else if (rawOffset >= entry.end) low = mid + 1;
    else {
      found = entry;
      break;
    }
  }
  if (!found) found = state.wordMap[clamp(low, 0, state.wordMap.length - 1)];

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
  try {
    const bytes = await buildEditedPdf(state.bytes, {
      annotations: state.annotations,
      pageOrder: state.pageOrder,
      rotations: state.rotations,
    });
    const blob = new Blob([bytes], { type: "application/pdf" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = state.fileName.replace(/\.pdf$/i, "") + "-edited.pdf";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    state.dirty = false;
    toast("Saved a copy with your edits.");
  } catch (error) {
    toast(`Could not save: ${error.message}`, 5000);
  } finally {
    ui.save.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Pointer input                                                       */
/* ------------------------------------------------------------------ */

function pagePoint(event) {
  const rect = ui.pageWrap.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function startInk(event) {
  if (state.tool !== "pen" || !pageProxy || !viewport) return;
  const point = pagePoint(event);
  liveStroke = {
    id: uid(),
    page: visibleToOriginal(state.pageNumber),
    type: "ink",
    color: state.color,
    strokeWidth: 1.8 / viewport.height,
    points: [toNorm(pageProxy, viewport, point.x, point.y)],
  };
  try {
    ui.inkCanvas.setPointerCapture(event.pointerId);
  } catch {
    /* The pointer may already be gone; drawing still works without capture. */
  }
  drawInk();
}

function moveInk(event) {
  if (!liveStroke || state.tool !== "pen") return;
  const point = pagePoint(event);
  const last = liveStroke.points[liveStroke.points.length - 1];
  const next = toNorm(pageProxy, viewport, point.x, point.y);
  if (Math.hypot(next[0] - last[0], next[1] - last[1]) < 0.0015) return;
  liveStroke.points.push(next);
  drawInk();
}

function endInk(event) {
  if (!liveStroke) return;
  if (event?.type === "pointerup") {
    const point = pagePoint(event);
    liveStroke.points.push(toNorm(pageProxy, viewport, point.x, point.y));
  }
  if (liveStroke.points.length > 1) {
    pushHistory();
    state.annotations.push(liveStroke);
    state.dirty = true;
  }
  liveStroke = null;
  drawInk();
}

function createTextBox(event) {
  if (!pageProxy || !viewport) return;
  const point = pagePoint(event);
  const [nx, ny] = toNorm(pageProxy, viewport, point.x, point.y);
  pushHistory();
  const annotation = {
    id: uid(),
    page: visibleToOriginal(state.pageNumber),
    type: "text",
    color: state.color,
    x: nx,
    y: ny,
    fontSize: 16 / viewport.height,
    text: "",
  };
  state.annotations.push(annotation);
  state.dirty = true;
  renderAnnotations();
  const node = ui.annotLayer.querySelector(`[data-annot="${annotation.id}"]`);
  if (node) {
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function eraseAt(event) {
  if (!pageProxy || !viewport) return;
  const point = pagePoint(event);
  const aspect = pageBox(pageProxy).w / pageBox(pageProxy).h;
  const target = toNorm(pageProxy, viewport, point.x, point.y);
  const [tx, ty] = [target[0] * aspect, target[1]];

  let bestId = null;
  let bestDistance = Infinity;
  for (const annotation of state.annotations) {
    if (annotation.type !== "ink" || annotation.page !== visibleToOriginal(state.pageNumber)) continue;
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
    renderPage();
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

  // Selection -> highlight.
  document.addEventListener("mouseup", () => {
    if (state.tool === "highlight") addHighlightFromSelection();
  });

  ui.pageWrap.addEventListener("pointerdown", (event) => {
    if (state.tool === "text") {
      if (event.target.closest("[data-annot]") && event.target.isContentEditable) return;
      createTextBox(event);
    }
  });

  ui.pageWrap.addEventListener("click", (event) => {
    if (state.tool !== "erase") return;
    const node = event.target.closest("[data-annot]");
    if (node) removeAnnotation(node.dataset.annot);
  });

  ui.inkCanvas.addEventListener("pointerdown", (event) => {
    if (state.tool === "pen") startInk(event);
    else if (state.tool === "erase") eraseAt(event);
  });
  ui.inkCanvas.addEventListener("pointermove", moveInk);
  ui.inkCanvas.addEventListener("pointerup", endInk);
  ui.inkCanvas.addEventListener("pointercancel", endInk);

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
        renderPage();
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
      if (state.doc && state.zoomMode === "fit") renderPage();
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

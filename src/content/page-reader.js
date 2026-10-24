// Injected on demand into a web page to read it aloud with the same start/end
// word anchors as the PDF viewer. Loaded as a classic content script together
// with range.core.js and reader.core.js, so it can use their globals.
(() => {
  const NS = (globalThis.__PDFREADER__ = globalThis.__PDFREADER__ || {});
  if (NS.pageReader) {
    NS.pageReader.toggle();
    return;
  }

  const { buildReadingRange, splitIntoChunks } = NS.range;
  const { Reader } = NS;

  const HOST_ID = "pdfreader-host";
  const STYLE_ID = "pdfreader-highlight-style";
  const HIGHLIGHT = "pdfreader-word";
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "CANVAS", "VIDEO", "AUDIO",
    "INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "NAV", "FOOTER", "ASIDE", "FORM",
  ]);

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  let host = null;
  let refs = null;
  let page = { raw: "", segments: [], words: 0 };
  let current = null;
  let previewTimer = 0;

  const reader = new Reader({
    onState: (state) => {
      if (!refs) return;
      const playing = state === "playing";
      refs.pause.textContent = playing ? "Pause" : "Resume";
      refs.pause.disabled = !(playing || state === "paused");
      refs.stop.disabled = state === "idle" || state === "ended";
      if (state === "ended") {
        refs.pause.disabled = true;
        setStatus("Finished reading.", "ok");
      }
    },
    onProgress: ({ absolute }) => {
      if (!current || !current.segments.length) return;
      const segment = current.segments[0];
      const local = current.startOffset + absolute - segment.start;
      const index = clamp(local, 0, segment.map.length - 1);
      const rawOffset = segment.map[index];
      if (rawOffset != null) highlightAt(rawOffset);
    },
  });

  /* ------------------------------ extraction ------------------------------ */

  function pickRoot() {
    const body = document.body;
    if (!body) return null;
    const candidates = [...document.querySelectorAll("article, main, [role='main']")].filter(
      (element) => element !== host && element.checkVisibility?.({ checkVisibilityCSS: true }) !== false,
    );
    let best = null;
    let bestLength = 0;
    for (const element of candidates) {
      const length = (element.innerText || "").trim().length;
      if (length > bestLength) {
        best = element;
        bestLength = length;
      }
    }
    // Only trust an article/main container when it actually holds the content.
    return best && bestLength >= 400 ? best : body;
  }

  function extractText(root) {
    const segments = [];
    let raw = "";

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
        if (node.id === HOST_ID) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        if (node.getAttribute("aria-hidden") === "true") return NodeFilter.FILTER_REJECT;
        if (node.checkVisibility && !node.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    });

    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const text = node.data;
      if (!text) continue;
      // Keep words from separate blocks from gluing together.
      if (raw && !/\s$/.test(raw) && !/^\s/.test(text)) raw += " ";
      const start = raw.length;
      raw += text;
      segments.push({ node, start, end: raw.length });
    }

    return { raw, segments, words: (raw.match(/\S+/g) || []).length };
  }

  function refresh() {
    const root = pickRoot();
    page = root ? extractText(root) : { raw: "", segments: [], words: 0 };
    if (!page.words) {
      refs.read.disabled = true;
      setStatus("No readable text found on this page.", "error");
      return;
    }
    ensureHighlightStyle();
    previewRange();
  }

  /* ------------------------------ offsets -------------------------------- */

  function segmentAt(offset) {
    let low = 0;
    let high = page.segments.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const segment = page.segments[mid];
      if (offset < segment.start) high = mid - 1;
      else if (offset >= segment.end) low = mid + 1;
      else return segment;
    }
    return null;
  }

  function wordBounds(text, index) {
    if (!text) return null;
    let i = clamp(index, 0, text.length - 1);
    if (/\s/.test(text[i])) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (i >= text.length) return null;
    }
    let start = i;
    let end = i;
    while (start > 0 && !/\s/.test(text[start - 1])) start--;
    while (end < text.length && !/\s/.test(text[end])) end++;
    return { start, end };
  }

  function rangeForOffset(rawOffset) {
    const bounds = wordBounds(page.raw, rawOffset);
    if (!bounds) return null;
    const first = segmentAt(bounds.start);
    const last = segmentAt(bounds.end - 1);
    if (!first?.node.isConnected || !last?.node.isConnected) return null;
    const range = document.createRange();
    range.setStart(first.node, clamp(bounds.start - first.start, 0, first.node.data.length));
    range.setEnd(last.node, clamp(bounds.end - last.start, 0, last.node.data.length));
    return range;
  }

  /* ----------------------------- highlighting ---------------------------- */

  function ensureHighlightStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `::highlight(${HIGHLIGHT}) { background-color: #fde047; color: #111827; }`;
    (document.head || document.documentElement).append(style);
  }

  function highlightAt(rawOffset) {
    const range = rangeForOffset(rawOffset);
    if (!range) {
      clearHighlight();
      return;
    }
    try {
      CSS.highlights.set(HIGHLIGHT, new Highlight(range));
    } catch {
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.top < 80 || rect.bottom > window.innerHeight - 80) {
      const element =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? range.startContainer
          : range.startContainer.parentElement;
      element?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function clearHighlight() {
    try {
      CSS.highlights.delete(HIGHLIGHT);
    } catch {
      /* Highlight API unavailable */
    }
  }

  /* ------------------------------- panel --------------------------------- */

  function setStatus(text, kind = "") {
    if (!refs) return;
    refs.status.textContent = text;
    if (kind) refs.status.dataset.kind = kind;
    else delete refs.status.dataset.kind;
  }

  function rangeInfo() {
    return buildReadingRange([{ pageNumber: 1, raw: page.raw }], {
      startPage: 1,
      endPage: 1,
      startWord: refs.startWord.value,
      endWord: refs.endWord.value,
      totalPages: 1,
    });
  }

  function previewRange() {
    if (!page.words) return null;
    const info = rangeInfo();
    if (!info.ok) {
      refs.read.disabled = true;
      setStatus(info.error, "error");
      return null;
    }
    const words = info.text.split(/\s+/).filter(Boolean).length;
    const minutes = words / (165 * (Number(refs.rate.value) || 1));
    setStatus(`${words.toLocaleString()} words · ${minutes < 1 ? "under a minute" : `about ${Math.round(minutes)} min`}`, "ok");
    refs.read.disabled = false;
    return info;
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(previewRange, 200);
  }

  function startReading() {
    if (!page.words || !refs) return;
    if (!Reader.supported) {
      setStatus("This browser cannot read text aloud.", "error");
      return;
    }
    const info = rangeInfo();
    if (!info.ok) {
      setStatus(info.error, "error");
      return;
    }
    const chunks = splitIntoChunks(info.text, 280);
    if (!chunks.length) {
      setStatus("There is nothing to read in that range.", "error");
      return;
    }
    current = info;
    clearHighlight();
    reader.rate = Number(refs.rate.value) || 1;
    reader.voiceURI = refs.voice.value || "";
    reader.load({ ...info, chunks });
    reader.play();
    refs.stop.disabled = false;
    refs.pause.disabled = false;
    setStatus(`Reading from “${clip(info.text)}”`, "ok");
  }

  function clip(text) {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
  }

  function stopReading() {
    reader.stop();
    clearHighlight();
    current = null;
    if (refs) {
      refs.stop.disabled = true;
      refs.pause.disabled = true;
      refs.pause.textContent = "Pause";
      previewRange();
    }
  }

  function useSelection(which) {
    const selection = window.getSelection();
    const text = selection && !selection.isCollapsed ? selection.toString().replace(/\s+/g, " ").trim() : "";
    if (!text) {
      setStatus("Select a word or phrase on the page first.", "error");
      return;
    }
    if (which === "start") refs.startWord.value = text;
    else refs.endWord.value = text;
    previewRange();
  }

  function fillVoices(selected = "") {
    const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    refs.voice.replaceChildren(new Option("Browser default", ""));
    for (const voice of voices) refs.voice.append(new Option(`${voice.name} (${voice.lang})`, voice.voiceURI));
    refs.voice.value = selected;
    if (refs.voice.value !== selected) refs.voice.value = "";
  }

  function persist(patch) {
    try {
      chrome.storage.sync.set(patch);
    } catch {
      /* storage unavailable */
    }
  }

  const PANEL_CSS = `
:host { all: initial; }
        * { box-sizing: border-box; }
        .panel {
          width: 330px; padding: 12px; border-radius: 12px;
          background: #151821; color: #e7e9f0; border: 1px solid #2c3242;
          box-shadow: 0 18px 44px rgba(0,0,0,.45);
          font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .title { font-weight: 600; font-size: 13px; letter-spacing: .02em; }
        .icon {
          background: transparent; border: 0; color: #939cb2; font-size: 18px; line-height: 1;
          cursor: pointer; padding: 2px 6px; border-radius: 6px;
        }
        .icon:hover { background: #232839; color: #e7e9f0; }
        .status {
          margin: 0 0 10px; padding: 7px 8px; border-radius: 7px;
          background: #10131b; border: 1px solid #262b39; color: #939cb2;
          font-size: 12px; min-height: 32px;
        }
        .status[data-kind="ok"] { color: #a7f3d0; border-color: #115e59; }
        .status[data-kind="error"] { color: #fca5a5; border-color: #7f1d1d; }
        label { display: block; font-size: 11.5px; color: #939cb2; margin-bottom: 8px; }
        .with-btn { display: flex; gap: 6px; margin-top: 4px; }
        input[type="text"], select {
          width: 100%; background: #0f1219; color: #e7e9f0; border: 1px solid #262b39;
          border-radius: 6px; padding: 6px 8px; font: inherit;
        }
        input[type="text"]:focus, select:focus { outline: none; border-color: #6366f1; }
        .with-btn input { flex: 1; min-width: 0; }
        button {
          font: inherit; cursor: pointer; border-radius: 7px; padding: 7px 10px;
          background: #232839; color: #e7e9f0; border: 1px solid #262b39;
        }
        button:hover:not(:disabled) { border-color: #3a4257; background: #282e3f; }
        button:disabled { opacity: .45; cursor: default; }
        button.tiny { padding: 4px 7px; font-size: 11px; white-space: nowrap; }
        button.primary { background: #6366f1; border-color: #6366f1; color: #fff; }
        button.primary:hover:not(:disabled) { background: #5558e6; border-color: #5558e6; }
        .row { display: flex; gap: 6px; margin-top: 4px; }
        .row > button { flex: 1; }
        .speed { margin: 10px 0 4px; }
        .speed input { width: 100%; accent-color: #6366f1; margin-top: 4px; }
        output { color: #939cb2; font-variant-numeric: tabular-nums; }
        .voice-row { margin-top: 6px; }
        footer {
          display: flex; justify-content: space-between; gap: 8px;
          margin-top: 10px; padding-top: 8px; border-top: 1px solid #262b39;
        }
        footer a { color: #818cf8; text-decoration: none; font-size: 11.5px; cursor: pointer; }
        footer a:hover { text-decoration: underline; }
        .hint { margin: 0 0 8px; font-size: 11px; color: #7c869d; line-height: 1.4; }
`;

  const PANEL_HTML = `
<div class="panel" role="dialog" aria-label="Read this page aloud">
        <header>
          <span class="title">Read this page</span>
          <button class="icon close" type="button" title="Close">×</button>
        </header>
        <p class="status">Reading this page…</p>
        <label>Start at word
          <span class="with-btn">
            <input class="start-word" type="text" placeholder="top of page" spellcheck="false" />
            <button class="tiny use-start" type="button">Use selection</button>
          </span>
        </label>
        <label>End at word
          <span class="with-btn">
            <input class="end-word" type="text" placeholder="end of page" spellcheck="false" />
            <button class="tiny use-end" type="button">Use selection</button>
          </span>
        </label>
        <p class="hint">Type an anchor, or select a word on the page and press Use selection.</p>
        <div class="row">
          <button class="primary read" type="button">Read</button>
          <button class="pause" type="button" disabled>Pause</button>
          <button class="stop" type="button" disabled>Stop</button>
        </div>
        <label class="speed">Speed <output class="rate-out">1.0×</output>
          <input class="rate" type="range" min="0.5" max="8" step="0.1" value="1" />
        </label>
        <label class="voice-row">Voice<select class="voice"></select></label>
        <footer>
          <a class="open-pdf" role="button" tabindex="0">PDF viewer</a>
          <a class="open-settings" role="button" tabindex="0">Settings</a>
        </footer>
      </div>
`;

  function buildPanel() {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "all: initial; position: fixed; inset: auto 20px 20px auto; z-index: 2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    // Parsed with DOMParser so pages enforcing Trusted Types still work.
    const parsed = new DOMParser().parseFromString(PANEL_HTML, "text/html");
    shadow.append(style, document.importNode(parsed.body.firstElementChild, true));

    refs = {
      status: shadow.querySelector(".status"),
      startWord: shadow.querySelector(".start-word"),
      endWord: shadow.querySelector(".end-word"),
      read: shadow.querySelector(".read"),
      pause: shadow.querySelector(".pause"),
      stop: shadow.querySelector(".stop"),
      rate: shadow.querySelector(".rate"),
      rateOut: shadow.querySelector(".rate-out"),
      voice: shadow.querySelector(".voice"),
    };

    document.documentElement.append(host);

    shadow.querySelector(".close").addEventListener("click", close);
    refs.read.addEventListener("click", startReading);
    refs.pause.addEventListener("click", () => reader.toggle());
    refs.stop.addEventListener("click", stopReading);

    for (const [selector, which] of [
      [".use-start", "start"],
      [".use-end", "end"],
    ]) {
      const button = shadow.querySelector(selector);
      button.addEventListener("pointerdown", (event) => {
        // Keep the page selection while the button is pressed.
        event.preventDefault();
        useSelection(which);
      });
      button.addEventListener("click", (event) => {
        if (event.detail === 0) useSelection(which);
      });
    }

    for (const input of [refs.startWord, refs.endWord]) {
      input.addEventListener("input", schedulePreview);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") startReading();
      });
    }

    refs.rate.addEventListener("input", () => {
      refs.rateOut.textContent = `${Number(refs.rate.value).toFixed(1)}×`;
      reader.rate = Number(refs.rate.value) || 1;
      schedulePreview();
    });
    refs.rate.addEventListener("change", () => persist({ rate: Number(refs.rate.value) || 1 }));
    refs.voice.addEventListener("change", () => {
      reader.voiceURI = refs.voice.value;
      persist({ voiceURI: refs.voice.value });
    });

    shadow.querySelector(".open-pdf").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "pdfreader:open-viewer" }).catch(() => {});
    });
    shadow.querySelector(".open-settings").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "pdfreader:open-options" }).catch(() => {});
    });

    window.speechSynthesis?.addEventListener("voiceschanged", () => fillVoices(refs.voice.value));
  }

  async function loadSettings() {
    let settings = null;
    try {
      settings = await chrome.runtime.sendMessage({ type: "pdfreader:get-settings" });
    } catch {
      settings = null;
    }
    const rate = Number(settings?.rate ?? 1) || 1;
    refs.rate.value = String(rate);
    refs.rateOut.textContent = `${rate.toFixed(1)}×`;
    reader.rate = rate;
    reader.voiceURI = settings?.voiceURI || "";
    fillVoices(reader.voiceURI);
  }

  /* ------------------------------ lifecycle ------------------------------ */

  function open() {
    host.style.display = "";
    clearTimeout(previewTimer);
    refresh();
    loadSettings();
  }

  function close() {
    reader.stop();
    clearHighlight();
    current = null;
    if (refs) {
      refs.stop.disabled = true;
      refs.pause.disabled = true;
    }
    host.style.display = "none";
  }

  function toggle() {
    if (host.style.display === "none") open();
    else close();
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type === "pdfreader:toggle") {
      toggle();
      respond?.({ ok: true, open: host.style.display !== "none" });
    } else if (message?.type === "pdfreader:close") {
      close();
      respond?.({ ok: true });
    }
  });

  window.addEventListener("pagehide", () => {
    try {
      reader.stop();
    } catch {
      /* ignore */
    }
  });

  buildPanel();
  open();

  NS.pageReader = {
    open,
    close,
    toggle,
    getText: () => page.raw,
    getWords: () => page.words,
  };
})();

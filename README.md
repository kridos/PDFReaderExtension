# PDF Reader — read PDFs and web pages aloud

A Chrome extension (Manifest V3) that reads **PDFs and ordinary web pages** aloud
starting at one word and stopping at another, so you never have to select a whole
passage just to hear it. PDFs open in a built-in viewer where you can annotate,
rearrange pages and save a new copy.

- **Word anchors, not selections** — set the start and end of the reading with two
  separate words or phrases, typed or taken from the current selection.
- **Follow along** — the spoken word is highlighted as it is read, and the PDF
  viewer turns pages for you.
- **Local only** — pdf.js renders, pdf-lib writes, Chrome's own speech
  synthesiser speaks. Nothing is uploaded and no API key is needed.
- **No build step** — the extension loads unpacked as-is; pdf.js and pdf-lib are
  vendored in `src/vendor/`.

Status: version 0.1.0, in development. All automated suites pass (27 unit / 7
viewer / 2 extension tests — see [Testing](#testing)).

## Contents

- [What it does](#what-it-does)
- [Install and run](#install-and-run)
- [Reading a PDF range aloud](#reading-a-pdf-range-aloud)
- [Reading a web page](#reading-a-web-page)
- [Annotating and editing PDFs](#annotating-and-editing-pdfs)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Settings](#settings)
- [Permissions and privacy](#permissions-and-privacy)
- [How it works](#how-it-works)
- [Testing](#testing)
- [Limitations](#limitations)
- [Future features](#future-features)
- [Development](#development)

## What it does

| PDFs | Web pages |
| --- | --- |
| Open from links, HTTP(S) URLs or local files | Click the toolbar icon on any normal page |
| Read a page range or a word-to-word range | Read a word-to-word range |
| Highlight, pen, text boxes, erase, undo | Highlight the spoken word in place |
| Rotate, delete and reorder pages | Page scrolls to keep the word visible |
| Save a new PDF with edits baked in | Panel can jump to the PDF viewer or settings |

## Install and run

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this repository folder.
4. Use it:
   - **On a web page:** click the extension icon to open the read-aloud panel;
     click the icon again to hide it.
   - **On a PDF:** click any `.pdf` link (it opens in the viewer), or use **Open**
     in the viewer toolbar to pick a local file.
   - **On pages Chrome will not allow scripts on** (for example the Web Store),
     a brief “!” badge appears instead of a panel.
   - **Anywhere else** (`chrome://` pages, the new tab page): the icon opens the
     empty PDF viewer.

After changing any source file, press **Reload** on the extension card in
`chrome://extensions` and refresh open tabs.

## Reading a PDF range aloud

Open a PDF, then use the **Read aloud** panel on the right:

- **From page / To page** — the inclusive page range. Both are optional:
  **To page** can be left empty for a range with no stopping point, which keeps
  reading to the end of the document, and **From page** can be left empty to
  start at the first page. With both empty the whole document is read.
- **Start at word** — reading begins at the first occurrence of this word or
  phrase inside the range. Leave it empty to start at the top of the first page.
  With an open-ended range, `From page` plus a start word is all you need: “read
  from this paragraph onwards”.
- **End at word** — reading stops **right after** the first occurrence of this
  word or phrase that comes after the start point. Leave it empty to read to the
  end of the range.
- **Use selection** next to either field takes the word or phrase you have
  selected on the page, and moves the matching page bound to the page you are on
  so the anchor stays inside the range.

Matching is case-insensitive and ignores line breaks, so `the river was cold`
still matches when the PDF wraps it. The status line under the fields reports
which page each anchor matched, and with an end word it also reports the word
count and an estimated duration — a surprising match is visible before you press
**Read range**. Missing anchors produce an explicit message instead of a silently
different range.

**Pages are read in as they are needed.** Nothing is parsed beyond the page you
are looking at until you press **Read range**: the viewer then reads the start
page, begins speaking, and parses the next page while the voice is still working
through the current one, keeping a few sentences queued ahead. A 400-page range
therefore starts talking almost immediately instead of after every page has been
extracted, and an end word thousands of pages in costs nothing until reading
reaches it. The status line shows `Reading · 4 of 40 pages loaded` as it goes,
and the per-page word cache means a page that has been read once (by reading or
by paging through it) is instant afterwards. Because of this, a range with no end
word has no up-front duration estimate; the real word count appears in the status
line when the reading finishes.

While reading, the current word is highlighted in the page text and the viewer
turns pages automatically. The **Reading** list shows the sentences as they are
spoken and can be clicked to jump to one. **Stop**, play/pause and the speed
slider are in the same panel; voice, speed and pitch live in [Settings](#settings).
Speed runs from 0.5× to 8×, and changes take effect from the next sentence.
Chrome's own voices vary above roughly 3×: some keep going cleanly, others turn
buzzy or stop getting faster, so try the range on the voice you use.

**When the voice cannot speak.** Chrome sometimes refuses a sentence outright —
a voice that is no longer installed, a network voice while offline, or an engine
left paused by an earlier stop. That used to be silent: the queue ended and the
panel looked idle with the text sitting in the **Reading** list. Now the status
line and a toast say what happened, for example `The speech engine could not
produce sound (synthesis-failed). Pick a different voice in Settings, or slow the
speed down.` If the voice you picked cannot speak, the sentence is retried on the
default system voice and reading carries on. A sentence that neither starts nor
reports an error within a few seconds is reported as `did not start` instead of
leaving the player looking busy.

## Reading a web page

Click the extension icon on any ordinary page and a compact panel appears in the
bottom-right corner.

- The page text is extracted **when the panel opens**. Article or main content is
  preferred, and navigation, sidebars, footers, forms, buttons, scripts and
  hidden elements are skipped.
- **Start at word**, **End at word** and **Use selection** behave exactly as they
  do for PDFs.
- The word being spoken is highlighted on the page through the CSS Custom
  Highlight API, so the page's DOM is never modified, and the page scrolls to keep
  the current word in view. This still works on sites that enforce Trusted Types.
- **Read / Pause / Stop**, speed and voice are all in the panel and share the
  same settings as the PDF viewer. Closing the panel or navigating away stops the
  reading, and the footer links to the PDF viewer and settings.
- Pressing <kbd>Enter</kbd> in either anchor field starts reading.

Text is re-extracted every time the panel opens, so pages that build themselves
after load are handled. Pages with no selectable text (canvas apps, image-only
pages) say so instead of reading nothing.

## Annotating and editing PDFs

| Tool | What it does |
| --- | --- |
| **Select** | Select text normally; click a text box to edit it |
| **Highlight** | Select text, then switch to this tool (or press <kbd>H</kbd>) to turn the selection into a highlight |
| **Pen** | Freehand ink in the current colour |
| **Text** | Click the page to place a text box |
| **Erase** | Click a highlight, text box or ink stroke to remove it |

Annotations are stored in page space, so they stay put when you zoom, rotate or
reorder pages. **Undo** (<kbd>Ctrl</kbd>+<kbd>Z</kbd>) covers annotations and page
operations. The annotation colour is remembered between sessions.

Page operations live in the thumbnail sidebar: rotate left/right, delete, and
drag a thumbnail to reorder. The last remaining page cannot be deleted.

**Save PDF** downloads a copy named `<name>-edited.pdf` with the page order,
rotations and annotations baked in. Text boxes are written with the standard
Helvetica font, so characters outside Latin-1 are saved as `?`; highlights, ink
and page operations are unaffected.

Annotations live in the tab until you save, so Chrome warns before closing a tab
with unsaved edits.

## Keyboard shortcuts

These apply in the PDF viewer and are ignored while typing in a field:

| Keys | Action |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>O</kbd> | Open a local PDF |
| <kbd>←</kbd> / <kbd>→</kbd> or <kbd>PageUp</kbd> / <kbd>PageDown</kbd> | Previous / next page |
| <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>Ctrl</kbd>+<kbd>−</kbd> | Zoom in / out |
| <kbd>Ctrl</kbd>+<kbd>0</kbd> | Fit to width |
| <kbd>Space</kbd> | Read / pause the current range |
| <kbd>Esc</kbd> | Stop reading |
| <kbd>V</kbd> <kbd>H</kbd> <kbd>P</kbd> <kbd>T</kbd> <kbd>E</kbd> | Select, Highlight, Pen, Text, Erase |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo |
| <kbd>Delete</kbd> | Remove a focused text box |

## Settings

Open with the ⚙ button in the viewer toolbar, the panel footer, or
`chrome://extensions` → Details → Extension options.

- **Open PDF links in PDF Reader** — takeover of `.pdf` navigations; turn it off
  to keep Chrome's built-in viewer.
- **Voice**, **Speed** (0.5×–8×), **Pitch** — used by both the PDF viewer and the
  page panel.
- **Turn pages automatically** — follow the reader onto the next PDF page.
- **Test voice** — hear the current voice, speed and pitch immediately.

Settings are stored with `chrome.storage.sync`.

## Permissions and privacy

- **Host access to http/https pages** — fetch PDFs you open and inject the
  read-aloud panel.
- **`scripting`** — inject that panel, only when you click the icon.
- **`declarativeNetRequest` / `webRequest`** — route `.pdf` links and PDF
  responses into the viewer.
- **`storage`** — remember voice, speed and the PDF takeover setting.

PDFs are parsed and edited locally with pdf.js and pdf-lib; speech uses Chrome's
built-in synthesis. No document or page text is sent anywhere, and there are no
API keys or remote services.

## How it works

```
manifest.json
src/viewer.html             viewer UI
src/viewer.js               rendering, text layer, annotations, range wiring
src/lib/pdftext.js          pdf.js text extraction with offsets
src/lib/exporter.js         pdf-lib export of page order, rotation, annotations
src/lib/settings.js         chrome.storage settings with localStorage fallback
src/content/page-reader.js  injected page reader: extraction, highlight, panel
src/lib/range.core.js       page range + word anchors + sentence chunking; also
                            the incremental reader the viewer feeds page by page
src/lib/reader.core.js      speechSynthesis queue with word boundary events
src/lib/range.js            ES module wrapper around range.core.js
src/lib/reader.js           ES module wrapper around reader.core.js
src/background.js           PDF interception, toolbar routing, messages
src/options.html/js         settings page
src/vendor/                 pdf.js and pdf-lib builds (run `npm run vendor`)
tests/                      unit, real-PDF, viewer and extension tests
```

**PDF text.** pdf.js yields text runs with transforms; `pdftext.js` joins them
into a page string, inserting spaces or newlines from run gaps and line breaks,
and records where each run starts. A whitespace-collapsed copy of the page text is
used for anchor search, with a map back to the original offsets. The reading
range keeps that map, so a speech boundary offset can be turned into the exact
word to highlight.

**Web text.** The injected reader walks the DOM in reading order, skipping hidden
or non-content elements, and records a text node plus start offset for every run
it appends. Highlighting maps a word offset back to those nodes and applies a
`Range` through `CSS.highlights`, so the page is restyled without being rewritten.

**Lazy pages.** `createRangeReader` in `range.core.js` accumulates one page at a

time, reports where the start anchor landed, and hands out speech chunks for
whatever text has arrived so far — stopping exactly at the end anchor. The viewer
pulls pages from `getPageTextData` only when the speech queue runs low, and the
queue (`reader.core.js` with `open`/`append`/`close`) waits for the next batch
instead of ending. `buildReadingRange` is the same accumulator fed every page at
once, which is what the web page reader and the unit tests use.

**Shared reading logic.** Range building and the speech queue live in
`*.core.js` files that attach to `globalThis.__PDFREADER__`. Extension pages load
them through thin ES module wrappers; the content script is injected as plain
scripts and shares one isolated-world global. The PDF viewer and the page panel
therefore resolve anchors and chunk speech identically.

## Testing

### Prerequisites

```bash
npm install                     # pdf.js, pdf-lib, Playwright
npx playwright install chromium # browser for the UI and extension suites
```

On a normal Linux desktop also run `npx playwright install-deps chromium`.
Minimal containers may need extra shared libraries and a fontconfig file; see
[Testing in a restricted container](#testing-in-a-restricted-container).

### Automated

```bash
npm test                # 27 tests: pure logic + real PDF bytes (Node only)
npm run test:browser    # 7 tests: the viewer page and the settings page
npm run test:extension  # 2 tests: the loaded extension, PDFs and web pages
```

- **`npm test`** (`tests/range.test.mjs`, `pdftext.test.mjs`, `pdf.test.mjs`)
  covers whitespace normalisation and offset maps, case-insensitive anchor
  search, range errors (missing anchor, inverted pages, empty text), sentence
  chunking and its offsets, ranges fed one page at a time (it agrees with the
  all-at-once builder, stops at the end word and never repeats a chunk), text-run
  joining, and the exporter against real PDF bytes: page order, added rotation,
  annotation coordinates, annotation text, and WinAnsi sanitising.
- **`npm run test:browser`** (`tests/browser.test.mjs`) drives `src/viewer.html` in
  Chromium: renders a 3-page PDF, checks the text layer and zoom shortcuts,
  resolves a word-anchored range, verifies reading starts at the anchor and stops
  at the end anchor (with a stubbed synthesiser), observes automated page turning,
  creates a highlight and an ink stroke, deletes a page, then downloads the saved
  PDF and re-parses it to confirm the result. It also records every word the
  viewer marks as spoken, so the highlight is checked against the text and the
  page it belongs to. A second test opens a 30-page PDF and reads the whole
  document: it records each status line and asserts reading started when only the
  first page had been parsed, that the loaded-page count climbs to 30, and that
  every page was spoken exactly once. A third clears **To page**, starts from page
  12 and confirms the reading runs on to the last page without reading anything
  before it. Three more cover a speech engine that refuses every utterance (the
  status line and toast must explain why and the player must go back to idle), an
  engine that accepts an utterance and never reports anything (reported as `did
  not start` rather than hanging), and a chosen voice that cannot speak (the
  sentence is retried on the default voice and reading continues). A final test
  covers the empty state and the settings page.
- **`npm run test:extension`** (`tests/extension.test.mjs`) loads the unpacked
  extension in full Chromium and checks the redirect rule and settings toggle,
  opens a `.pdf` URL and an extension-less PDF URL into the viewer, then injects
  the page reader into a test article: hidden/script/nav/button text is excluded,
  reading runs between word anchors, the in-page highlight appears, toggling the
  panel works, re-injection does not duplicate it, and the panel still builds on a
  page that enforces `require-trusted-types-for 'script'`.

The suites stub `speechSynthesis` so they can assert exactly what would be spoken;
they do not exercise real OS voices.

### Manual smoke test

Automated tests cannot click the toolbar icon or hear audio, so check these once
after loading unpacked:

1. Click a `.pdf` link: the viewer opens and renders the first page.
2. Enter a start page, end page, start word and end word: the status line shows
   the anchor pages (and a word count when an end word is set), and **Read range**
   starts speaking quickly, highlights the current word and turns pages. On a long
   PDF the status line should read `Reading · N of M pages loaded` with a small N
   rather than loading the whole range first. **Stop** ends it.
3. Select a word in the PDF and press **Use selection**: the matching field fills
   and the page bound moves.
4. Draw with Pen, add a Text box, highlight a selection, undo once, then
   **Save PDF** and open the downloaded file: edits are present.
5. Rotate and delete a page in the thumbnail rail, save, and confirm the result.
6. On a news article, click the extension icon: the panel reports a word count.
   Set anchors, press **Read**, and confirm the page highlights and scrolls.
7. On a `chrome://` page, click the icon: the empty PDF viewer opens. On a page
   that blocks injection (such as the Chrome Web Store), a brief “!” badge
   appears instead of a panel.
8. Change voice and speed in Settings, then reopen the panel: the choices carry
   over.

### Testing in a restricted container

The browser suites need the Chromium shared libraries. In this workspace they were
extracted without root into `~/chrome-libs`, with a fontconfig file at
`~/fonts.conf`, and the suites were run as:

```bash
LD_LIBRARY_PATH="$HOME/chrome-libs/usr/lib/x86_64-linux-gnu" \
FONTCONFIG_FILE="$HOME/fonts.conf" \
npm run test:extension
```

To recreate that setup: `apt-get update` into a writable dir
(`-o Dir::State::lists=/tmp/apt/lists`), `apt-get download` the missing
`libnss3`, `libnspr4`, `libatk1.0-0t64`, `libatk-bridge2.0-0t64`,
`libatspi2.0-0t64`, `libasound2t64`, `libcups2t64`, `libcairo2`,
`libpango-1.0-0`, `libxkbcommon0` and the X11/font packages they pull in, then
`dpkg-deb -x` them into `~/chrome-libs`.

## Limitations

- **No OCR.** Scanned or image-only PDFs have no text layer, and the viewer says
  so instead of reading. Canvas-only web apps behave the same way.
- **Editing means annotations and page operations.** Existing page text is not
  reflowed or rewritten.
- **Exported text boxes are Latin-1.** Characters outside that range become `?` in
  the saved PDF (highlights and ink are unaffected).
- **Edits are not saved as a project.** They live in the tab until you export a
  PDF; there is no reopen-and-continue file.
- **Anchors use the first match.** Reading starts at the first start-word match
  and ends after the first end-word match following it; there is no
  “third occurrence” picker and no regular expressions.
- **Web text is a snapshot.** It is captured when the panel opens; a page that
  replaces its content mid-read may lose highlighting (the reading itself
  continues).
- **Some pages cannot be read.** Chrome blocks injection into `chrome://` pages and
  the Web Store; `file://` pages need “Allow access to file URLs” on the extension
  card.
- **Not on the Web Store yet.** There is no packaged/signed release.
- **Voices are your OS voices.** Quality and availability vary by platform, and
  the automated tests only use a stub.

## Future features

None of these are implemented yet; they are the intended direction.

- **OCR for scanned PDFs** (for example with tesseract.js), so image-only
  documents can be read too.
- **Reader view for web pages** — the extracted text in a clean layout, for sites
  whose own typography is hard to follow.
- **Occurrence picker for anchors** (first/second/… match) with a small preview of
  each match.
- **Saved reading projects** — store annotations and reading positions so a
  document can be reopened and continued later.
- **Side-panel mode**, so the reading controls survive tab switches instead of
  living in a floating panel.
- **Per-site controls** — mute the panel on chosen domains, or auto-extract on
  open.
- **Better annotation editing** — move and resize existing annotations instead of
  erase and redraw.
- **Search and jump within a reading range**, plus a “continue from here” action.
- **Packaging** — zip and store listing, plus a versioned release script.

## Development

```bash
npm install
npm run vendor   # re-copy pdf.js / pdf-lib builds into src/vendor after upgrades
npm run icons    # regenerate icons/ from tools/make-icons.mjs
npm test         # unit and real-PDF suites
npm run test:browser
npm run test:extension
```

- Source is plain ES modules; there is no bundler and no transpile step.
- `tools/vendor.mjs` copies the pdf.js runtime (including `cmaps`,
  `standard_fonts`, `wasm` and `iccs`) and the pdf-lib ESM build from
  `node_modules` into `src/vendor/`.
- `tools/make-icons.mjs` renders the extension icons with a tiny PNG encoder, so
  no image tooling is required.
- When adding shared logic that both extension pages and content scripts need,
  put it in a `*.core.js` file and add a thin ES module wrapper next to it, as
  `range.js` and `reader.js` do.
- If you change the reading semantics, update `tests/range.test.mjs`; if you change
  extraction or export, `tests/pdf.test.mjs` exercises real PDF bytes.

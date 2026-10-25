// Service worker: opens PDFs in the viewer, injects the page reader on normal
// pages, and answers messages from the injected panel.

import { loadSettings } from "./lib/settings.js";

const VIEWER = chrome.runtime.getURL("src/viewer.html");
const PAGE_READER_FILES = [
  "src/lib/range.core.js",
  "src/lib/reader.core.js",
  "src/content/page-reader.js",
];

// Chrome has no blocking webRequest in MV3, but response headers are still
// observable. PDFs are picked up from those headers rather than from a URL
// pattern, because only the response says whether the file is meant to be shown
// or downloaded. A URL rewrite rule would hijack "Save link as" and download
// buttons too, so there is none.
const recent = new Map();

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.url.startsWith(chrome.runtime.getURL(""))) return;
    const header = (name) =>
      (details.responseHeaders ?? []).find((h) => h.name.toLowerCase() === name)?.value ?? "";
    if (!header("content-type").toLowerCase().includes("application/pdf")) return;
    // The server (or the site) asked the browser to save the file: honour that
    // instead of opening the viewer.
    if (/^\s*attachment\b/i.test(header("content-disposition"))) return;

    const key = `${details.tabId}:${details.url}`;
    const now = Date.now();
    if (recent.has(key) && now - recent.get(key) < 10000) return;
    recent.set(key, now);
    for (const [k, t] of recent) if (now - t > 30000) recent.delete(k);

    openInViewer(details.tabId, details.url).catch((err) => console.warn(err));
  },
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  ["responseHeaders"],
);

async function openInViewer(tabId, url) {
  const { autoOpenPdf } = await loadSettings();
  if (!autoOpenPdf) return;
  const target = `${VIEWER}?file=${encodeURIComponent(url)}`;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url?.startsWith(VIEWER)) return;
  } catch {
    return; // Tab is gone.
  }
  await chrome.tabs.update(tabId, { url: target });
}

function isViewerUrl(url) {
  return url.startsWith(VIEWER);
}

function isPdfUrl(url) {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function togglePageReader(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "pdfreader:toggle" });
    if (response?.ok) return;
  } catch {
    // Nothing injected on this tab yet.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: PAGE_READER_FILES });
}

async function handleAction(tab) {
  const url = tab?.url ?? "";
  if (tab?.id == null || !/^https?:/i.test(url)) {
    // chrome:// pages and other privileged surfaces cannot be injected into.
    chrome.tabs.create({ url: VIEWER });
    return;
  }
  if (isViewerUrl(url)) return;
  if (isPdfUrl(url)) {
    await chrome.tabs.update(tab.id, { url: `${VIEWER}?file=${encodeURIComponent(url)}` });
    return;
  }
  try {
    await togglePageReader(tab.id);
    await chrome.action.setBadgeText({ text: "", tabId: tab.id });
  } catch {
    // Some pages (chrome://, the Web Store) refuse injected scripts.
    await chrome.action.setBadgeText({ text: "!", tabId: tab.id });
    await chrome.action.setTitle({ tabId: tab.id, title: "This page can't be read aloud" });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: "", tabId: tab.id }).catch(() => {});
      chrome.action.setTitle({ tabId: tab.id, title: "Open PDF Reader" }).catch(() => {});
    }, 4000);
  }
}

chrome.action.onClicked.addListener((tab) => {
  handleAction(tab).catch((err) => console.warn("Could not open the reader", err));
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "pdfreader:get-settings") {
    loadSettings()
      .then((settings) => respond(settings))
      .catch(() => respond(null));
    return true;
  }
  if (message?.type === "pdfreader:open-viewer") {
    chrome.tabs.create({ url: VIEWER });
    respond({ ok: true });
    return false;
  }
  if (message?.type === "pdfreader:open-options") {
    chrome.runtime.openOptionsPage();
    respond({ ok: true });
    return false;
  }
  return false;
});

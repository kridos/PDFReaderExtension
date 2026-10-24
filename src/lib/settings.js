// Settings shared by the viewer, options page and service worker.

export const DEFAULTS = {
  autoOpenPdf: true,
  voiceURI: "",
  rate: 1,
  pitch: 1,
  followPage: true,
  highlightColor: "#facc15",
};

const hasChrome = () => typeof chrome !== "undefined" && chrome.storage?.sync;

export async function loadSettings() {
  if (!hasChrome()) {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("pdfreader.settings") || "{}") };
    } catch {
      return { ...DEFAULTS };
    }
  }
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  if (!hasChrome()) {
    const current = await loadSettings();
    localStorage.setItem("pdfreader.settings", JSON.stringify({ ...current, ...patch }));
    return { ...current, ...patch };
  }
  await chrome.storage.sync.set(patch);
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

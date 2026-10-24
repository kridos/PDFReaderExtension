import { loadSettings, saveSettings } from "./lib/settings.js";

const $ = (id) => document.getElementById(id);
const voiceSelect = $("voiceURI");
const status = $("status");
const synth = window.speechSynthesis;

function fillVoices(selected = "") {
  const voices = synth ? synth.getVoices() : [];
  voiceSelect.replaceChildren(new Option("Browser default", ""));
  for (const v of voices) {
    const suffix = v.localService ? "" : " — network";
    voiceSelect.append(new Option(`${v.name} (${v.lang})${suffix}`, v.voiceURI));
  }
  voiceSelect.value = selected;
  if (voiceSelect.value !== selected) voiceSelect.value = "";
}

function syncLabels() {
  $("rateOut").textContent = `${Number($("rate").value).toFixed(1)}×`;
  $("pitchOut").textContent = Number($("pitch").value).toFixed(1);
}

async function init() {
  const settings = await loadSettings();
  $("autoOpenPdf").checked = settings.autoOpenPdf;
  $("followPage").checked = settings.followPage;
  $("rate").value = settings.rate;
  $("pitch").value = settings.pitch;
  syncLabels();
  fillVoices(settings.voiceURI);

  if (synth) {
    synth.addEventListener("voiceschanged", () => fillVoices(voiceSelect.value));
  } else {
    $("testVoice").disabled = true;
    status.textContent = "Speech synthesis is unavailable in this browser.";
  }

  const saved = async (patch) => {
    await saveSettings(patch);
    status.textContent = "Saved.";
  };

  $("autoOpenPdf").addEventListener("change", (e) => saved({ autoOpenPdf: e.target.checked }));
  $("followPage").addEventListener("change", (e) => saved({ followPage: e.target.checked }));
  voiceSelect.addEventListener("change", (e) => saved({ voiceURI: e.target.value }));
  $("rate").addEventListener("input", syncLabels);
  $("rate").addEventListener("change", (e) => saved({ rate: Number(e.target.value) }));
  $("pitch").addEventListener("input", syncLabels);
  $("pitch").addEventListener("change", (e) => saved({ pitch: Number(e.target.value) }));

  $("testVoice").addEventListener("click", () => {
    if (!synth) return;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(
      "This is how PDF Reader will read your document aloud.",
    );
    const voice = synth.getVoices().find((v) => v.voiceURI === voiceSelect.value);
    if (voice) utter.voice = voice;
    utter.rate = Number($("rate").value) || 1;
    utter.pitch = Number($("pitch").value) || 1;
    synth.speak(utter);
    status.textContent = "Testing…";
  });
}

init();

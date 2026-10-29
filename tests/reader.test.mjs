// The speech queue cannot be driven through a fake browser: what matters is how
// it treats an engine that takes a chunk and then says nothing. These tests run
// it against a fake window and a virtual clock, so a five-second watchdog costs
// no real time.
import test from "node:test";
import assert from "node:assert/strict";

const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  now: Date.now,
};

let clock = null;

function installClock() {
  clock = { now: 1_000_000, timers: [], seq: 0 };
  globalThis.setTimeout = (fn, delay = 0) => {
    const timer = { id: ++clock.seq, at: clock.now + Math.max(0, delay), fn };
    clock.timers.push(timer);
    return timer.id;
  };
  globalThis.clearTimeout = (id) => {
    clock.timers = clock.timers.filter((timer) => timer.id !== id);
  };
  Date.now = () => clock.now;
}

function restoreClock() {
  globalThis.setTimeout = real.setTimeout;
  globalThis.clearTimeout = real.clearTimeout;
  Date.now = real.now;
  clock = null;
}

/** Run every timer that is due within the next `ms` on the virtual clock. */
function advance(ms) {
  const target = clock.now + ms;
  for (;;) {
    const due = clock.timers
      .filter((timer) => timer.at <= target)
      .sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) break;
    clock.timers = clock.timers.filter((timer) => timer !== due);
    clock.now = Math.max(clock.now, due.at);
    due.fn();
  }
  clock.now = target;
}

class FakeUtterance {
  constructor(text) {
    this.text = text;
  }
}

const LOCAL = { name: "Local", lang: "en-US", voiceURI: "local-1", localService: true };
const NETWORK = { name: "Network", lang: "en-US", voiceURI: "net-1", localService: false };

/** A speech engine whose behaviour per utterance is supplied by the test. */
function makeEngine(voices, speak) {
  const engine = {
    speaking: false,
    pending: false,
    paused: false,
    said: [],
    getVoices: () => voices,
    addEventListener() {},
    removeEventListener() {},
    cancel() {
      engine.speaking = false;
      engine.pending = false;
    },
    pause() {
      engine.paused = true;
    },
    resume() {
      engine.paused = false;
    },
    speak(utterance) {
      engine.said.push({ text: utterance.text, voice: utterance.voice?.voiceURI ?? null });
      speak(utterance, engine);
    },
  };
  return engine;
}

let moduleId = 0;

/** Evaluate reader.core.js against a fresh fake window. */
async function loadReader(engine) {
  globalThis.window = { speechSynthesis: engine };
  globalThis.SpeechSynthesisUtterance = FakeUtterance;
  await import(new URL(`../src/lib/reader.core.js?case=${++moduleId}`, import.meta.url).href);
  return globalThis.__PDFREADER__.Reader;
}

/** Speaks and finishes, but never fires onstart — as some installed voices do. */
function quietStart(utterance, engine) {
  engine.speaking = true;
  // Longer than one watchdog poll, as any real sentence is.
  globalThis.setTimeout(() => {
    engine.speaking = false;
    utterance.onend?.();
  }, 600);
}

test("a voice that never fires onstart is not spoken again", async (t) => {
  installClock();
  t.after(restoreClock);
  const progress = [];
  const errors = [];
  const engine = makeEngine([LOCAL], quietStart);
  const Reader = await loadReader(engine);
  const reader = new Reader({
    onProgress: ({ absolute }) => progress.push(absolute),
    onError: ({ reason }) => errors.push(reason),
  });
  reader.voiceURI = "local-1";
  reader.load({
    chunks: [
      { start: 0, end: 3, text: "one" },
      { start: 4, end: 7, text: "two" },
    ],
  });
  reader.play();
  advance(4000);

  assert.deepEqual(engine.said.map((entry) => entry.text), ["one", "two"]);
  assert.deepEqual(progress, [0, 4], "each chunk was reported as it began");
  assert.deepEqual(errors, []);
  assert.equal(reader.state, "ended");
});

test("an engine that swallows every chunk is retried, then reported", async (t) => {
  installClock();
  t.after(restoreClock);
  const errors = [];
  const engine = makeEngine([LOCAL], () => {});
  const Reader = await loadReader(engine);
  const reader = new Reader({ onError: ({ reason }) => errors.push(reason) });
  reader.load({ chunks: [{ start: 0, end: 3, text: "one" }] });
  reader.play();
  advance(40000);

  assert.deepEqual(errors, ["did-not-start"]);
  // Three tries with a voice installed here, then three with the browser's
  // default: the default is often a network voice that cannot speak at all.
  assert.equal(engine.said.length, 6, `said: ${JSON.stringify(engine.said)}`);
  assert.ok(
    engine.said.slice(0, 3).every((entry) => entry.voice === "local-1"),
    `an installed voice should have been tried first: ${JSON.stringify(engine.said)}`,
  );
  assert.ok(
    engine.said.slice(3).every((entry) => entry.voice === null),
    `the browser default should have been the last resort: ${JSON.stringify(engine.said)}`,
  );
});

test("an engine that accepts a chunk and reports nothing is reported as silent", async (t) => {
  installClock();
  t.after(restoreClock);
  const notices = [];
  const engine = makeEngine([LOCAL], (utterance, spoken) => {
    // Accepted: the engine says it is speaking, then never says anything else.
    spoken.speaking = true;
  });
  const Reader = await loadReader(engine);
  const reader = new Reader({ onSilentStart: (info) => notices.push(info) });
  reader.load({ chunks: [{ start: 0, end: 3, text: "one" }] });
  reader.play();
  advance(20000);

  assert.equal(notices.length, 1, "the panel should be told once, not once per poll");
  assert.equal(notices[0].voices, 1);
  assert.equal(notices[0].localVoices, 1);
  assert.equal(engine.said.length, 1, "a chunk that may still speak is not cancelled");
});

test("an engine that claims to speak but never reports a word is started over", async (t) => {
  installClock();
  t.after(restoreClock);
  const errors = [];
  const engine = makeEngine([LOCAL], (utterance, spoken) => {
    // Wedged the other way round: it says it is speaking and never finishes.
    spoken.speaking = true;
  });
  const Reader = await loadReader(engine);
  const reader = new Reader({ onError: ({ reason }) => errors.push(reason) });
  reader.load({ chunks: [{ start: 0, end: 3, text: "one" }] });
  reader.play();
  advance(400000);

  assert.deepEqual(errors, ["stalled"]);
  assert.equal(engine.said.length, 6, `said: ${JSON.stringify(engine.said)}`);
  assert.equal(reader.state, "idle");
});

test("a chosen voice with no other installed voice falls back to the default", async (t) => {
  installClock();
  t.after(restoreClock);
  const errors = [];
  const fallbacks = [];
  const engine = makeEngine([LOCAL], (utterance, spoken) => {
    if (utterance.voice?.voiceURI === LOCAL.voiceURI) {
      // Refused outright, as an uninstalled or broken voice is.
      globalThis.setTimeout(() => {
        spoken.speaking = false;
        utterance.onerror?.({ error: "synthesis-failed" });
      }, 0);
      return;
    }
    quietStart(utterance, spoken);
  });
  const Reader = await loadReader(engine);
  const reader = new Reader({
    onError: ({ reason }) => errors.push(reason),
    onVoiceFallback: ({ stage }) => fallbacks.push(stage),
  });
  reader.voiceURI = LOCAL.voiceURI;
  reader.load({ chunks: [{ start: 0, end: 3, text: "one" }] });
  reader.play();
  advance(4000);

  assert.deepEqual(fallbacks, [2], "the default voice is the fallback");
  assert.deepEqual(errors, []);
  assert.equal(engine.said[engine.said.length - 1].voice, null);
  assert.equal(reader.state, "ended");
});

test("a voice that never starts hands over to one installed locally", async (t) => {
  installClock();
  t.after(restoreClock);
  const errors = [];
  const fallbacks = [];
  const engine = makeEngine([NETWORK, LOCAL], (utterance, spoken) => {
    // The chosen voice takes the text and never speaks: a network voice that
    // cannot reach its service behaves exactly like this.
    if (utterance.voice?.voiceURI === NETWORK.voiceURI) return;
    quietStart(utterance, spoken);
  });
  const Reader = await loadReader(engine);
  const reader = new Reader({
    onError: ({ reason }) => errors.push(reason),
    onVoiceFallback: () => fallbacks.push(true),
  });
  reader.voiceURI = "net-1";
  reader.load({ chunks: [{ start: 0, end: 3, text: "one" }] });
  reader.play();
  advance(40000);

  assert.equal(fallbacks.length, 1, "the handover is reported once");
  assert.deepEqual(errors, []);
  assert.equal(reader.state, "ended");
  const used = engine.said.map((entry) => entry.voice);
  assert.ok(used.includes("net-1"), "the chosen voice is tried first");
  assert.equal(used[used.length - 1], "local-1", "the installed voice finishes the chunk");
});

/** The system speech service (chrome.tts) as the extension sees it. */
function makeSystemTts(speak) {
  return {
    said: [],
    stop() {},
    pause() {},
    resume() {},
    speak(text, options, callback) {
      this.said.push({ text, options });
      speak(text, options, callback ?? (() => {}));
    },
  };
}

test("a page engine that will not start hands the chunk to the system speech service", async (t) => {
  installClock();
  t.after(() => {
    restoreClock();
    delete globalThis.chrome;
  });
  const errors = [];
  const fallbacks = [];
  const engine = makeEngine([LOCAL], () => {});
  const tts = makeSystemTts((text, options) => {
    globalThis.setTimeout(() => {
      options.onEvent({ type: "start" });
      options.onEvent({ type: "word", charIndex: 0 });
      options.onEvent({ type: "end" });
    }, 50);
  });
  globalThis.chrome = { tts, runtime: {} };
  const Reader = await loadReader(engine);
  const reader = new Reader({
    onError: ({ reason }) => errors.push(reason),
    onVoiceFallback: ({ stage }) => fallbacks.push(stage),
  });
  reader.load({
    chunks: [
      { start: 0, end: 3, text: "one" },
      { start: 4, end: 7, text: "two" },
    ],
  });
  reader.play();
  advance(60000);

  assert.deepEqual(errors, []);
  // First the browser default voice is tried, then the system service; neither
  // handover is repeated for the next chunk.
  assert.deepEqual(fallbacks, [2, 3], "the handovers are reported once each");
  assert.deepEqual(
    tts.said.map((entry) => entry.text),
    ["one", "two"],
    "every chunk is spoken by the service that works",
  );
  assert.equal(tts.said[0].options.enqueue, false, "a chunk is not queued behind the silent engine");
  assert.equal(reader.state, "ended");
});

test("a system speech service that refuses is reported with its reason", async (t) => {
  installClock();
  t.after(() => {
    restoreClock();
    delete globalThis.chrome;
  });
  const errors = [];
  const engine = makeEngine([LOCAL], () => {});
  const tts = makeSystemTts((text, options) => {
    globalThis.setTimeout(() => options.onEvent({ type: "error", errorMessage: "platform error" }), 10);
  });
  globalThis.chrome = { tts, runtime: {} };
  const Reader = await loadReader(engine);
  const reader = new Reader({ onError: ({ reason }) => errors.push(reason) });
  reader.load({ chunks: [{ start: 0, end: 3, text: "one" }] });
  reader.play();
  advance(60000);

  assert.deepEqual(errors, ["system-platform error"]);
  assert.equal(reader.state, "idle");
});

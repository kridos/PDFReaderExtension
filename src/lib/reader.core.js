// Speech synthesis queue. Classic script so it can be loaded both as an ES
// module (via reader.js) and as an injected content script.
((global) => {
  const NS = (global.__PDFREADER__ = global.__PDFREADER__ || {});

// Thin wrapper around window.speechSynthesis: one utterance per chunk, with a
// boundary callback so the viewer can follow along word by word.

/** How many times one chunk is spoken before the engine is declared broken. */
const ATTEMPTS = 3;
/** Long enough for a healthy engine to fire onstart, short enough to retry. */
const START_TIMEOUT = 1800;
const RETRY_TIMEOUT = 1000;

class Reader {
  static get supported() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  /**
   * @param {{onState?: (state: string) => void, onProgress?: (p: {absolute: number, chunkIndex: number, chunk: {start: number, end: number, text: string}}) => void, onStarved?: () => void, onError?: (info: {reason: string, chunkIndex: number}) => void, onVoiceFallback?: (info: {reason: string}) => void}} handlers
   */
  constructor({ onState, onProgress, onStarved, onError, onVoiceFallback } = {}) {
    this.onState = onState ?? (() => {});
    this.onProgress = onProgress ?? (() => {});
    // Called when playback catches up with chunks that have not been supplied
    // yet; the caller can append more text and playback carries on.
    this.onStarved = onStarved ?? (() => {});
    // Called when the speech engine refuses to speak at all, so the caller can
    // say why instead of leaving the panel looking stuck on "playing".
    this.onError = onError ?? (() => {});
    // Called when the chosen voice could not speak and the default voice took
    // over, so the reader keeps going instead of falling silent.
    this.onVoiceFallback = onVoiceFallback ?? (() => {});
    this._voiceUnusable = false;
    this.chunks = [];
    this.index = 0;
    this.state = "idle"; // idle | playing | paused | ended
    // While open, running out of chunks means "wait for more" rather than "done".
    this.open = false;
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
    this.voiceURI = "";
    this._token = 0;
    this._current = null;
    this._keepAlive = [];
    this._starved = false;
    // When the queue was last cancelled; Chrome can drop an utterance that is
    // queued in the same task as cancel(), so speaking waits a moment after it.
    this._cancelledAt = 0;
  }

  get voices() {
    if (!Reader.supported) return [];
    return window.speechSynthesis
      .getVoices()
      .sort((a, b) => (a.lang === b.lang ? a.name.localeCompare(b.name) : a.lang.localeCompare(b.lang)));
  }

  /** Voices can arrive asynchronously on first load. */
  whenVoicesReady(timeoutMs = 1500) {
    if (!Reader.supported) return Promise.resolve([]);
    if (window.speechSynthesis.getVoices().length) return Promise.resolve(this.voices);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.speechSynthesis.removeEventListener("voiceschanged", finish);
        resolve(this.voices);
      };
      window.speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
      setTimeout(finish, timeoutMs);
    });
  }

  /**
   * @param {{chunks?: {start: number, end: number, text: string}[], open?: boolean}} range
   *   `open` keeps the queue alive when it runs dry, so chunks can be appended
   *   while it is already speaking.
   */
  load(range = {}) {
    this.stop();
    this.chunks = range.chunks ?? [];
    this.open = Boolean(range.open);
    this.index = 0;
    this._starved = false;
    this._voiceUnusable = false;
    this._setState("idle");
  }

  /** Add chunks to a queue that may already be playing. */
  append(chunks) {
    if (!chunks || !chunks.length) return;
    this.chunks.push(...chunks);
    // While paused the queue is only restarted by resume(); leaving the starved
    // flag set lets resume() know there is nothing to un-pause yet.
    if (!this._starved || this.state !== "playing") return;
    this._starved = false;
    this._speakCurrent();
  }

  /** No more chunks are coming: finish as soon as the queue drains. */
  close() {
    this.open = false;
    if (!this._starved) return;
    this._starved = false;
    if (this.state === "playing") this._speakCurrent();
  }

  play() {
    if (!Reader.supported) throw new Error("This browser has no speech synthesis support.");
    if (!this.chunks.length) return;
    if (this.state === "paused") return this.resume();
    if (this.state === "playing") return;
    this._speakCurrent();
  }

  pause() {
    if (!Reader.supported || this.state !== "playing") return;
    window.speechSynthesis.pause();
    this._setState("paused");
  }

  resume() {
    if (!Reader.supported || this.state !== "paused") return;
    this._setState("playing");
    // Nothing is actually paused if the queue ran dry while it was paused.
    if (this._starved || this.index >= this.chunks.length) {
      this._starved = false;
      this._speakCurrent();
      return;
    }
    window.speechSynthesis.resume();
  }

  toggle() {
    if (this.state === "playing") this.pause();
    else if (this.state === "paused") this.resume();
    else this.play();
  }

  stop() {
    this._token++;
    this._current = null;
    this._starved = false;
    this._keepAlive = [];
    if (Reader.supported) {
      this._cancelledAt = Date.now();
      window.speechSynthesis.cancel();
    }
    if (this.state !== "idle") this._setState("idle");
  }

  /** Skip to a specific chunk (used by the transcript list). */
  seekToChunk(i) {
    if (!this.chunks.length) return;
    this.index = Math.min(Math.max(0, i), this.chunks.length - 1);
    if (this.state === "playing" || this.state === "paused") {
      this._token++;
      this._cancelledAt = Date.now();
      window.speechSynthesis.cancel();
      this._setState("playing");
      this._speakCurrent();
    } else {
      const chunk = this.chunks[this.index];
      this.onProgress({ absolute: chunk.start, chunkIndex: this.index, chunk });
    }
  }

  _setState(state) {
    this.state = state;
    this.onState(state);
  }

  _pickVoice() {
    if (!this.voiceURI || this._voiceUnusable) return null;
    return window.speechSynthesis.getVoices().find((v) => v.voiceURI === this.voiceURI) ?? null;
  }

  /** Speak the current chunk again with a fresh utterance on a cleared queue. */
  _retryUtterance(chunk, token, fallback, attempt) {
    if (token !== this._token) return;
    // The old utterance is abandoned: its events must no longer move the queue.
    this._current = null;
    this._cancelledAt = Date.now();
    try {
      window.speechSynthesis.cancel();
    } catch {
      // A missing engine is handled by the caller.
    }
    this._startUtterance(chunk, token, fallback, attempt);
  }

  _speakCurrent() {
    const token = this._token;
    if (this.index >= this.chunks.length) {
      if (this.open) {
        // Wait for the next page instead of declaring the reading finished.
        this._starved = true;
        this.onStarved();
        return;
      }
      this._setState("ended");
      return;
    }
    this._startUtterance(this.chunks[this.index], token, false);
  }

  /**
   * Queue one chunk. `fallback` means "speak with the default voice", used when
   * the voice the user picked turns out to be unusable on this machine.
   */
  _startUtterance(chunk, token, fallback, attempt = 0) {
    const utter = new SpeechSynthesisUtterance(chunk.text);
    utter.rate = Math.min(10, Math.max(0.1, this.rate));
    utter.pitch = Math.min(2, Math.max(0, this.pitch));
    utter.volume = Math.min(1, Math.max(0, this.volume));
    const voice = fallback ? null : this._pickVoice();
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    }
    this._current = utter;
    this._keepAlive.push(utter);
    if (this._keepAlive.length > 8) this._keepAlive.shift();

    let started = false;
    let failed = false;
    // A retry leaves the previous utterance behind; anything it reports later
    // belongs to a chunk the queue has already moved on from.
    const stale = () => token !== this._token || this._current !== utter;
    // Chrome can accept an utterance and then never report anything at all:
    // no start, no end, no error. Speaking the chunk again usually works, so
    // retry a few times and only then say the engine is refusing to start.
    let watchdog = 0;
    const stopWatchdog = () => clearTimeout(watchdog);
    const armWatchdog = (delay) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (stale() || started || failed) return;
        if (this.state !== "playing") return;
        // A background tab may simply not have got round to it yet.
        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
          armWatchdog(delay);
          return;
        }
        if (attempt + 1 < ATTEMPTS) {
          this._retryUtterance(chunk, token, fallback, attempt + 1);
          return;
        }
        failed = true;
        this._failUtterance(chunk, token, fallback, "did-not-start", attempt);
      }, delay);
    };
    armWatchdog(attempt ? RETRY_TIMEOUT : START_TIMEOUT);

    utter.onstart = () => {
      started = true;
      stopWatchdog();
      if (stale()) return;
      this.onProgress({ absolute: chunk.start, chunkIndex: this.index, chunk });
    };

    utter.onboundary = (event) => {
      if (stale()) return;
      if (event.name && event.name !== "word") return;
      const offset = typeof event.charIndex === "number" ? event.charIndex : 0;
      this.onProgress({
        absolute: chunk.start + offset,
        chunkIndex: this.index,
        chunk,
      });
    };

    utter.onend = () => {
      stopWatchdog();
      if (stale()) return;
      this.index++;
      this._speakCurrent();
    };

    utter.onerror = (event) => {
      stopWatchdog();
      const reason = event.error ?? "speech-error";
      if (reason === "interrupted" || reason === "canceled") return;
      if (stale() || failed) return;
      failed = true;
      // A voice that already started and then broke keeps the text it read.
      this._failUtterance(chunk, token, fallback || started, reason, attempt);
    };

    this._setState("playing");
    const speak = () => {
      if (stale() || failed) return;
      try {
        // A queue left paused by an earlier cancel() (a known Chrome bug) takes
        // utterances without ever speaking them. Resuming an unresumed queue is
        // a no-op, so it is safe to do every time.
        window.speechSynthesis.resume();
        window.speechSynthesis.speak(utter);
      } catch (error) {
        stopWatchdog();
        if (stale() || failed) return;
        failed = true;
        this._failUtterance(chunk, token, fallback, error?.message || "speak-failed", attempt);
      }
    };
    // Speaking in the same task as cancel() makes Chrome drop the utterance
    // silently; a short pause after cancelling avoids that entirely.
    if (this._cancelledAt && Date.now() - this._cancelledAt < 250) setTimeout(speak, 120);
    else speak();
  }

  /** Give up on this utterance, retrying on the default voice once if we can. */
  _failUtterance(chunk, token, fallback, reason, attempt = 0) {
    if (token !== this._token) return;
    if (!fallback && this.voiceURI && !this._voiceUnusable) {
      this._voiceUnusable = true;
      // Start the default voice from a clean queue rather than behind the
      // utterance the engine just refused.
      this._current = null;
      this._cancelledAt = Date.now();
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Nothing to cancel on an engine that is already gone.
      }
      this.onVoiceFallback({ reason });
      this._startUtterance(chunk, token, true, 0);
      return;
    }
    // The panel message is deliberately short; the console gets the details
    // that are needed to work out why this machine will not speak.
    if (Reader.supported) {
      const engine = window.speechSynthesis;
      console.warn("[PDF Reader] speech failed", {
        reason,
        attempts: attempt + 1,
        voice: this.voiceURI || "(default)",
        usedDefaultVoice: Boolean(fallback),
        voices: engine.getVoices().length,
        speaking: engine.speaking,
        pending: engine.pending,
        paused: engine.paused,
        rate: this.rate,
      });
    }
    this._setState("idle");
    this.onError({ reason, chunkIndex: this.index });
  }
}

  NS.Reader = Reader;
})(globalThis);

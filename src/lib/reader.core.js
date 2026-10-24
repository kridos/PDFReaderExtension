// Speech synthesis queue. Classic script so it can be loaded both as an ES
// module (via reader.js) and as an injected content script.
((global) => {
  const NS = (global.__PDFREADER__ = global.__PDFREADER__ || {});

// Thin wrapper around window.speechSynthesis: one utterance per chunk, with a
// boundary callback so the viewer can follow along word by word.

class Reader {
  static get supported() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  /**
   * @param {{onState?: (state: string) => void, onProgress?: (p: {absolute: number, chunkIndex: number, chunk: {start: number, end: number, text: string}}) => void, onStarved?: () => void}} handlers
   */
  constructor({ onState, onProgress, onStarved } = {}) {
    this.onState = onState ?? (() => {});
    this.onProgress = onProgress ?? (() => {});
    // Called when playback catches up with chunks that have not been supplied
    // yet; the caller can append more text and playback carries on.
    this.onStarved = onStarved ?? (() => {});
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
    if (Reader.supported) window.speechSynthesis.cancel();
    if (this.state !== "idle") this._setState("idle");
  }

  /** Skip to a specific chunk (used by the transcript list). */
  seekToChunk(i) {
    if (!this.chunks.length) return;
    this.index = Math.min(Math.max(0, i), this.chunks.length - 1);
    if (this.state === "playing" || this.state === "paused") {
      this._token++;
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
    if (!this.voiceURI) return null;
    return window.speechSynthesis.getVoices().find((v) => v.voiceURI === this.voiceURI) ?? null;
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
    const chunk = this.chunks[this.index];
    const utter = new SpeechSynthesisUtterance(chunk.text);
    utter.rate = Math.min(10, Math.max(0.1, this.rate));
    utter.pitch = Math.min(2, Math.max(0, this.pitch));
    utter.volume = Math.min(1, Math.max(0, this.volume));
    const voice = this._pickVoice();
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    }
    this._current = utter;
    this._keepAlive.push(utter);
    if (this._keepAlive.length > 8) this._keepAlive.shift();

    utter.onstart = () => {
      if (token !== this._token) return;
      this.onProgress({ absolute: chunk.start, chunkIndex: this.index, chunk });
    };

    utter.onboundary = (event) => {
      if (token !== this._token) return;
      if (event.name && event.name !== "word") return;
      const offset = typeof event.charIndex === "number" ? event.charIndex : 0;
      this.onProgress({
        absolute: chunk.start + offset,
        chunkIndex: this.index,
        chunk,
      });
    };

    utter.onend = () => {
      if (token !== this._token) return;
      this.index++;
      this._speakCurrent();
    };

    utter.onerror = (event) => {
      if (token !== this._token) return;
      const reason = event.error ?? "";
      if (reason === "interrupted" || reason === "canceled") return;
      // "not-allowed" / "synthesis-failed": stop rather than loop forever.
      this._setState("idle");
    };

    this._setState("playing");
    window.speechSynthesis.speak(utter);
  }
}

  NS.Reader = Reader;
})(globalThis);

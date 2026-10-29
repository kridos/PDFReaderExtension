// Speech synthesis queue. Classic script so it can be loaded both as an ES
// module (via reader.js) and as an injected content script.
((global) => {
  const NS = (global.__PDFREADER__ = global.__PDFREADER__ || {});

// Thin wrapper around window.speechSynthesis: one utterance per chunk, with a
// boundary callback so the viewer can follow along word by word.

/** How many times one chunk is spoken before the engine is declared broken. */
const ATTEMPTS = 3;
/** How long one chunk may sit in the queue before it is spoken again. */
const START_GRACE = 5000;
const RETRY_GRACE = 4000;
/** How often the engine itself is asked whether it has taken the chunk. */
const POLL_MS = 250;
/**
 * How long an utterance may claim to be speaking without reporting a single
 * word before the queue decides it is wedged and starts the chunk again.
 */
const STALL_TIMEOUT = 45000;
/**
 * How long an accepted chunk may go without a single event — no start, no word,
 * no end, no error — before the panel says the engine looks dead. Nothing in
 * the platform reports whether sound is coming out, so this only warns: a slow
 * voice may still begin, and cancelling it would cost the audio that is on its
 * way.
 */
const SILENT_NOTICE = 7000;

class Reader {
  static get supported() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  /**
   * The system's own speech service, which an extension page reaches through
   * chrome.tts. It is a separate entry point from the page's speechSynthesis:
   * where that API accepts voices and then never speaks, this is the last
   * engine worth trying. Content scripts do not get this API.
   */
  static get systemTts() {
    return typeof chrome !== "undefined" && chrome.tts ? chrome.tts : null;
  }

  /**
   * @param {{onState?: (state: string) => void, onProgress?: (p: {absolute: number, chunkIndex: number, chunk: {start: number, end: number, text: string}}) => void, onStarved?: () => void, onError?: (info: {reason: string, chunkIndex: number}) => void, onVoiceFallback?: (info: {reason: string}) => void}} handlers
   */
  constructor({ onState, onProgress, onStarved, onError, onVoiceFallback, onSilentStart } = {}) {
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
    // Called once when the engine took a chunk but never reported anything at
    // all, which is what a dead system speech service looks like.
    this.onSilentStart = onSilentStart ?? (() => {});
    this._silentNotified = false;
    // Which engine is speaking: the page's speechSynthesis ("web"), or the
    // system service through chrome.tts ("system") once the first stayed silent.
    this._engine = "web";
    this._systemTried = false;
    // Which voice the queue is reduced to: 0 the chosen (or default) voice,
    // 1 a voice installed on this machine, 2 the browser default.
    this._voiceStage = 0;
    // The voice the last utterance actually used, and the language it speaks.
    this._usedVoice = "";
    this._voiceLang = "";
    this._failedVoiceURI = "";
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
    // How far into the current chunk the voice has reached, so a speed change
    // can carry on from that word instead of starting the sentence again.
    this._cursor = 0;
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
    this._cursor = 0;
    this._starved = false;
    this._voiceStage = 0;
    this._failedVoiceURI = "";
    this._silentNotified = false;
    this._engine = "web";
    this._systemTried = false;
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
    // Carry on from the word it stopped at: starting again after a stop should
    // not put the beginning of the sentence back in the queue.
    this._speakCurrent(this._cursor);
  }

  pause() {
    if (!Reader.supported || this.state !== "playing") return;
    if (this._engine === "system") {
      try {
        Reader.systemTts.pause();
      } catch {
        // A service that is not running has nothing to pause.
      }
    } else {
      window.speechSynthesis.pause();
    }
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
    if (this._engine === "system") {
      try {
        Reader.systemTts.resume();
      } catch {
        // Nothing to resume on a service that is not running.
      }
      return;
    }
    window.speechSynthesis.resume();
  }

  toggle() {
    if (this.state === "playing") this.pause();
    else if (this.state === "paused") this.resume();
    else this.play();
  }

  /**
   * Change the speaking speed. A speech engine fixes the rate when a sentence is
   * queued, so a sentence already being spoken is queued again from the word it
   * had reached: the change is heard now, not after the current sentence.
   */
  setRate(rate) {
    const next = Math.min(10, Math.max(0.1, Number(rate) || 1));
    if (next === this.rate) return;
    this.rate = next;
    if (this.state === "playing") this._restartCurrent();
  }

  /**
   * Change the voice, mid-sentence included. A speech engine fixes the voice
   * when a sentence is queued, exactly as it does the speed, so the rest of the
   * current sentence is queued again from the word it had reached.
   */
  setVoice(uri) {
    const next = String(uri ?? "");
    if (next === this.voiceURI) return;
    this.voiceURI = next;
    // A voice just picked by hand gets a turn even after another one was found
    // unusable, and is a reason to go back to the page engine after the system
    // speech service had to take over.
    this._failedVoiceURI = "";
    this._voiceStage = 0;
    this._engine = "web";
    this._systemTried = false;
    if (this.state === "playing") this._restartCurrent();
  }

  /** Speak the rest of the current chunk again, from the word it had reached. */
  _restartCurrent() {
    const chunk = this.chunks[this.index];
    if (!chunk) return;
    const from = Math.max(0, Math.min(this._cursor, chunk.text.length - 1));
    this._token++;
    this._current = null;
    this._cancelledAt = Date.now();
    try {
      window.speechSynthesis.cancel();
    } catch {
      // A missing engine is reported when the next chunk fails to start.
    }
    if (Reader.systemTts) {
      try {
        Reader.systemTts.stop();
      } catch {
        // Nothing was playing through the system service.
      }
    }
    this._cursor = from;
    this._setState("playing");
    const token = this._token;
    if (this._engine === "system") this._speakSystem(chunk, token, from);
    else this._startUtterance(chunk, token, this._voiceStage, 0, from);
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
    if (Reader.systemTts) {
      try {
        Reader.systemTts.stop();
      } catch {
        // Nothing was playing through the system service.
      }
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
      if (Reader.systemTts) {
        try {
          Reader.systemTts.stop();
        } catch {
          // Nothing was playing through the system service.
        }
      }
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

  /** Which voice a chunk should be spoken with. */
  _stageVoice(stage) {
    if (stage === 1) return this._localVoice();
    if (stage === 2) return null;
    return this._pickVoice();
  }

  /** The voice the user picked, or null for the browser's default. */
  _pickVoice() {
    if (!Reader.supported) return null;
    // A voice the user has just picked gets a turn even after an earlier one was
    // found unusable: only the voice that failed is skipped.
    if (this.voiceURI && this.voiceURI !== this._failedVoiceURI) {
      const voice = window.speechSynthesis.getVoices().find((v) => v.voiceURI === this.voiceURI) ?? null;
      if (voice) {
        if (voice.lang) this._voiceLang = voice.lang;
        return voice;
      }
    }
    if (this._voiceStage === 2) return null;
    // With no voice chosen the browser default is not used first: on many
    // machines it is a network voice, and a network voice that cannot reach its
    // service never makes a sound. A voice installed here always can.
    return this._localVoice();
  }

  /**
   * A voice installed on this machine, which speaks without a network. Chrome's
   * default voice is often a network one, and a network voice that cannot reach
   * its service never starts at all — exactly what a dead engine looks like.
   */
  _localVoice() {
    if (!Reader.supported) return null;
    const local = window.speechSynthesis.getVoices().filter((voice) => voice.localService);
    if (!local.length) return null;
    const base = String(this._voiceLang || "").split("-")[0].toLowerCase();
    const same = base ? local.find((voice) => String(voice.lang || "").toLowerCase().startsWith(base)) : null;
    return same ?? local[0];
  }

  /** Speak the current chunk again with a fresh utterance on a cleared queue. */
  _retryUtterance(chunk, token, stage, attempt) {
    if (token !== this._token) return;
    // The old utterance is abandoned: its events must no longer move the queue.
    this._current = null;
    this._cancelledAt = Date.now();
    try {
      window.speechSynthesis.cancel();
    } catch {
      // A missing engine is handled by the caller.
    }
    this._startUtterance(chunk, token, stage, attempt);
  }

  _speakCurrent(from = 0) {
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
    if (this._engine === "system") this._speakSystem(chunk, token, from);
    else this._startUtterance(chunk, token, 0, 0, from);
  }

  /**
   * Queue one chunk. `stage` picks the voice: 0 the chosen (or default) voice,
   * 1 a voice installed on this machine, 2 the browser default, 3 no retry.
   */
  _startUtterance(chunk, token, stage = 0, attempt = 0, from = 0) {
    const utter = new SpeechSynthesisUtterance(chunk.text.slice(from));
    utter.rate = Math.min(10, Math.max(0.1, this.rate));
    utter.pitch = Math.min(2, Math.max(0, this.pitch));
    utter.volume = Math.min(1, Math.max(0, this.volume));
    const voice = this._stageVoice(stage);
    this._usedVoice = voice?.voiceURI ?? "";
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    }
    this._current = utter;
    this._keepAlive.push(utter);
    if (this._keepAlive.length > 8) this._keepAlive.shift();

    let started = false;
    let failed = false;
    // Only a real event counts as the engine having done something.
    let heard = false;
    // A retry leaves the previous utterance behind; anything it reports later
    // belongs to a chunk the queue has already moved on from.
    const stale = () => token !== this._token || this._current !== utter;

    const engine = window.speechSynthesis;
    let silent = 0;
    let watchdog = 0;
    let stall = 0;
    const stopWatchdog = () => clearTimeout(watchdog);
    const stopStall = () => clearTimeout(stall);
    const stopTimers = () => {
      stopWatchdog();
      stopStall();
      clearTimeout(silent);
    };
    const armSilent = () => {
      clearTimeout(silent);
      silent = setTimeout(() => {
        if (heard || failed || stale() || this._silentNotified || this.state !== "playing") return;
        this._silentNotified = true;
        const voices = engine.getVoices();
        this.onSilentStart({
          voice: this._usedVoice || "(default)",
          voices: voices.length,
          localVoices: voices.filter((v) => v.localService).length,
          speaking: engine.speaking,
          pending: engine.pending,
        });
      }, SILENT_NOTICE);
    };
    // A queue can wedge the other way round too: the engine reports that it is
    // speaking and then never reports another word. Nothing else would notice, so
    // a chunk that goes this long without a single event is started over.
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        if (stale() || failed) return;
        if (this.state !== "playing") {
          armStall();
          return;
        }
        if (attempt + 1 < ATTEMPTS) {
          this._retryUtterance(chunk, token, stage, attempt + 1);
          return;
        }
        failed = true;
        this._failUtterance(chunk, token, stage, "stalled", attempt);
      }, STALL_TIMEOUT);
    };
    const began = () => {
      if (started) return;
      started = true;
      stopWatchdog();
      armStall();
      this._cursor = from;
      this.onProgress({ absolute: chunk.start + from, chunkIndex: this.index, chunk });
    };
    // Chrome can take an utterance and then report nothing at all — no start,
    // no end, no error — so the engine itself is asked whether it has picked
    // the text up. Some voices also begin speaking without ever firing onstart,
    // which used to look like a refusal and got the chunk spoken again over the
    // top of the audio that was already playing.
    const sentAt = Date.now();
    const grace = attempt ? RETRY_GRACE : START_GRACE;
    const poll = () => {
      watchdog = 0;
      if (stale() || started || failed) return;
      if (this.state !== "playing") return;
      if (engine.speaking) {
        began();
        return;
      }
      // Queued-but-not-yet-started is normal for a busy engine, and a hidden tab
      // has its timers slowed down. Both are given longer before the chunk is
      // spoken again: cancelling work that is about to happen is what made a
      // slow engine look like a broken one.
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      const allowance = hidden ? grace * 4 : engine.pending ? grace * 2 : grace;
      if (Date.now() - sentAt < allowance) {
        watchdog = setTimeout(poll, POLL_MS);
        return;
      }
      if (attempt + 1 < ATTEMPTS) {
        this._retryUtterance(chunk, token, stage, attempt + 1);
        return;
      }
      failed = true;
      this._failUtterance(chunk, token, stage, "did-not-start", attempt);
    };
    watchdog = setTimeout(poll, POLL_MS);

    utter.onstart = () => {
      if (stale()) return;
      heard = true;
      began();
    };

    utter.onboundary = (event) => {
      if (stale()) return;
      heard = true;
      if (event.name && event.name !== "word") return;
      began();
      armStall();
      const offset = typeof event.charIndex === "number" ? event.charIndex : 0;
      this._cursor = from + offset;
      this.onProgress({
        absolute: chunk.start + from + offset,
        chunkIndex: this.index,
        chunk,
      });
    };

    utter.onend = () => {
      heard = true;
      stopTimers();
      if (stale()) return;
      this._cursor = 0;
      this.index++;
      this._speakCurrent();
    };

    utter.onerror = (event) => {
      heard = true;
      stopTimers();
      const reason = event.error ?? "speech-error";
      if (reason === "interrupted" || reason === "canceled") return;
      if (stale() || failed) return;
      failed = true;
      // A voice that already started and then broke keeps the text it read, so
      // it is not spoken again on another voice (stage 3 means "no retry").
      this._failUtterance(chunk, token, started ? 3 : stage, reason, attempt);
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
        stopTimers();
        if (stale() || failed) return;
        failed = true;
        this._failUtterance(chunk, token, stage, error?.message || "speak-failed", attempt);
      }
    };
    armSilent();
    // Speaking in the same task as cancel() makes Chrome drop the utterance
    // silently; a short pause after cancelling avoids that entirely.
    if (this._cancelledAt && Date.now() - this._cancelledAt < 250) setTimeout(speak, 120);
    else speak();
  }

  /**
   * Speak one chunk through the system's own speech service (chrome.tts). Its
   * events are shaped differently from the page API's — start, word, end and
   * error, each with a message rather than an error code — and it plays the
   * system default voice, which is the point: it is a different way in.
   */
  _speakSystem(chunk, token, from = 0) {
    const tts = Reader.systemTts;
    if (!tts) {
      this._setState("idle");
      this.onError({ reason: "system-unavailable", chunkIndex: this.index });
      return;
    }
    const stale = () => token !== this._token;
    let started = false;
    let failed = false;
    let watchdog = 0;
    let stall = 0;
    const clear = () => {
      clearTimeout(watchdog);
      clearTimeout(stall);
    };
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        if (stale() || failed) return;
        failed = true;
        try {
          tts.stop();
        } catch {
          // Already stopped.
        }
        this._failUtterance(chunk, token, 3, "stalled", ATTEMPTS);
      }, STALL_TIMEOUT);
    };
    const begin = () => {
      if (started) return;
      started = true;
      clearTimeout(watchdog);
      armStall();
      this._cursor = from;
      this.onProgress({ absolute: chunk.start + from, chunkIndex: this.index, chunk });
    };
    watchdog = setTimeout(() => {
      if (stale() || started || failed) return;
      failed = true;
      try {
        tts.stop();
      } catch {
        // Nothing was playing.
      }
      this._failUtterance(chunk, token, 3, "did-not-start", ATTEMPTS);
    }, START_GRACE);

    const onEvent = (event) => {
      if (stale() || failed) return;
      const type = event?.type;
      if (type === "start") {
        begin();
      } else if (type === "word") {
        begin();
        armStall();
        const offset = typeof event.charIndex === "number" ? event.charIndex : 0;
        this._cursor = from + offset;
        this.onProgress({ absolute: chunk.start + from + offset, chunkIndex: this.index, chunk });
      } else if (type === "end") {
        clear();
        this._cursor = 0;
        this.index++;
        this._speakCurrent();
      } else if (type === "error") {
        clear();
        failed = true;
        this._failUtterance(
          chunk,
          token,
          3,
          `system-${event.errorMessage || "speech-error"}`,
          ATTEMPTS,
        );
      }
      // interrupted, cancelled, pause and resume need no handling here.
    };

    this._setState("playing");
    try {
      tts.stop();
      tts.speak(
        chunk.text.slice(from),
        {
          enqueue: false,
          rate: Math.min(10, Math.max(0.1, this.rate)),
          pitch: Math.min(2, Math.max(0, this.pitch)),
          volume: Math.min(1, Math.max(0, this.volume)),
          onEvent,
        },
        () => {
          // Chrome only reports a refused request here, and reading the error
          // inside the callback is what keeps it from being logged as unchecked.
          const error = typeof chrome !== "undefined" ? chrome.runtime?.lastError : null;
          if (!error || failed || started) return;
          failed = true;
          clear();
          this._failUtterance(chunk, token, 3, `system-${error.message || "speak-failed"}`, ATTEMPTS);
        },
      );
    } catch (error) {
      clear();
      failed = true;
      this._failUtterance(chunk, token, 3, `system-${error?.message || "speak-failed"}`, ATTEMPTS);
    }
  }

  /** Give up on this utterance, trying another voice first if there is one. */
  _failUtterance(chunk, token, stage, reason, attempt = 0) {
    if (token !== this._token) return;
    // The order is: the voice that was asked for, a voice installed on this
    // machine, then the browser's default. A network voice that cannot reach its
    // service never starts, and a machine can be left with only that one, so all
    // three are worth a try.
    const local = this._localVoice();
    let next = 0;
    if (stage === 0) {
      if (local && local.voiceURI !== this._usedVoice) next = 1;
      else if (this._usedVoice) next = 2;
    } else if (stage === 1 && this._usedVoice) {
      next = 2;
    }
    if (next) {
      this._voiceStage = next;
      this._failedVoiceURI = this._usedVoice;
      // Start the alternative from a clean queue rather than behind the
      // utterance the engine just refused.
      this._current = null;
      this._cancelledAt = Date.now();
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Nothing to cancel on an engine that is already gone.
      }
      this.onVoiceFallback({ reason, stage: next });
      this._startUtterance(chunk, token, next, 0);
      return;
    }
    // The page's own engine has now refused this chunk three times and on more
    // than one voice. The system service is a different way in, so it gets the
    // chunk before the reader gives up on it.
    if (this._engine === "web" && !this._systemTried && Reader.systemTts) {
      this._systemTried = true;
      this._engine = "system";
      this.onVoiceFallback({ reason, stage: 3 });
      this._speakSystem(chunk, token);
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
        usedVoice: this._usedVoice,
        voiceStage: stage,
        voices: engine.getVoices().length,
        localVoices: engine.getVoices().filter((v) => v.localService).length,
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

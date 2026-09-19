import { WebSocket } from "ws";

const DEEPGRAM_LIVE_URL = "wss://api.deepgram.com/v1/listen";

export const DEFAULT_DEEPGRAM_MODEL = "nova-3";

// The browser streams PCM16LE mono at 24 kHz (see public/app.js SAMPLE_RATE and
// createAudioStreamer). Raw PCM carries no container, so Deepgram has nothing to
// sniff: `encoding` and `sample_rate` are not optional here. Getting them wrong
// does not error - it transcribes a chipmunk.
const AUDIO_ENCODING = "linear16";
const AUDIO_SAMPLE_RATE = 24000;
const AUDIO_CHANNELS = 1;

// Silence (ms) Deepgram waits before it calls a segment done and flags the
// result `speech_final`. This is the same knob as the OpenAI provider's
// DEFAULT_DELTA_QUIET_MS, and it is set to the same 1000 ms on purpose: the
// whiteboard agent runs once per committed turn, so both engines should decide
// "that was a thought" at the same granularity. Lower values chop one sentence
// into three agent turns; higher ones leave the presenter waiting.
const DEFAULT_ENDPOINTING_MS = 1000;

// Deepgram does not send `UtteranceEnd` frames unless you ask for them, however
// many VAD events you turn on. We ask, as the backstop for a final that never
// carries `speech_final` - otherwise a settled segment could sit in the buffer
// until the next utterance pushes it out. Vendor minimum is 1000 ms.
const DEFAULT_UTTERANCE_END_MS = 1000;

// Deepgram hangs up an idle socket after ~10 s of no audio. A presenter pausing
// to think is normal, and a socket that died mid-pause drops the rest of the
// talk with no error anywhere, so the provider pings while it holds the socket.
const KEEPALIVE_MS = 5000;

// After a Stop click we ask Deepgram to flush (`Finalize`) and give it this long
// to answer before committing whatever we already hold. Without the wait the
// last few words - the ones still inside Deepgram when the user clicked - are
// lost; without the cap, a Stop that Deepgram never answers never commits.
const DEFAULT_FINALIZE_GRACE_MS = 800;

// `CloseStream` tells Deepgram to transcribe its buffer and close cleanly. We
// send it and wait before tearing the socket down; closing first kills the tail.
const DEFAULT_CLOSE_GRACE_MS = 1500;

/**
 * Build the live-listen URL. Exported for tests and for anyone debugging what
 * the socket actually asked for.
 */
export function buildDeepgramUrl({
  model = DEFAULT_DEEPGRAM_MODEL,
  sampleRate = AUDIO_SAMPLE_RATE,
  endpointingMs = DEFAULT_ENDPOINTING_MS,
  utteranceEndMs = DEFAULT_UTTERANCE_END_MS,
  keyterms = [],
} = {}) {
  const params = new URLSearchParams([
    ["model", model || DEFAULT_DEEPGRAM_MODEL],
    ["encoding", AUDIO_ENCODING],
    ["sample_rate", String(sampleRate)],
    ["channels", String(AUDIO_CHANNELS)],
    // Without interim_results the socket only speaks at the end of a segment,
    // which leaves the live caption blank while someone is talking.
    ["interim_results", "true"],
    ["punctuate", "true"],
    ["smart_format", "true"],
    ["endpointing", String(endpointingMs)],
    ["vad_events", "true"],
    ["utterance_end_ms", String(Math.max(1000, utteranceEndMs))],
  ]);
  // `keyterm` is repeatable and is nova-3 only (English). It is how a proper
  // noun that is on the staging board gets spelled the way the board spells it.
  for (const term of keyterms) params.append("keyterm", term);
  return `${DEEPGRAM_LIVE_URL}?${params.toString()}`;
}

/**
 * Normalise one Deepgram live frame into the events this app speaks.
 *
 * The partial/final distinction is the whole contract: every interim result
 * RESTATES the segment from its start, so a caller that appended them would
 * render "the the the quick quick brown".
 */
export function parseDeepgramMessage(message) {
  const type = message?.type;

  if (type === "Results") {
    const alternatives = message?.channel?.alternatives;
    const text = String(alternatives?.[0]?.transcript ?? "").trim();
    // An empty transcript is a real and frequent answer (a breath, the
    // endpointer closing a segment that held nothing). Dropping it keeps an
    // empty final from blanking the caption mid-sentence.
    if (!text) return [];
    if (message.is_final) {
      return [{ kind: "final", text, speechFinal: Boolean(message.speech_final) }];
    }
    return [{ kind: "partial", text }];
  }

  if (type === "UtteranceEnd") return [{ kind: "utterance-end" }];
  if (type === "Metadata") return [{ kind: "metadata" }];

  if (type === "Error" || type === "error") {
    const detail = message?.description || message?.message || message?.error;
    return [{ kind: "error", message: String(detail || "Deepgram error") }];
  }

  return [];
}

/** Staging-board keywords + the user's configured terms, de-duplicated. */
export function mergeKeyterms(configured, keywords, { maxTerms = 100 } = {}) {
  const seen = new Map();
  for (const source of [configured, keywords]) {
    if (!Array.isArray(source)) continue;
    for (const raw of source) {
      if (typeof raw !== "string") continue;
      const term = raw.trim();
      if (!term) continue;
      const key = term.toLowerCase();
      if (!seen.has(key)) seen.set(key, term);
    }
  }
  return [...seen.values()].slice(0, maxTerms);
}

export function createDeepgramTranscription({
  sendTranscript,
  queueTranscript,
  options = /** @type {any} */ ({}),
  env = process.env,
  createWebSocket = (url, protocols, init) => new WebSocket(url, protocols, init),
  log = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let socket = null;
  let readyPromise = null;
  let resolveReady = null;
  let rejectReady = null;
  let open = false;
  let pendingAudio = [];
  let keepaliveTimer = null;
  let finalizeTimer = null;
  let closeTimer = null;

  // Segments Deepgram has settled but that are not yet a committed turn, plus
  // the interim text for the segment still in flight.
  let settled = [];
  let interim = "";

  let configuredKeyterms = normaliseKeyterms(options.deepgramKeyterms);
  let contextKeywords = [];
  let activeKeyterms = mergeKeyterms(configuredKeyterms, contextKeywords);

  const model = options.deepgramModel || DEFAULT_DEEPGRAM_MODEL;
  const endpointingMs = numberOr(options.deepgramEndpointingMs, DEFAULT_ENDPOINTING_MS);
  const utteranceEndMs = numberOr(options.deepgramUtteranceEndMs, DEFAULT_UTTERANCE_END_MS);
  const keepaliveMs = numberOr(options.deepgramKeepaliveMs, KEEPALIVE_MS);
  const finalizeGraceMs = numberOr(options.deepgramFinalizeGraceMs, DEFAULT_FINALIZE_GRACE_MS);
  const closeGraceMs = numberOr(options.deepgramCloseGraceMs, DEFAULT_CLOSE_GRACE_MS);

  function currentText() {
    const parts = [...settled];
    if (interim) parts.push(interim);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function emitPartial() {
    const text = currentText();
    if (!text) return;
    sendTranscript({ type: "transcript:partial", text });
  }

  /** Drain the settled segments as one agent turn. Idempotent. */
  function commitTurn() {
    cancelFinalizeTimer();
    // Interim text is not thrown away on commit: if the user clicks Stop
    // mid-word, that word is the best guess we have and losing it is the bug
    // this whole provider exists to avoid.
    const text = currentText();
    settled = [];
    interim = "";
    if (!text) return;
    sendTranscript({ type: "transcript:committed", text });
    queueTranscript(text);
  }

  function cancelFinalizeTimer() {
    if (finalizeTimer) {
      clearTimeoutFn(finalizeTimer);
      finalizeTimer = null;
    }
  }

  function sendControl(frame) {
    if (!socket || !open) return;
    try {
      socket.send(JSON.stringify({ type: frame }));
    } catch (error) {
      log.debug?.(`[deepgram-transcription] ${frame} failed: ${error.message}`);
    }
  }

  function startKeepalive() {
    stopKeepalive();
    if (keepaliveMs <= 0) return;
    keepaliveTimer = setIntervalFn(() => sendControl("KeepAlive"), keepaliveMs);
    // Node keeps the process alive for a pending interval; this one should not.
    keepaliveTimer?.unref?.();
  }

  function stopKeepalive() {
    if (keepaliveTimer) {
      clearIntervalFn(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function resolveApiKey() {
    const key = String(env.DEEPGRAM_API_KEY ?? "").trim();
    if (!key) {
      throw new Error("DEEPGRAM_API_KEY is required for the Deepgram transcription provider.");
    }
    return key;
  }

  function ensureSocket() {
    if (socket) return socket;

    const apiKey = resolveApiKey();

    readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // A reconnect rejects the previous readyPromise. Nothing may be awaiting it
    // by then, and an unhandled rejection would take the server down.
    readyPromise.catch(() => {});

    const url = buildDeepgramUrl({
      model,
      endpointingMs,
      utteranceEndMs,
      keyterms: activeKeyterms,
    });

    const created = createWebSocket(url, undefined, {
      // Deepgram's own scheme. Never log this header, and never let the key
      // reach the browser - settings expose only `hasDeepgramKey`.
      headers: { Authorization: `Token ${apiKey}` },
    });
    socket = created;
    // A socket we have already replaced (keyterm reconnect, close) keeps
    // emitting until the TCP close lands. Its events must not touch the
    // provider's state, or a late `close` nulls out the socket that succeeded
    // it and audio starts disappearing into a dead reference.
    const isCurrent = () => socket === created;

    created.on("open", () => {
      if (!isCurrent()) return;
      open = true;
      startKeepalive();
      for (const chunk of pendingAudio) writeAudio(chunk);
      pendingAudio = [];
      resolveReady?.();
    });

    // Frames from a superseded socket are still transcript - that is the whole
    // point of CloseStream - so they are handled whether or not it is current.
    created.on("message", (raw) => {
      handleFrame(raw?.toString ? raw.toString("utf8") : String(raw));
    });

    created.on("error", (error) => {
      if (!isCurrent()) return;
      // `ws` surfaces an HTTP 401 as a plain socket error. Report the vendor's
      // words, never the key that failed.
      sendTranscript({ type: "error", message: error?.message ?? "Deepgram socket error" });
      rejectReady?.(error instanceof Error ? error : new Error(String(error)));
    });

    created.on("close", () => {
      if (!isCurrent()) return;
      stopKeepalive();
      cancelFinalizeTimer();
      rejectReady?.(new Error("Deepgram socket closed before it was ready."));
      socket = null;
      open = false;
      readyPromise = null;
      resolveReady = null;
      rejectReady = null;
      pendingAudio = [];
    });

    return created;
  }

  function handleFrame(line) {
    if (!line?.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      sendTranscript({ type: "error", message: `Invalid Deepgram message: ${line}` });
      return;
    }

    for (const event of parseDeepgramMessage(message)) {
      if (event.kind === "partial") {
        interim = event.text;
        emitPartial();
        continue;
      }
      if (event.kind === "final") {
        interim = "";
        settled.push(event.text);
        emitPartial();
        // `speech_final` is Deepgram saying the endpointer saw its silence -
        // i.e. the same signal the OpenAI provider synthesises from a quiet
        // timer. That is the turn boundary.
        if (event.speechFinal) commitTurn();
        continue;
      }
      if (event.kind === "utterance-end") {
        // Backstop for a settled segment whose final never carried
        // speech_final; without it that text waits for the next utterance.
        if (settled.length > 0) commitTurn();
        continue;
      }
      if (event.kind === "error") {
        sendTranscript({ type: "error", message: event.message });
      }
    }
  }

  function writeAudio(base64Audio) {
    if (!socket || !open) return;
    // Deepgram wants the raw PCM frames as binary; the browser hands us base64.
    socket.send(Buffer.from(base64Audio, "base64"));
  }

  function applyKeyterms(next) {
    if (sameTerms(next, activeKeyterms)) return;
    activeKeyterms = next;
    log.debug?.(`[deepgram-transcription] keyterms set (${next.length} term(s))`);
    // Keyterms live in the connect URL, so changing them means a new socket.
    // This only ever happens between sessions (preso start / back to staging /
    // reset), when no audio is in flight, so a reconnect costs nothing.
    if (!socket) return;
    const previous = socket;
    socket = null;
    open = false;
    readyPromise = null;
    resolveReady = null;
    rejectReady = null;
    stopKeepalive();
    try {
      previous.close();
    } catch {}
    // Reopen straight away so the next Start listening does not pay for it.
    try {
      ensureSocket();
    } catch (error) {
      sendTranscript({ type: "error", message: error.message });
    }
  }

  return {
    ready: async () => {
      try {
        ensureSocket();
      } catch (error) {
        sendTranscript({ type: "error", message: error.message });
        throw error;
      }
      await readyPromise;
    },
    sendAudio: (audio) => {
      if (!audio) return;
      try {
        ensureSocket();
      } catch (error) {
        sendTranscript({ type: "error", message: error.message });
        return;
      }
      if (!open) {
        pendingAudio.push(audio);
        return;
      }
      writeAudio(audio);
    },
    /** @param {{ keywords?: string[] | null }} [ctx] */
    setSessionContext: (ctx) => {
      contextKeywords = normaliseKeyterms(ctx?.keywords);
      applyKeyterms(mergeKeyterms(configuredKeyterms, contextKeywords));
    },
    stop: () => {
      // Stop means "queue what I just said, now". `Finalize` asks Deepgram to
      // close the segment in flight and answer immediately instead of waiting
      // out the endpointing silence - so we get its corrected words rather than
      // our last interim guess. The timer is the cap: if Deepgram does not
      // answer, we commit what we hold rather than swallowing the turn.
      if (!socket || !open) {
        commitTurn();
        return;
      }
      sendControl("Finalize");
      cancelFinalizeTimer();
      if (finalizeGraceMs <= 0) {
        commitTurn();
        return;
      }
      finalizeTimer = setTimeoutFn(() => {
        finalizeTimer = null;
        commitTurn();
      }, finalizeGraceMs);
      finalizeTimer?.unref?.();
    },
    close: () => {
      cancelFinalizeTimer();
      stopKeepalive();
      if (closeTimer) {
        clearTimeoutFn(closeTimer);
        closeTimer = null;
      }
      const target = socket;
      if (!target) return;
      if (!open) {
        socket = null;
        target.close();
        return;
      }
      // CloseStream FIRST, then wait, then close. Reversed, the words still
      // inside Deepgram when the socket dropped never come back.
      sendControl("CloseStream");
      socket = null;
      open = false;
      readyPromise = null;
      resolveReady = null;
      rejectReady = null;
      closeTimer = setTimeoutFn(() => {
        closeTimer = null;
        try {
          target.close();
        } catch {}
      }, closeGraceMs);
      closeTimer?.unref?.();
    },
  };
}

function normaliseKeyterms(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((term) => typeof term === "string" && term.trim()).map((term) => term.trim());
}

function sameTerms(a, b) {
  if (a.length !== b.length) return false;
  return a.every((term, index) => term === b[index]);
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

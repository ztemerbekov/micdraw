import { WebSocket } from "ws";

import { mergeKeyterms, sameTerms } from "./deepgram-transcription.js";

const XAI_STT_URL = "wss://api.x.ai/v1/stt";

// Ported from upstream autopreso#24, whose author ran it against the live API,
// and checked against xAI's docs on 2026-10-03; not verified live here (#17).
export const XAI_STT_MODEL = "grok-voice-transcribe-2.0";

// The browser streams PCM16LE mono at 24 kHz (see public/app.js SAMPLE_RATE).
const AUDIO_ENCODING = "pcm";
const AUDIO_SAMPLE_RATE = 24000;

// At each pause Smart Turn guesses whether the speaker finished the thought.
// Below this confidence the pause only settles a chunk and the turn goes on;
// the timeout caps the wait, close to the 1 s the other engines use. Both
// values are upstream autopreso#24's.
const SMART_TURN_THRESHOLD = 0.7;
const SMART_TURN_TIMEOUT_MS = 1200;

// xAI takes up to 100 keyterms of up to 50 characters each.
const MAX_KEYTERMS = 100;
const MAX_KEYTERM_LENGTH = 50;

// After a Stop click, how long xAI gets to answer `finalize` before the turn
// commits with what is already held. The same cap as the Deepgram engine's.
const DEFAULT_FINALIZE_GRACE_MS = 800;

/** The streaming URL. Exported for tests and for debugging what was asked for. */
export function buildXaiSttUrl({ language = undefined, keyterms = [] } = {}) {
  const params = new URLSearchParams([
    ["model", XAI_STT_MODEL],
    ["sample_rate", String(AUDIO_SAMPLE_RATE)],
    ["encoding", AUDIO_ENCODING],
    // Without interim results the caption stays blank while someone talks.
    ["interim_results", "true"],
    ["smart_turn", String(SMART_TURN_THRESHOLD)],
    ["smart_turn_timeout", String(SMART_TURN_TIMEOUT_MS)],
  ]);
  if (language) params.append("language", language);
  for (const term of keyterms.slice(0, MAX_KEYTERMS)) params.append("keyterm", term.slice(0, MAX_KEYTERM_LENGTH));
  return `${XAI_STT_URL}?${params.toString()}`;
}

/** Normalise one xAI frame into the events this engine handles. */
export function parseXaiMessage(message) {
  const type = message?.type;
  // xAI asks the client to wait for this before sending audio.
  if (type === "transcript.created") return [{ kind: "ready" }];
  if (type === "transcript.partial") {
    const text = String(message.text ?? "").trim();
    // is_final settles a chunk; speech_final also ends the turn, even when
    // the chunk itself is empty (an answer to `finalize` with nothing new).
    if (message.is_final) return [{ kind: "final", text, speechFinal: Boolean(message.speech_final) }];
    return text ? [{ kind: "partial", text }] : [];
  }
  if (type === "error") {
    return [{ kind: "error", message: String(message.message ?? message.error?.message ?? "xAI speech-to-text error") }];
  }
  return [];
}

// xAI's docs do not say whether a chunk's text restates the chunks before it
// in the same turn. Both readings come out right: text that starts with what
// is already held replaces it, and anything else is appended.
function extend(held, text) {
  if (!held) return text;
  if (!text) return held;
  return text.startsWith(held) ? text : `${held} ${text}`;
}

export function createXaiTranscription({
  sendTranscript,
  queueTranscript,
  options = /** @type {any} */ ({}),
  env = process.env,
  createWebSocket = (url, protocols, init) => new WebSocket(url, protocols, init),
  log = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let socket = null;
  let readyPromise = null;
  let resolveReady = null;
  let rejectReady = null;
  // xAI has said transcript.created on the current socket.
  let created = false;
  let pendingAudio = [];
  let finalizeTimer = null;

  // Settled text of the turn in progress, and the interim text after it.
  let held = "";
  let interim = "";

  let activeKeyterms = [];

  function currentText() {
    return extend(held, interim).replace(/\s+/g, " ").trim();
  }

  function emitPartial() {
    const text = currentText();
    if (text) sendTranscript({ type: "transcript:partial", text });
  }

  /** Drain the turn in progress as one agent turn. Idempotent. */
  function commitTurn() {
    cancelFinalizeTimer();
    // The interim text goes too: after a Stop click mid-word it is the best
    // guess there is.
    const text = currentText();
    held = "";
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

  function resolveApiKey() {
    const key = String(env.XAI_API_KEY ?? "").trim();
    if (!key) throw new Error("XAI_API_KEY is required for the xAI transcription provider.");
    return key;
  }

  function forgetSocket() {
    socket = null;
    created = false;
    readyPromise = null;
    resolveReady = null;
    rejectReady = null;
  }

  function ensureSocket() {
    if (socket) return socket;

    const apiKey = resolveApiKey();
    readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Nothing may be awaiting a promise that a reconnect rejects, and an
    // unhandled rejection would take the server down.
    readyPromise.catch(() => {});

    const url = buildXaiSttUrl({ language: options.transcriptionLanguage, keyterms: activeKeyterms });
    // Never log this header, and never let the key reach the browser:
    // settings expose only `hasXaiKey`.
    const opened = createWebSocket(url, undefined, { headers: { Authorization: `Bearer ${apiKey}` } });
    socket = opened;
    // A replaced socket keeps emitting until its close lands, and must not
    // touch the state of the socket that replaced it.
    const isCurrent = () => socket === opened;

    opened.on("message", (raw) => {
      if (!isCurrent()) return;
      handleFrame(raw?.toString ? raw.toString("utf8") : String(raw));
    });

    opened.on("error", (error) => {
      if (!isCurrent()) return;
      sendTranscript({ type: "error", message: error?.message ?? "xAI speech-to-text socket error" });
      rejectReady?.(error instanceof Error ? error : new Error(String(error)));
    });

    opened.on("close", () => {
      if (!isCurrent()) return;
      cancelFinalizeTimer();
      rejectReady?.(new Error("xAI speech-to-text closed before it was ready."));
      forgetSocket();
      pendingAudio = [];
    });

    return opened;
  }

  function handleFrame(line) {
    if (!line?.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      sendTranscript({ type: "error", message: `Invalid xAI speech-to-text message: ${line}` });
      return;
    }

    for (const event of parseXaiMessage(message)) {
      if (event.kind === "ready") {
        created = true;
        for (const chunk of pendingAudio) writeAudio(chunk);
        pendingAudio = [];
        resolveReady?.();
        continue;
      }
      if (event.kind === "partial") {
        interim = event.text;
        emitPartial();
        continue;
      }
      if (event.kind === "final") {
        held = extend(held, event.text);
        interim = "";
        emitPartial();
        if (event.speechFinal) commitTurn();
        continue;
      }
      if (event.kind === "error") sendTranscript({ type: "error", message: event.message });
    }
  }

  function writeAudio(base64Audio) {
    if (!socket || !created) return;
    // xAI takes the raw PCM frames as binary; the browser hands over base64.
    socket.send(Buffer.from(base64Audio, "base64"));
  }

  function applyKeyterms(next) {
    if (sameTerms(next, activeKeyterms)) return;
    activeKeyterms = next;
    log.debug?.(`[xai-transcription] keyterms set (${next.length} term(s))`);
    // Keyterms live in the connect URL, so a change needs a new socket. It
    // happens between sessions (preso start, back to staging, reset), with no
    // audio in flight.
    if (!socket) return;
    const previous = socket;
    forgetSocket();
    try {
      previous.close();
    } catch {}
    // Reopen straight away so the next Start listening does not wait for it.
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
      if (!created) {
        pendingAudio.push(audio);
        return;
      }
      writeAudio(audio);
    },
    /** @param {{ keywords?: string[] | null }} [ctx] */
    setSessionContext: (ctx) => {
      applyKeyterms(mergeKeyterms([], ctx?.keywords, { maxTerms: MAX_KEYTERMS }));
    },
    stop: () => {
      // Stop means "queue what I just said, now". `finalize` makes xAI end the
      // turn at once with its corrected words; the timer commits what is held
      // if it does not answer.
      if (!socket || !created) {
        commitTurn();
        return;
      }
      try {
        socket.send(JSON.stringify({ type: "finalize" }));
      } catch (error) {
        log.debug?.(`[xai-transcription] finalize failed: ${error.message}`);
      }
      cancelFinalizeTimer();
      finalizeTimer = setTimeoutFn(() => {
        finalizeTimer = null;
        commitTurn();
      }, DEFAULT_FINALIZE_GRACE_MS);
      finalizeTimer?.unref?.();
    },
    close: () => {
      cancelFinalizeTimer();
      const target = socket;
      if (!target) return;
      rejectReady?.(new Error("xAI speech-to-text closed before it was ready."));
      forgetSocket();
      pendingAudio = [];
      try {
        target.close();
      } catch {}
    },
  };
}

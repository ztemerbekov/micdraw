// @ts-nocheck - hand-rolled EventEmitter is used as a fake WebSocket; structural types fight here.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  buildDeepgramUrl,
  createDeepgramTranscription,
  mergeKeyterms,
  parseDeepgramMessage,
} from "../src/deepgram-transcription.js";

function createMockSocket() {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.binary = [];
  socket.closed = false;
  socket.send = (data) => {
    if (typeof data === "string") socket.sent.push(data);
    else if (Buffer.isBuffer(data)) socket.binary.push(data);
    else socket.sent.push(String(data));
  };
  socket.close = () => {
    socket.closed = true;
    socket.emit("close");
  };
  return socket;
}

/**
 * Deterministic stand-ins for the timer functions the provider takes as
 * dependencies. Node's own fake timers do not reach a module that captured
 * setTimeout at construction, so the provider accepts them explicitly.
 */
function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeoutFn: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms, repeat: null });
      return id;
    },
    clearTimeoutFn: (id) => timers.delete(id),
    setIntervalFn: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms, repeat: ms });
      return id;
    },
    clearIntervalFn: (id) => timers.delete(id),
    advance(ms) {
      const target = now + ms;
      // Fire in time order, re-arming repeats, until nothing is due.
      for (;;) {
        let due = null;
        let dueId = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === null || timer.at < due.at)) {
            due = timer;
            dueId = id;
          }
        }
        if (!due) break;
        now = due.at;
        if (due.repeat === null) timers.delete(dueId);
        else due.at = now + due.repeat;
        due.fn();
      }
      now = target;
    },
    get pending() {
      return timers.size;
    },
  };
}

function setup({ options = {}, env = { DEEPGRAM_API_KEY: "dg-test" } } = {}) {
  const socket = createMockSocket();
  const clock = createFakeClock();
  const emitted = [];
  const queued = [];
  const urls = [];
  const inits = [];
  const sockets = [];
  const transcription = createDeepgramTranscription({
    sendTranscript: (message) => emitted.push(message),
    queueTranscript: (text) => queued.push(text),
    options,
    env,
    createWebSocket: (url, protocols, init) => {
      urls.push(url);
      inits.push(init);
      const next = sockets.length === 0 ? socket : createMockSocket();
      sockets.push(next);
      return next;
    },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  return { transcription, socket, sockets, clock, emitted, queued, urls, inits };
}

function results({ transcript, isFinal = false, speechFinal = false }) {
  return JSON.stringify({
    type: "Results",
    is_final: isFinal,
    speech_final: speechFinal,
    channel: { alternatives: [{ transcript }] },
  });
}

test("buildDeepgramUrl declares the exact encoding and rate the browser sends", () => {
  const url = new URL(buildDeepgramUrl());
  assert.equal(url.origin + url.pathname, "wss://api.deepgram.com/v1/listen");
  assert.equal(url.searchParams.get("model"), "nova-3");
  // Raw PCM has no container: a wrong guess here transcribes a chipmunk.
  assert.equal(url.searchParams.get("encoding"), "linear16");
  assert.equal(url.searchParams.get("sample_rate"), "24000");
  assert.equal(url.searchParams.get("channels"), "1");
  assert.equal(url.searchParams.get("interim_results"), "true");
  assert.equal(url.searchParams.get("smart_format"), "true");
  assert.equal(url.searchParams.get("punctuate"), "true");
  assert.equal(url.searchParams.get("endpointing"), "1000");
});

test("buildDeepgramUrl repeats keyterm once per term and honours the vendor utterance_end floor", () => {
  const url = new URL(
    buildDeepgramUrl({ keyterms: ["Kubernetes", "gRPC"], utteranceEndMs: 10 }),
  );
  assert.deepEqual(url.searchParams.getAll("keyterm"), ["Kubernetes", "gRPC"]);
  assert.equal(url.searchParams.get("utterance_end_ms"), "1000");
});

test("parseDeepgramMessage separates interim rewrites from settled segments", () => {
  assert.deepEqual(parseDeepgramMessage({
    type: "Results",
    is_final: false,
    channel: { alternatives: [{ transcript: "load bal" }] },
  }), [{ kind: "partial", text: "load bal" }]);

  assert.deepEqual(parseDeepgramMessage({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "load balancer." }] },
  }), [{ kind: "final", text: "load balancer.", speechFinal: true }]);

  // An empty transcript is a breath, not a sentence - forwarding it would blank
  // the caption mid-thought.
  assert.deepEqual(parseDeepgramMessage({
    type: "Results",
    is_final: true,
    channel: { alternatives: [{ transcript: "   " }] },
  }), []);

  assert.deepEqual(parseDeepgramMessage({ type: "UtteranceEnd" }), [{ kind: "utterance-end" }]);
  assert.deepEqual(
    parseDeepgramMessage({ type: "Error", description: "bad audio" }),
    [{ kind: "error", message: "bad audio" }],
  );
});

test("mergeKeyterms de-duplicates case-insensitively and keeps the configured spelling first", () => {
  assert.deepEqual(
    mergeKeyterms(["gRPC", "Kubernetes"], ["grpc", "Envoy", "  "]),
    ["gRPC", "Kubernetes", "Envoy"],
  );
  assert.deepEqual(mergeKeyterms(null, null), []);
});

test("createDeepgramTranscription authenticates with the Token scheme", () => {
  const { transcription, inits } = setup();
  transcription.sendAudio("AAAA");
  assert.equal(inits.length, 1);
  assert.equal(inits[0].headers.Authorization, "Token dg-test");
});

test("createDeepgramTranscription errors when no key is configured, without opening a socket", () => {
  const { transcription, emitted, urls } = setup({ env: {} });
  transcription.sendAudio("AAAA");
  assert.equal(urls.length, 0);
  assert.deepEqual(emitted, [{
    type: "error",
    message: "DEEPGRAM_API_KEY is required for the Deepgram transcription provider.",
  }]);
});

test("audio buffered before open is flushed as binary PCM once the socket opens", () => {
  const { transcription, socket } = setup();
  const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  transcription.sendAudio(pcm.toString("base64"));
  // Nothing on the wire yet - the socket is still connecting.
  assert.equal(socket.binary.length, 0);

  socket.emit("open");

  assert.equal(socket.binary.length, 1);
  // Deepgram wants raw frames, not the browser's base64 envelope.
  assert.deepEqual(socket.binary[0], pcm);
});

test("interim results become partials and speech_final commits the accumulated turn", () => {
  const { transcription, socket, emitted, queued } = setup();
  transcription.sendAudio("AAAA");
  socket.emit("open");

  socket.emit("message", results({ transcript: "a load" }));
  socket.emit("message", results({ transcript: "a load balancer" }));
  socket.emit("message", results({ transcript: "a load balancer", isFinal: true }));

  assert.deepEqual(emitted.map((m) => m.type), [
    "transcript:partial",
    "transcript:partial",
    "transcript:partial",
  ]);
  assert.equal(queued.length, 0, "an is_final without speech_final is not a turn yet");

  // Second sentence lands, and this one ends on silence.
  socket.emit("message", results({ transcript: "spreads requests" }));
  socket.emit("message", results({
    transcript: "spreads requests.",
    isFinal: true,
    speechFinal: true,
  }));

  const committed = emitted.filter((m) => m.type === "transcript:committed");
  assert.equal(committed.length, 1);
  assert.equal(committed[0].text, "a load balancer spreads requests.");
  assert.deepEqual(queued, ["a load balancer spreads requests."]);
});

test("partials restate the whole turn rather than appending interim fragments", () => {
  const { transcription, socket, emitted } = setup();
  transcription.sendAudio("AAAA");
  socket.emit("open");

  socket.emit("message", results({ transcript: "first sentence.", isFinal: true }));
  socket.emit("message", results({ transcript: "the" }));
  socket.emit("message", results({ transcript: "the second" }));

  const partials = emitted.filter((m) => m.type === "transcript:partial").map((m) => m.text);
  assert.deepEqual(partials, [
    "first sentence.",
    "first sentence. the",
    "first sentence. the second",
  ]);
});

test("UtteranceEnd commits a settled segment whose final never carried speech_final", () => {
  const { transcription, socket, queued } = setup();
  transcription.sendAudio("AAAA");
  socket.emit("open");

  socket.emit("message", results({ transcript: "three servers.", isFinal: true }));
  assert.deepEqual(queued, []);

  socket.emit("message", JSON.stringify({ type: "UtteranceEnd" }));
  assert.deepEqual(queued, ["three servers."]);
});

test("KeepAlive is sent on a 5s cadence while the socket is held open", () => {
  const { transcription, socket, clock } = setup();
  transcription.sendAudio("AAAA");
  socket.emit("open");

  const keepalives = () =>
    socket.sent.map((line) => JSON.parse(line)).filter((m) => m.type === "KeepAlive").length;

  assert.equal(keepalives(), 0);
  clock.advance(4999);
  assert.equal(keepalives(), 0, "Deepgram's idle timeout is ~10s; pinging earlier than 5s is waste");
  clock.advance(1);
  assert.equal(keepalives(), 1);
  clock.advance(10_000);
  assert.equal(keepalives(), 3);
});

test("KeepAlive stops once the socket is closed", () => {
  const { transcription, socket, clock } = setup();
  transcription.sendAudio("AAAA");
  socket.emit("open");
  clock.advance(5000);
  const before = socket.sent.length;

  transcription.close();
  clock.advance(60_000);

  const keepalivesAfter = socket.sent
    .slice(before)
    .map((line) => JSON.parse(line))
    .filter((m) => m.type === "KeepAlive").length;
  assert.equal(keepalivesAfter, 0);
});

test("close sends CloseStream BEFORE closing, so Deepgram's tail still arrives", () => {
  const { transcription, socket, clock, queued } = setup();
  transcription.sendAudio("AAAA");
  socket.emit("open");
  socket.emit("message", results({ transcript: "the last words" }));

  transcription.close();

  const control = socket.sent.map((line) => JSON.parse(line)).filter((m) => m.type === "CloseStream");
  assert.equal(control.length, 1, "CloseStream must be sent");
  assert.equal(socket.closed, false, "the socket must still be open to receive the final");

  // The final Deepgram owed us arrives after CloseStream and still counts.
  socket.emit("message", results({
    transcript: "the last words.",
    isFinal: true,
    speechFinal: true,
  }));
  assert.deepEqual(queued, ["the last words."]);

  clock.advance(1500);
  assert.equal(socket.closed, true, "and only then does the socket close");
});

test("stop asks Deepgram to Finalize and commits its corrected text, not the interim guess", () => {
  const { transcription, socket, clock, queued } = setup();
  transcription.sendAudio("AAAA");
  socket.emit("open");
  socket.emit("message", results({ transcript: "three server" }));

  transcription.stop();

  const control = socket.sent.map((line) => JSON.parse(line)).filter((m) => m.type === "Finalize");
  assert.equal(control.length, 1);
  assert.deepEqual(queued, [], "stop waits briefly for the flush rather than committing immediately");

  socket.emit("message", results({
    transcript: "three servers.",
    isFinal: true,
    speechFinal: true,
  }));
  assert.deepEqual(queued, ["three servers."]);

  // The grace timer must not fire a second, empty turn.
  clock.advance(5000);
  assert.deepEqual(queued, ["three servers."]);
});

test("stop still commits when Deepgram never answers the Finalize", () => {
  const { transcription, socket, clock, queued } = setup();
  transcription.sendAudio("AAAA");
  socket.emit("open");
  socket.emit("message", results({ transcript: "an unfinished thought" }));

  transcription.stop();
  assert.deepEqual(queued, []);

  clock.advance(800);
  assert.deepEqual(queued, ["an unfinished thought"], "a silent vendor must not swallow the turn");
});

test("a Deepgram error frame surfaces as a transcript error", () => {
  const { transcription, socket, emitted } = setup();
  transcription.sendAudio("AAAA");
  socket.emit("open");

  socket.emit("message", JSON.stringify({ type: "Error", description: "Sample rate mismatch" }));

  assert.deepEqual(emitted, [{ type: "error", message: "Sample rate mismatch" }]);
});

test("a socket-level failure (e.g. HTTP 401) surfaces without leaking the key", () => {
  const { transcription, socket, emitted } = setup();
  transcription.sendAudio("AAAA");

  socket.emit("error", new Error("Unexpected server response: 401"));

  assert.deepEqual(emitted, [{ type: "error", message: "Unexpected server response: 401" }]);
  assert.equal(JSON.stringify(emitted).includes("dg-test"), false);
});

test("the API key never appears in anything sent to the browser or on the wire", () => {
  const { transcription, socket, clock, emitted } = setup();
  transcription.sendAudio("AAAA");
  socket.emit("open");
  socket.emit("message", results({ transcript: "hello" }));
  socket.emit("message", results({ transcript: "hello.", isFinal: true, speechFinal: true }));
  clock.advance(10_000);
  transcription.stop();
  transcription.close();

  const everythingEmitted = JSON.stringify(emitted);
  assert.equal(everythingEmitted.includes("dg-test"), false);
  // The key belongs in the Authorization header only, never in a frame.
  assert.equal(socket.sent.join("").includes("dg-test"), false);
});

test("setSessionContext folds staging keywords into keyterms and reconnects to apply them", () => {
  const { transcription, socket, sockets, urls } = setup({
    options: { deepgramKeyterms: ["Kubernetes"] },
  });
  transcription.sendAudio("AAAA");
  socket.emit("open");

  assert.deepEqual(new URL(urls[0]).searchParams.getAll("keyterm"), ["Kubernetes"]);

  transcription.setSessionContext({ keywords: ["Envoy", "kubernetes"] });

  // Keyterms live in the connect URL, so a change means a fresh socket.
  assert.equal(urls.length, 2);
  assert.equal(socket.closed, true);
  assert.deepEqual(new URL(urls[1]).searchParams.getAll("keyterm"), ["Kubernetes", "Envoy"]);
  assert.equal(sockets.length, 2);
});

test("setSessionContext with unchanged keyterms does not churn the socket", () => {
  const { transcription, socket, urls } = setup({ options: { deepgramKeyterms: ["gRPC"] } });
  transcription.sendAudio("AAAA");
  socket.emit("open");

  transcription.setSessionContext({ keywords: ["gRPC"] });
  transcription.setSessionContext({ keywords: [] });

  assert.equal(urls.length, 1);
  assert.equal(socket.closed, false);
});

test("a superseded socket's close does not tear down the socket that replaced it", () => {
  const { transcription, socket, sockets } = setup({ options: { deepgramKeyterms: ["a"] } });
  transcription.sendAudio("AAAA");
  socket.emit("open");

  transcription.setSessionContext({ keywords: ["b"] });
  const replacement = sockets[1];
  replacement.emit("open");

  // The old socket's TCP close lands late. It must not null out the live one.
  socket.emit("close");

  const pcm = Buffer.from([0x09, 0x09]);
  transcription.sendAudio(pcm.toString("base64"));
  assert.deepEqual(replacement.binary.at(-1), pcm);
});

test("ready resolves on open and rejects when the socket dies first", async () => {
  const { transcription, socket } = setup();
  const readyPromise = transcription.ready();
  socket.emit("open");
  await readyPromise;

  const second = setup();
  const failing = second.transcription.ready();
  second.socket.emit("close");
  await assert.rejects(failing, /closed before it was ready/);
});

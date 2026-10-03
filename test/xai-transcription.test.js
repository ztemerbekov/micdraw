// @ts-nocheck - hand-rolled EventEmitter is used as a fake WebSocket; structural types fight here.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { buildXaiSttUrl, createXaiTranscription, parseXaiMessage } from "../src/xai-transcription.js";

function createMockSocket() {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.binary = [];
  socket.closed = false;
  socket.send = (data) => {
    if (Buffer.isBuffer(data)) socket.binary.push(data);
    else socket.sent.push(String(data));
  };
  socket.close = () => {
    socket.closed = true;
    socket.emit("close");
  };
  socket.receive = (message) => socket.emit("message", Buffer.from(JSON.stringify(message)));
  return socket;
}

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeoutFn: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeoutFn: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

function setup({ options = {}, env = { XAI_API_KEY: "xai-test" } } = {}) {
  const sockets = [];
  const clock = createFakeClock();
  const sent = [];
  const queued = [];
  const transcription = createXaiTranscription({
    sendTranscript: (message) => sent.push(message),
    queueTranscript: (text) => queued.push(text),
    options,
    env,
    createWebSocket: (url, protocols, init) => {
      const socket = createMockSocket();
      socket.url = url;
      socket.init = init;
      sockets.push(socket);
      return socket;
    },
    log: { debug: () => {} },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  return { transcription, sockets, clock, sent, queued, socket: () => sockets.at(-1) };
}

const partials = (sent) => sent.filter((m) => m.type === "transcript:partial").map((m) => m.text);
const commits = (sent) => sent.filter((m) => m.type === "transcript:committed").map((m) => m.text);

test("buildXaiSttUrl asks for the audio the browser sends, interim results and Smart Turn", () => {
  const url = new URL(buildXaiSttUrl({ language: "ru" }));
  assert.equal(`${url.origin}${url.pathname}`, "wss://api.x.ai/v1/stt");
  assert.equal(url.searchParams.get("sample_rate"), "24000");
  assert.equal(url.searchParams.get("encoding"), "pcm");
  assert.equal(url.searchParams.get("interim_results"), "true");
  assert.equal(url.searchParams.get("model"), "grok-voice-transcribe-2.0");
  assert.equal(url.searchParams.get("smart_turn"), "0.7");
  assert.equal(url.searchParams.get("smart_turn_timeout"), "1200");
  assert.equal(url.searchParams.get("language"), "ru");
});

test("buildXaiSttUrl sends at most 100 keyterms of at most 50 characters", () => {
  const terms = Array.from({ length: 120 }, (_, i) => `term-${i}`);
  terms[0] = "x".repeat(60);
  const url = new URL(buildXaiSttUrl({ keyterms: terms }));
  const sentTerms = url.searchParams.getAll("keyterm");
  assert.equal(sentTerms.length, 100);
  assert.equal(sentTerms[0], "x".repeat(50));
  assert.equal(url.searchParams.has("language"), false);
});

test("parseXaiMessage tells interim text, settled chunks, turn ends and errors apart", () => {
  assert.deepEqual(parseXaiMessage({ type: "transcript.created" }), [{ kind: "ready" }]);
  assert.deepEqual(parseXaiMessage({ type: "transcript.partial", text: " hello ", is_final: false, speech_final: false }), [
    { kind: "partial", text: "hello" },
  ]);
  assert.deepEqual(parseXaiMessage({ type: "transcript.partial", text: "hello", is_final: true, speech_final: false }), [
    { kind: "final", text: "hello", speechFinal: false },
  ]);
  assert.deepEqual(parseXaiMessage({ type: "transcript.partial", text: "", is_final: true, speech_final: true }), [
    { kind: "final", text: "", speechFinal: true },
  ]);
  assert.deepEqual(parseXaiMessage({ type: "transcript.partial", text: "", is_final: false, speech_final: false }), []);
  assert.deepEqual(parseXaiMessage({ type: "error", message: "bad audio" }), [{ kind: "error", message: "bad audio" }]);
});

test("createXaiTranscription authenticates with a Bearer key", () => {
  const { transcription, socket } = setup();
  transcription.sendAudio(Buffer.from("pcm").toString("base64"));
  assert.equal(socket().init.headers.Authorization, "Bearer xai-test");
});

test("createXaiTranscription errors when no key is configured, without opening a socket", async () => {
  const { transcription, sockets, sent } = setup({ env: {} });
  await assert.rejects(transcription.ready(), /XAI_API_KEY/);
  assert.equal(sockets.length, 0);
  assert.match(sent.find((m) => m.type === "error").message, /XAI_API_KEY/);
});

test("audio waits for transcript.created, then goes out as binary PCM, and ready resolves", async () => {
  const { transcription, socket } = setup();
  const ready = transcription.ready();
  transcription.sendAudio(Buffer.from("first").toString("base64"));
  assert.equal(socket().binary.length, 0);
  socket().receive({ type: "transcript.created" });
  await ready;
  transcription.sendAudio(Buffer.from("second").toString("base64"));
  assert.deepEqual(socket().binary.map((b) => b.toString()), ["first", "second"]);
});

test("settled chunks build the turn, and speech_final commits it once", () => {
  const { transcription, socket, sent, queued } = setup();
  transcription.sendAudio("AA==");
  socket().receive({ type: "transcript.created" });
  socket().receive({ type: "transcript.partial", text: "the pipeline", is_final: false, speech_final: false });
  socket().receive({ type: "transcript.partial", text: "the pipeline has three", is_final: true, speech_final: false });
  socket().receive({ type: "transcript.partial", text: "stages", is_final: false, speech_final: false });
  socket().receive({ type: "transcript.partial", text: "stages", is_final: true, speech_final: true });
  assert.deepEqual(partials(sent), ["the pipeline", "the pipeline has three", "the pipeline has three stages", "the pipeline has three stages"]);
  assert.deepEqual(commits(sent), ["the pipeline has three stages"]);
  assert.deepEqual(queued, ["the pipeline has three stages"]);
});

test("a chunk that repeats the text before it replaces it instead of doubling the turn", () => {
  // xAI's docs do not say whether a chunk's text restates the earlier chunks.
  const { transcription, socket, queued } = setup();
  transcription.sendAudio("AA==");
  socket().receive({ type: "transcript.created" });
  socket().receive({ type: "transcript.partial", text: "the pipeline has three", is_final: true, speech_final: false });
  socket().receive({ type: "transcript.partial", text: "the pipeline has three stages", is_final: true, speech_final: true });
  assert.deepEqual(queued, ["the pipeline has three stages"]);
});

test("stop asks xAI to finalize and commits its answer, not the interim guess", () => {
  const { transcription, socket, queued, clock } = setup();
  transcription.sendAudio("AA==");
  socket().receive({ type: "transcript.created" });
  socket().receive({ type: "transcript.partial", text: "draw a cat", is_final: false, speech_final: false });
  transcription.stop();
  assert.deepEqual(socket().sent.map((s) => JSON.parse(s)), [{ type: "finalize" }]);
  socket().receive({ type: "transcript.partial", text: "draw a cart", is_final: true, speech_final: true });
  clock.advance(1000);
  assert.deepEqual(queued, ["draw a cart"]);
});

test("stop still commits what it holds when xAI never answers the finalize", () => {
  const { transcription, socket, queued, clock } = setup();
  transcription.sendAudio("AA==");
  socket().receive({ type: "transcript.created" });
  socket().receive({ type: "transcript.partial", text: "draw a cat", is_final: false, speech_final: false });
  transcription.stop();
  assert.deepEqual(queued, []);
  clock.advance(800);
  assert.deepEqual(queued, ["draw a cat"]);
});

test("an xAI error frame surfaces as a transcript error without the key", () => {
  const { transcription, socket, sent } = setup();
  transcription.sendAudio("AA==");
  socket().receive({ type: "error", message: "Invalid audio format" });
  assert.deepEqual(sent.filter((m) => m.type === "error").map((m) => m.message), ["Invalid audio format"]);
  assert.equal(JSON.stringify(sent).includes("xai-test"), false);
});

test("staging keywords become keyterms, and only a change reconnects", () => {
  const { transcription, sockets } = setup();
  transcription.sendAudio("AA==");
  transcription.setSessionContext({ keywords: ["Excalidraw", "Mic Draw"] });
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].closed, true);
  assert.deepEqual(new URL(sockets[1].url).searchParams.getAll("keyterm"), ["Excalidraw", "Mic Draw"]);
  transcription.setSessionContext({ keywords: ["Excalidraw", "Mic Draw"] });
  assert.equal(sockets.length, 2);
});

test("a superseded socket's close does not tear down the socket that replaced it", () => {
  const { transcription, sockets } = setup();
  transcription.sendAudio("AA==");
  transcription.setSessionContext({ keywords: ["Mic Draw"] });
  sockets[0].emit("close");
  sockets[1].receive({ type: "transcript.created" });
  transcription.sendAudio(Buffer.from("after").toString("base64"));
  assert.deepEqual(sockets[1].binary.map((b) => b.toString()), ["\u0000", "after"]);
});

test("close before xAI is ready rejects a pending ready instead of leaving it hanging", async () => {
  const { transcription, socket } = setup();
  const ready = transcription.ready();
  transcription.close();
  assert.equal(socket().closed, true);
  await assert.rejects(ready, /closed before it was ready/);
});

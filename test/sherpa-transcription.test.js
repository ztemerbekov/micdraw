// @ts-nocheck - fakes stand in for the worker thread and the model downloader.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createSherpaTranscription } from "../src/sherpa-transcription.js";

class FakeWorker extends EventEmitter {
  constructor(workerData) {
    super();
    this.workerData = workerData;
    this.posted = [];
    this.terminated = false;
  }
  postMessage(message) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

const MODEL = { id: "vosk-small-ru-2025-08-16", label: "Vosk small (sherpa-onnx)", files: {} };
const FILES = { encoder: "/m/e.onnx", decoder: "/m/d.onnx", joiner: "/m/j.onnx", tokens: "/m/t.txt" };

function setup({ ensureModel = async () => FILES } = {}) {
  const sent = [];
  const queued = [];
  const statuses = [];
  let worker = null;
  const engine = createSherpaTranscription({
    sendTranscript: (message) => sent.push(message),
    queueTranscript: (text) => queued.push(text),
    options: { localModel: MODEL, modelsDir: "/models", onStatus: (message) => statuses.push(message) },
    createWorker: (workerData) => (worker = new FakeWorker(workerData)),
    ensureModel,
  });
  return { engine, sent, queued, statuses, worker: () => worker };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function started(ctx) {
  const ready = ctx.engine.ready();
  await tick();
  ctx.worker().emit("message", { type: "ready" });
  await ready;
}

test("ready downloads the model, starts the worker and waits for it", async () => {
  let ensured = null;
  const ctx = setup({ ensureModel: async (model, options) => ((ensured = { model, options }), FILES) });
  const ready = ctx.engine.ready();
  await tick();
  assert.equal(ensured.model, MODEL);
  assert.equal(ensured.options.modelsDir, "/models");
  assert.deepEqual(ctx.worker().workerData, { files: FILES, endpointSilenceSeconds: 0.8 });
  ctx.worker().emit("message", { type: "ready" });
  await ready;
});

test("partial text goes to the page; committed text also goes to the agent", async () => {
  const ctx = setup();
  await started(ctx);

  ctx.worker().emit("message", { type: "transcript:partial", text: "при" });
  ctx.worker().emit("message", { type: "transcript:committed", text: "привет" });

  assert.deepEqual(ctx.sent, [
    { type: "transcript:partial", text: "при" },
    { type: "transcript:committed", text: "привет" },
  ]);
  assert.deepEqual(ctx.queued, ["привет"]);
});

test("audio reaches the worker as 24 kHz PCM16; stop and close are forwarded", async () => {
  const ctx = setup();
  await started(ctx);

  ctx.engine.sendAudio(Buffer.from(new Int16Array([1, -2, 3]).buffer).toString("base64"));
  const [audio] = ctx.worker().posted;
  assert.equal(audio.type, "audio");
  assert.equal(audio.sampleRate, 24000);
  assert.deepEqual([...new Int16Array(audio.pcm)], [1, -2, 3]);

  ctx.engine.stop();
  assert.deepEqual(ctx.worker().posted.at(-1), { type: "stop" });
  ctx.engine.close();
  assert.equal(ctx.worker().terminated, true);
});

test("a worker that fails to start rejects ready", async () => {
  const ctx = setup();
  const ready = ctx.engine.ready();
  await tick();
  ctx.worker().emit("error", new Error("no native addon for this platform"));
  await assert.rejects(ready, /no native addon/);
});

test("download progress is reported in 10% steps", async () => {
  const ctx = setup({
    ensureModel: async (_model, { onProgress }) => {
      for (const receivedBytes of [5, 10, 11, 50, 100]) onProgress({ receivedBytes, totalBytes: 100 });
      return FILES;
    },
  });
  ctx.engine.ready();
  await tick();
  assert.deepEqual(ctx.statuses, [
    "Downloading Vosk small (sherpa-onnx): 10%",
    "Downloading Vosk small (sherpa-onnx): 50%",
    "Downloading Vosk small (sherpa-onnx): 100%",
  ]);
});

test("download progress reaches onProgress once per whole percent", async () => {
  const progress = [];
  const sent = [];
  const engine = createSherpaTranscription({
    sendTranscript: (message) => sent.push(message),
    queueTranscript: () => {},
    options: { localModel: MODEL, modelsDir: "/models", onProgress: (event) => progress.push(event.receivedBytes) },
    createWorker: (workerData) => new FakeWorker(workerData),
    ensureModel: async (_model, { onProgress }) => {
      for (const receivedBytes of [1, 1, 2, 50, 50, 100]) onProgress({ receivedBytes, totalBytes: 100 });
      return FILES;
    },
  });
  engine.ready();
  await tick();
  assert.deepEqual(progress, [1, 2, 50, 100]);
});

// @ts-nocheck - fake engines stand in for the real transcription providers.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";

import { startServer } from "../src/server.js";
import { createSettingsStore } from "../src/settings-store.js";
import { tempDir } from "./helpers/tmp.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Every engine stays "loading" until the test finishes or fails it.
function fakeEngines() {
  const engines = [];
  const factory = ({ options }) => {
    const loading = deferred();
    const engine = {
      options,
      closed: false,
      ready: () => loading.promise,
      sendAudio: () => {},
      stop: () => {},
      close: () => {
        engine.closed = true;
      },
      finishLoading: () => loading.resolve(undefined),
      failLoading: (error) => loading.reject(error),
    };
    engines.push(engine);
    return engine;
  };
  return { engines, factory };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function startWithEngines(t) {
  const { engines, factory } = fakeEngines();
  const settingsStore = createSettingsStore({
    filePath: path.join(tempDir(t, "micdraw-switch-"), "settings.json"),
    env: {},
    readCodexAuth: () => null,
  });
  const starting = startServer({ host: "127.0.0.1", port: 0, platform: "linux", settingsStore, createTranscription: factory });
  while (engines.length === 0) await tick();
  engines[0].finishLoading();
  const server = await starting;
  const messages = [];
  const ws = new WebSocket(server.url.replace("http:", "ws:") + "/ws", { origin: server.url });
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve) => ws.once("open", resolve));
  const close = async () => {
    ws.close();
    await new Promise((resolve) => server.httpServer.close(resolve));
  };
  return { ...server, engines, messages, close };
}

function saveTranscription(url, transcription) {
  return fetch(`${url}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: url },
    body: JSON.stringify({ transcription }),
  });
}

async function waitFor(messages, predicate) {
  for (let i = 0; i < 200; i += 1) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("message never arrived");
}

const isStatus = (state) => (message) => message.type === "transcription:status" && message.state === state;

test("saving settings returns before the new voice model is ready, and its progress reaches the page", async (t) => {
  const server = await startWithEngines(t);
  try {
    const res = await saveTranscription(server.url, { provider: "local", language: "ru" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(server.engines.length, 2);
    assert.equal(body.transcriptionEngine, "Kroko (sherpa-onnx)");
    assert.deepEqual(body.transcriptionStatus, { state: "preparing", label: "Vosk small (sherpa-onnx)" });

    server.engines[1].options.onProgress({ receivedBytes: 50, totalBytes: 100 });
    assert.deepEqual(await waitFor(server.messages, isStatus("downloading")), {
      type: "transcription:status",
      state: "downloading",
      label: "Vosk small (sherpa-onnx)",
      receivedBytes: 50,
      totalBytes: 100,
    });
    assert.equal(server.engines[0].closed, false);

    server.engines[1].finishLoading();
    await waitFor(server.messages, isStatus("ready"));
    await waitFor(server.messages, (message) => message.type === "config" && message.transcriptionEngine === "Vosk small (sherpa-onnx)");
    assert.equal(server.engines[0].closed, true);
  } finally {
    await server.close();
  }
});

test("a voice model that fails to load leaves the previous one running", async (t) => {
  const server = await startWithEngines(t);
  try {
    await saveTranscription(server.url, { provider: "local", language: "ru" });
    server.engines[1].failLoading(new Error("network down"));

    assert.deepEqual(await waitFor(server.messages, isStatus("error")), {
      type: "transcription:status",
      state: "error",
      label: "Vosk small (sherpa-onnx)",
      message: "network down",
    });
    await waitFor(server.messages, (message) => message.type === "error" && /Voice model failed: network down/.test(message.message));
    assert.equal(server.engines[1].closed, true);
    assert.equal(server.engines[0].closed, false);
    const config = await (await fetch(`${server.url}/api/config`)).json();
    assert.equal(config.transcriptionEngine, "Kroko (sherpa-onnx)");
  } finally {
    await server.close();
  }
});

test("the most recent voice choice wins over one still loading", async (t) => {
  const server = await startWithEngines(t);
  try {
    await saveTranscription(server.url, { provider: "local", language: "ru" });
    await saveTranscription(server.url, { provider: "local", language: "en" });
    server.engines[1].finishLoading();
    await tick();

    assert.equal(server.engines[1].closed, true);
    assert.equal(server.engines[0].closed, false);
    const config = await (await fetch(`${server.url}/api/config`)).json();
    assert.equal(config.transcriptionEngine, "Kroko (sherpa-onnx)");
    assert.deepEqual(config.transcriptionStatus, { state: "ready", label: "Kroko (sherpa-onnx)" });
  } finally {
    await server.close();
  }
});

test("changing only the language of a cloud provider restarts it with that language", async (t) => {
  const server = await startWithEngines(t);
  try {
    await saveTranscription(server.url, { provider: "deepgram", language: "ru" });
    assert.equal(server.engines.length, 2);
    assert.equal(server.engines[1].options.transcriptionLanguage, "ru");
    server.engines[1].finishLoading();
    await waitFor(server.messages, (message) => message.type === "config" && message.transcriptionEngine === "Deepgram nova-3");

    await saveTranscription(server.url, { language: "uk" });
    assert.equal(server.engines.length, 3);
    assert.equal(server.engines[2].options.transcriptionLanguage, "uk");
  } finally {
    await server.close();
  }
});

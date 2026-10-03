# Local Multilingual Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `local` transcription provider that streams English and Russian on the user's machine, choosing Moonshine (macOS, English) or sherpa-onnx (everything else) from a model catalog.

**Architecture:** `src/local-models.js` holds the catalog and resolves a model by language and platform. sherpa-onnx models are downloaded once, checksum-verified, by `src/model-download.js`, and decoded in a worker thread (`src/sherpa-worker.js`) driven by `src/sherpa-transcription.js`, which implements the existing engine contract. `resolveTranscriptionEngine` in `src/server.js` maps settings to an engine; the UI offers language and model.

**Tech Stack:** Node 24+, plain ESM JavaScript, `node:test`, `sherpa-onnx-node` ^1.13.8, `worker_threads`, React via esm.sh (no build step).

**Spec:** `docs/specs/2026-10-03-local-multilingual-transcription.md`

## Global Constraints

- Display name **Mic Draw**; identifiers `micdraw`; models live in `~/.config/micdraw/models/<model id>/`.
- Supported languages: `"en"`, `"ru"`; default `"en"`.
- Default provider for new installs: `"local"`. Provider `"moonshine"` keeps its old meaning.
- English default: Moonshine medium on `darwin`, Kroko on `linux` and `win32`. Russian: Vosk small everywhere.
- Kroko: `csukuangfj/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06` @ `572aaf4e2e0c603c3fc2a574d096e755a178faa1`.
- Vosk: `csukuangfj/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16` @ `31fa603e4f31279c6e1f7600fed13dc4312663ab`.
- Browser audio: base64 PCM16 at 24 000 Hz. Endpoint silence: 0.8 s.
- Every HTTP route and WebSocket path stays behind `isAllowedRequest` (AGENTS.md).
- TDD: failing test first. Commits use conventional messages ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Local model catalog

**Files:**
- Create: `src/local-models.js`
- Test: `test/local-models.test.js`

**Interfaces:**
- Produces: `SUPPORTED_LANGUAGES: string[]`, `LOCAL_MODELS: object[]`, `localModelsFor({ language, platform }): object[]`, `resolveLocalModel({ language, platform, preferredId }): object`, `modelFileUrl(model, file): string`, `localModelSummaries(platform): { id, label, language, engine, downloadBytes }[]`.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { localModelSummaries, localModelsFor, modelFileUrl, resolveLocalModel, SUPPORTED_LANGUAGES } from "../src/local-models.js";

test("English defaults to Moonshine on macOS and to Kroko elsewhere", () => {
  assert.equal(resolveLocalModel({ language: "en", platform: "darwin" }).id, "moonshine-medium");
  assert.equal(resolveLocalModel({ language: "en", platform: "linux" }).id, "kroko-en-2025-08-06");
  assert.equal(resolveLocalModel({ language: "en", platform: "win32" }).id, "kroko-en-2025-08-06");
});

test("Russian uses Vosk small on every platform", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.equal(resolveLocalModel({ language: "ru", platform }).id, "vosk-small-ru-2025-08-16");
  }
});

test("a preferred model is used when it fits the language and platform", () => {
  assert.equal(resolveLocalModel({ language: "en", platform: "darwin", preferredId: "kroko-en-2025-08-06" }).id, "kroko-en-2025-08-06");
  assert.equal(resolveLocalModel({ language: "en", platform: "linux", preferredId: "moonshine-small" }).id, "kroko-en-2025-08-06");
  assert.equal(resolveLocalModel({ language: "ru", platform: "darwin", preferredId: "kroko-en-2025-08-06" }).id, "vosk-small-ru-2025-08-16");
});

test("unknown languages have no local model", () => {
  assert.deepEqual(localModelsFor({ language: "xx", platform: "darwin" }), []);
  assert.throws(() => resolveLocalModel({ language: "xx", platform: "darwin" }), /No local speech model/);
  assert.deepEqual(SUPPORTED_LANGUAGES, ["en", "ru"]);
});

test("sherpa model files are pinned to a commit and summarised with their download size", () => {
  const vosk = resolveLocalModel({ language: "ru", platform: "linux" });
  assert.equal(
    modelFileUrl(vosk, vosk.files.encoder),
    "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16/resolve/31fa603e4f31279c6e1f7600fed13dc4312663ab/encoder.int8.onnx",
  );
  const summaries = localModelSummaries("darwin");
  assert.deepEqual(summaries.find((model) => model.id === "vosk-small-ru-2025-08-16"), {
    id: "vosk-small-ru-2025-08-16",
    label: "Vosk small (sherpa-onnx)",
    language: "ru",
    engine: "sherpa",
    downloadBytes: 28572945,
  });
  assert.equal(summaries.find((model) => model.id === "moonshine-medium").downloadBytes, null);
  assert.equal(localModelSummaries("linux").some((model) => model.engine === "moonshine"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/local-models.test.js`
Expected: FAIL, cannot find module `../src/local-models.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// Local speech-to-text models. The "local" transcription provider picks one by
// language and platform: Moonshine on macOS for English (it commits a phrase
// fastest), sherpa-onnx streaming models everywhere else. Order matters: the
// first model that runs on the platform is the default for its language.
export const SUPPORTED_LANGUAGES = Object.freeze(["en", "ru"]);

const ALL_PLATFORMS = ["darwin", "linux", "win32"];

export const LOCAL_MODELS = Object.freeze([
  { id: "moonshine-medium", engine: "moonshine", language: "en", label: "Moonshine medium", platforms: ["darwin"], moonshineModel: "medium" },
  { id: "moonshine-small", engine: "moonshine", language: "en", label: "Moonshine small", platforms: ["darwin"], moonshineModel: "small" },
  { id: "moonshine-tiny", engine: "moonshine", language: "en", label: "Moonshine tiny", platforms: ["darwin"], moonshineModel: "tiny" },
  {
    id: "kroko-en-2025-08-06",
    engine: "sherpa",
    language: "en",
    label: "Kroko (sherpa-onnx)",
    license: "CC-BY-SA",
    source: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06",
    revision: "572aaf4e2e0c603c3fc2a574d096e755a178faa1",
    files: {
      encoder: { name: "encoder.onnx", size: 70092599, sha256: "d4881c57449d581e0770fd53fa66c2fdc6cd167d92ece7c715e603defc96d9d4" },
      decoder: { name: "decoder.onnx", size: 617488, sha256: "455ba38466fce8d5a57e7db68a323b684079ca4d9e1dd93a740d9b2429aae3b1" },
      joiner: { name: "joiner.onnx", size: 336817, sha256: "d406f616736350e2a7df3e39398b78eb2fc1a2ca6973a19d3853fa3227e25b52" },
      tokens: { name: "tokens.txt", size: 6310, sha256: "396dbeb5f4858875690716084f54e90d339679d0ba3e6b5b584f3d7589254d2d" },
    },
  },
  {
    id: "vosk-small-ru-2025-08-16",
    engine: "sherpa",
    language: "ru",
    label: "Vosk small (sherpa-onnx)",
    license: "Apache-2.0",
    source: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16",
    revision: "31fa603e4f31279c6e1f7600fed13dc4312663ab",
    files: {
      encoder: { name: "encoder.int8.onnx", size: 26214060, sha256: "e0db705e94ec35d803b1df4f40cda23d064e1142977c80ab288430b109777a9d" },
      decoder: { name: "decoder.onnx", size: 2093080, sha256: "89b3088a9e20e1ef7f2e85ce1a3478afe6a9c4ac57369cabcc4beb8e95328ea0" },
      joiner: { name: "joiner.int8.onnx", size: 259417, sha256: "b55784b071ab7512eab4c7c44e4f5478284ef33c83562cc6a249b972515a31e5" },
      tokens: { name: "tokens.txt", size: 6388, sha256: "93bbbc0bae6b78c0bbb743d4aa9fded3bb5ff3aac5f0200e3a769a5a05e0fdf6" },
    },
  },
]);

function runsOn(model, platform) {
  return (model.platforms ?? ALL_PLATFORMS).includes(platform);
}

export function localModelsFor({ language, platform }) {
  return LOCAL_MODELS.filter((model) => model.language === language && runsOn(model, platform));
}

export function resolveLocalModel({ language, platform, preferredId = undefined }) {
  const candidates = localModelsFor({ language, platform });
  if (candidates.length === 0) throw new Error(`No local speech model for language "${language}" on ${platform}.`);
  return candidates.find((model) => model.id === preferredId) ?? candidates[0];
}

export function modelFileUrl(model, file) {
  return `${model.source}/resolve/${model.revision}/${file.name}`;
}

export function localModelSummaries(platform) {
  return LOCAL_MODELS.filter((model) => runsOn(model, platform)).map((model) => ({
    id: model.id,
    label: model.label,
    language: model.language,
    engine: model.engine,
    downloadBytes: model.files ? Object.values(model.files).reduce((sum, file) => sum + file.size, 0) : null,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/local-models.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/local-models.js test/local-models.test.js
git commit -m "feat(transcription): add a catalog of local streaming models"
```

### Task 2: Checksum-verified model download

**Files:**
- Create: `src/model-download.js`
- Test: `test/model-download.test.js`

**Interfaces:**
- Consumes: `modelFileUrl(model, file)` from Task 1.
- Produces: `ensureModelFiles(model, { modelsDir, fetchFn?, onProgress? }): Promise<Record<role, absolutePath>>`.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ensureModelFiles } from "../src/model-download.js";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function fakeModel(contents) {
  return {
    id: "fake-model",
    source: "https://example.test/repo",
    revision: "rev1",
    files: Object.fromEntries(
      Object.entries(contents).map(([role, text]) => [role, { name: `${role}.bin`, size: Buffer.byteLength(text), sha256: sha256(text) }]),
    ),
  };
}

function fakeFetch(bodies) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const name = url.split("/").pop();
    return new Response(bodies[name] ?? "", { status: bodies[name] === undefined ? 404 : 200 });
  };
  return { fetchFn, calls };
}

test("downloads every file, verifies it and returns the paths", async () => {
  const modelsDir = mkdtempSync(path.join(tmpdir(), "micdraw-models-"));
  const model = fakeModel({ encoder: "enc", tokens: "tok" });
  const { fetchFn, calls } = fakeFetch({ "encoder.bin": "enc", "tokens.bin": "tok" });
  const progress = [];

  const paths = await ensureModelFiles(model, { modelsDir, fetchFn, onProgress: (event) => progress.push(event) });

  assert.deepEqual(calls, ["https://example.test/repo/resolve/rev1/encoder.bin", "https://example.test/repo/resolve/rev1/tokens.bin"]);
  assert.equal(readFileSync(paths.encoder, "utf8"), "enc");
  assert.equal(readFileSync(paths.tokens, "utf8"), "tok");
  assert.deepEqual(progress.at(-1), { receivedBytes: 6, totalBytes: 6 });
});

test("a completed model is not downloaded again", async () => {
  const modelsDir = mkdtempSync(path.join(tmpdir(), "micdraw-models-"));
  const model = fakeModel({ encoder: "enc" });
  await ensureModelFiles(model, { modelsDir, fetchFn: fakeFetch({ "encoder.bin": "enc" }).fetchFn });

  const second = fakeFetch({ "encoder.bin": "enc" });
  await ensureModelFiles(model, { modelsDir, fetchFn: second.fetchFn });
  assert.deepEqual(second.calls, []);
});

test("a file with the wrong checksum is rejected and not kept", async () => {
  const modelsDir = mkdtempSync(path.join(tmpdir(), "micdraw-models-"));
  const model = fakeModel({ encoder: "enc" });

  await assert.rejects(
    ensureModelFiles(model, { modelsDir, fetchFn: fakeFetch({ "encoder.bin": "xyz" }).fetchFn }),
    /Checksum mismatch for encoder\.bin/,
  );
  const dir = path.join(modelsDir, "fake-model");
  assert.equal(existsSync(path.join(dir, "encoder.bin")), false);
  assert.equal(existsSync(path.join(dir, "encoder.bin.part")), false);
  assert.equal(existsSync(path.join(dir, ".complete")), false);
});

test("an HTTP error names the file", async () => {
  const modelsDir = mkdtempSync(path.join(tmpdir(), "micdraw-models-"));
  await assert.rejects(
    ensureModelFiles(fakeModel({ encoder: "enc" }), { modelsDir, fetchFn: fakeFetch({}).fetchFn }),
    /Download failed \(404\) for encoder\.bin/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/model-download.test.js`
Expected: FAIL, cannot find module `../src/model-download.js`.

- [ ] **Step 3: Write minimal implementation**

```js
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { modelFileUrl } from "./local-models.js";

const COMPLETE_MARKER = ".complete";

/**
 * Downloads a model's files into `<modelsDir>/<model id>/` once, checking each
 * against its pinned size and SHA-256, and returns absolute paths by role.
 */
export async function ensureModelFiles(model, { modelsDir, fetchFn = fetch, onProgress = (_event) => {} }) {
  const dir = path.join(modelsDir, model.id);
  const paths = Object.fromEntries(Object.entries(model.files).map(([role, file]) => [role, path.join(dir, file.name)]));
  if (await isComplete(dir, model)) return paths;

  await mkdir(dir, { recursive: true });
  const totalBytes = Object.values(model.files).reduce((sum, file) => sum + file.size, 0);
  let receivedBytes = 0;
  for (const [role, file] of Object.entries(model.files)) {
    await downloadVerified(modelFileUrl(model, file), paths[role], file, fetchFn, (bytes) => {
      receivedBytes += bytes;
      onProgress({ receivedBytes, totalBytes });
    });
  }
  await writeFile(path.join(dir, COMPLETE_MARKER), model.revision);
  return paths;
}

async function isComplete(dir, model) {
  try {
    return (await readFile(path.join(dir, COMPLETE_MARKER), "utf8")) === model.revision;
  } catch {
    return false;
  }
}

async function downloadVerified(url, target, file, fetchFn, onBytes) {
  const partial = `${target}.part`;
  try {
    const response = await fetchFn(url);
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${file.name}`);
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.length;
          onBytes(chunk.length);
          yield chunk;
        }
      },
      createWriteStream(partial),
    );
    const digest = hash.digest("hex");
    if (size !== file.size || digest !== file.sha256) {
      throw new Error(`Checksum mismatch for ${file.name}: expected ${file.sha256}, got ${digest}`);
    }
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/model-download.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/model-download.js test/model-download.test.js
git commit -m "feat(transcription): download local models once and verify their checksums"
```

### Task 3: Streaming session logic

**Files:**
- Create: `src/sherpa-session.js`
- Test: `test/sherpa-session.test.js`

**Interfaces:**
- Produces: `createSherpaSession(recognizer, { onPartial(text), onCommitted(text) }): { acceptWaveform(samples: Float32Array, sampleRate: number), stop() }`. `recognizer` is a sherpa-onnx `OnlineRecognizer` (or a fake with `createStream`, `isReady`, `decode`, `getResult`, `isEndpoint`, `reset`).

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { createSherpaSession } from "../src/sherpa-session.js";

// Each acceptWaveform call advances one scripted step: the text sherpa would
// report after that chunk and whether its endpoint detector fired.
function scriptedRecognizer(steps) {
  let step = -1;
  const recognizer = {
    streams: [],
    resets: 0,
    createStream() {
      const stream = {
        finished: false,
        acceptWaveform: () => {
          step += 1;
        },
        inputFinished() {
          this.finished = true;
        },
      };
      recognizer.streams.push(stream);
      return stream;
    },
    isReady: () => false,
    decode: () => {},
    getResult: () => ({ text: steps[step]?.text ?? "" }),
    isEndpoint: () => Boolean(steps[step]?.endpoint),
    reset() {
      recognizer.resets += 1;
    },
  };
  return recognizer;
}

function collect() {
  const events = [];
  return {
    events,
    onPartial: (text) => events.push(["partial", text]),
    onCommitted: (text) => events.push(["committed", text]),
  };
}

const chunk = new Float32Array(160);

test("reports growing text as partials and commits it at an endpoint", () => {
  const recognizer = scriptedRecognizer([{ text: "hel" }, { text: "hello" }, { text: "hello" }, { text: "hello world", endpoint: true }]);
  const sink = collect();
  const session = createSherpaSession(recognizer, sink);

  for (let i = 0; i < 4; i += 1) session.acceptWaveform(chunk, 24000);

  assert.deepEqual(sink.events, [
    ["partial", "hel"],
    ["partial", "hello"],
    ["partial", "hello world"],
    ["committed", "hello world"],
  ]);
  assert.equal(recognizer.resets, 1);
});

test("an endpoint on silence commits nothing", () => {
  const recognizer = scriptedRecognizer([{ text: "", endpoint: true }]);
  const sink = collect();
  createSherpaSession(recognizer, sink).acceptWaveform(chunk, 24000);
  assert.deepEqual(sink.events, []);
  assert.equal(recognizer.resets, 1);
});

test("stop commits the unfinished phrase and starts a fresh stream", () => {
  const recognizer = scriptedRecognizer([{ text: "half a" }, { text: "half a sentence" }]);
  const sink = collect();
  const session = createSherpaSession(recognizer, sink);

  session.acceptWaveform(chunk, 24000);
  session.acceptWaveform(chunk, 24000);
  session.stop();

  assert.deepEqual(sink.events.at(-1), ["committed", "half a sentence"]);
  assert.equal(recognizer.streams[0].finished, true);
  assert.equal(recognizer.streams.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sherpa-session.test.js`
Expected: FAIL, cannot find module `../src/sherpa-session.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// One continuous sherpa-onnx streaming session: feeds audio, reports the text
// as it grows, and commits a phrase when sherpa's endpoint detector fires.
export function createSherpaSession(recognizer, { onPartial, onCommitted }) {
  let stream = recognizer.createStream();
  let lastText = "";

  function decodeAvailable() {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    return recognizer.getResult(stream).text.trim();
  }

  function commit(text) {
    if (text) onCommitted(text);
    lastText = "";
  }

  return {
    acceptWaveform(samples, sampleRate) {
      stream.acceptWaveform({ samples, sampleRate });
      const text = decodeAvailable();
      if (text && text !== lastText) {
        lastText = text;
        onPartial(text);
      }
      if (recognizer.isEndpoint(stream)) {
        commit(text);
        recognizer.reset(stream);
      }
    },
    // Stop: finish whatever was said and start a fresh stream for the next session.
    stop() {
      stream.inputFinished();
      commit(decodeAvailable());
      stream = recognizer.createStream();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sherpa-session.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sherpa-session.js test/sherpa-session.test.js
git commit -m "feat(transcription): add the sherpa-onnx streaming session logic"
```

### Task 4: sherpa-onnx engine in a worker thread

**Files:**
- Create: `src/sherpa-worker.js`, `src/sherpa-transcription.js`
- Modify: `package.json`, `package-lock.json` (add `sherpa-onnx-node`)
- Test: `test/sherpa-transcription.test.js`

**Interfaces:**
- Consumes: `ensureModelFiles` (Task 2), `createSherpaSession` (Task 3).
- Produces: `createSherpaTranscription({ sendTranscript, queueTranscript, options, createWorker?, ensureModel? }): { ready(), sendAudio(base64), stop(), close(), setSessionContext() }`. Reads `options.localModel`, `options.modelsDir`, `options.onStatus`.

- [ ] **Step 1: Write the failing test**

```js
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
  const ready = ctx.engine.ready();
  await tick();
  ctx.worker().emit("message", { type: "ready" });
  await ready;

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
  const ready = ctx.engine.ready();
  await tick();
  ctx.worker().emit("message", { type: "ready" });
  await ready;

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sherpa-transcription.test.js`
Expected: FAIL, cannot find module `../src/sherpa-transcription.js`.

- [ ] **Step 3: Write minimal implementation**

`src/sherpa-transcription.js`:

```js
import { Worker } from "node:worker_threads";

import { ensureModelFiles } from "./model-download.js";

// The browser streams 24 kHz PCM16; sherpa-onnx resamples to its 16 kHz features.
const SAMPLE_RATE = 24000;
const ENDPOINT_SILENCE_SECONDS = 0.8;

function defaultCreateWorker(workerData) {
  return new Worker(new URL("./sherpa-worker.js", import.meta.url), { workerData });
}

export function createSherpaTranscription({
  sendTranscript,
  queueTranscript,
  options,
  createWorker = defaultCreateWorker,
  ensureModel = ensureModelFiles,
}) {
  const model = options.localModel;
  let worker = null;
  let closed = false;
  let readyPromise = null;

  function handleMessage(message) {
    if (message.type === "transcript:partial") {
      sendTranscript({ type: "transcript:partial", text: message.text });
    } else if (message.type === "transcript:committed") {
      sendTranscript({ type: "transcript:committed", text: message.text });
      queueTranscript(message.text);
    } else if (message.type === "error") {
      sendTranscript({ type: "error", message: `Local transcription error: ${message.message}` });
    }
  }

  function reportProgress() {
    let reported = 0;
    return ({ receivedBytes, totalBytes }) => {
      const percent = Math.floor((receivedBytes / totalBytes) * 10) * 10;
      if (percent > reported) {
        reported = percent;
        options.onStatus?.(`Downloading ${model.label}: ${percent}%`);
      }
    };
  }

  async function start() {
    const files = await ensureModel(model, { modelsDir: options.modelsDir, onProgress: reportProgress() });
    if (closed) return;
    worker = createWorker({ files, endpointSilenceSeconds: ENDPOINT_SILENCE_SECONDS });
    await new Promise((resolve, reject) => {
      worker.on("message", (message) => (message.type === "ready" ? resolve(undefined) : handleMessage(message)));
      worker.once("error", reject);
    });
    worker.on("error", (error) => sendTranscript({ type: "error", message: `Local transcription failed: ${error.message}` }));
  }

  return {
    ready: () => (readyPromise ??= start()),
    sendAudio: (audio) => {
      if (!worker) return;
      const bytes = Buffer.from(audio, "base64");
      const pcm = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      worker.postMessage({ type: "audio", pcm, sampleRate: SAMPLE_RATE }, [pcm]);
    },
    stop: () => worker?.postMessage({ type: "stop" }),
    close: () => {
      closed = true;
      worker?.terminate();
      worker = null;
    },
    // Staging-board keywords would need sherpa hotwords; not wired up yet.
    setSessionContext: () => {},
  };
}
```

`src/sherpa-worker.js`:

```js
// Runs one sherpa-onnx streaming recognizer off the main thread, so decoding
// never stalls the server's WebSocket and HTTP handling.
import { parentPort, workerData } from "node:worker_threads";

import { createSherpaSession } from "./sherpa-session.js";

const { files, endpointSilenceSeconds } = workerData;
const { default: sherpaOnnx } = await import("sherpa-onnx-node");

const recognizer = new sherpaOnnx.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
    tokens: files.tokens,
    numThreads: 2,
    provider: "cpu",
    debug: 0,
  },
  decodingMethod: "greedy_search",
  enableEndpoint: true,
  rule1MinTrailingSilence: 2.4,
  rule2MinTrailingSilence: endpointSilenceSeconds,
  rule3MinUtteranceLength: 30,
});

const session = createSherpaSession(recognizer, {
  onPartial: (text) => parentPort.postMessage({ type: "transcript:partial", text }),
  onCommitted: (text) => parentPort.postMessage({ type: "transcript:committed", text }),
});

parentPort.on("message", (message) => {
  try {
    if (message.type === "audio") {
      const pcm = new Int16Array(message.pcm);
      session.acceptWaveform(Float32Array.from(pcm, (sample) => sample / 32768), message.sampleRate);
    } else if (message.type === "stop") {
      session.stop();
    }
  } catch (error) {
    parentPort.postMessage({ type: "error", message: error.message });
  }
});

parentPort.postMessage({ type: "ready" });
```

Add the dependency:

```bash
npm install sherpa-onnx-node@^1.13.8 --save
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sherpa-transcription.test.js && npm run typecheck`
Expected: PASS, 5 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/sherpa-transcription.js src/sherpa-worker.js test/sherpa-transcription.test.js package.json package-lock.json
git commit -m "feat(transcription): add a sherpa-onnx streaming engine running in a worker thread"
```

### Task 5: Transcription settings

**Files:**
- Modify: `src/settings-store.js`
- Test: `test/settings-store.test.js`

**Interfaces:**
- Consumes: `SUPPORTED_LANGUAGES`, `LOCAL_MODELS` (Task 1).
- Produces: defaults `transcription.provider = "local"`, `transcription.language = "en"`, `transcription.local = { models: {} }`; `save()` rejects unknown providers, unsupported languages and local model ids that do not exist for the language.

- [ ] **Step 1: Write the failing test** (append to `test/settings-store.test.js`, and change the existing fallback test to expect `"local"`)

```js
test("createSettingsStore defaults to local transcription in English", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  assert.equal(settings.transcription.provider, "local");
  assert.equal(settings.transcription.language, "en");
  assert.deepEqual(settings.transcription.local, { models: {} });
});

test("createSettingsStore.save accepts a language and a local model for it", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  await store.save({ transcription: { provider: "local", language: "ru", local: { models: { ru: "vosk-small-ru-2025-08-16" } } } });
  const settings = await store.load();
  assert.equal(settings.transcription.language, "ru");
  assert.equal(settings.transcription.local.models.ru, "vosk-small-ru-2025-08-16");
});

test("createSettingsStore.save rejects unknown transcription choices", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  await assert.rejects(store.save({ transcription: { provider: "whisper.cpp" } }), /transcription provider/);
  await assert.rejects(store.save({ transcription: { language: "xx" } }), /language/);
  await assert.rejects(store.save({ transcription: { local: { models: { en: "vosk-small-ru-2025-08-16" } } } }), /local model/);
  await assert.rejects(store.save({ transcription: { local: { models: { xx: "kroko-en-2025-08-06" } } } }), /language/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/settings-store.test.js`
Expected: FAIL in the three new tests and in the fallback test.

- [ ] **Step 3: Write minimal implementation**

In `DEFAULT_SETTINGS.transcription` replace `provider: "moonshine", moonshine: { model: "medium" },` with:

```js
    provider: "local",
    language: "en",
    local: { models: {} },
    moonshine: { model: "medium" },
```

Import the catalog at the top: `import { LOCAL_MODELS, SUPPORTED_LANGUAGES } from "./local-models.js";`

In `save()`, after `validateBaseURLs(partial);` add `validateTranscription(partial?.transcription);`, and define:

```js
const TRANSCRIPTION_PROVIDERS = ["local", "moonshine", "openai", "deepgram"];

function validateTranscription(transcription) {
  if (!transcription || typeof transcription !== "object") return;
  const { provider, language, local } = transcription;
  if (provider !== undefined && !TRANSCRIPTION_PROVIDERS.includes(provider)) {
    throw new Error(`Unknown transcription provider "${provider}".`);
  }
  if (language !== undefined && !SUPPORTED_LANGUAGES.includes(language)) {
    throw new Error(`Unsupported transcription language "${language}".`);
  }
  for (const [lang, id] of Object.entries(local?.models ?? {})) {
    if (!SUPPORTED_LANGUAGES.includes(lang)) throw new Error(`Unsupported transcription language "${lang}".`);
    if (!LOCAL_MODELS.some((model) => model.id === id && model.language === lang)) {
      throw new Error(`Unknown local model "${id}" for language "${lang}".`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/settings-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings-store.js test/settings-store.test.js
git commit -m "feat(settings): add transcription language and local model choice, default to local"
```

### Task 6: Engine selection, cost and config

**Files:**
- Modify: `src/server.js`, `src/session-cost.js`, `src/cli.js`
- Test: `test/transcription-provider-selection.test.js`, `test/session-cost.test.js`, `test/server-startup.test.js`

**Interfaces:**
- Consumes: `resolveLocalModel`, `localModelSummaries`, `SUPPORTED_LANGUAGES` (Task 1), `createSherpaTranscription` (Task 4).
- Produces: `resolveTranscriptionEngine(transcription, platform): { kind, provider, model, label, moonshineModel?, localModel? }`; `/api/config` adds `languages` and `localModels`; `startServer` options accept `platform` and `modelsDir`.

- [ ] **Step 1: Write the failing tests**

Append to `test/transcription-provider-selection.test.js`:

```js
import { resolveTranscriptionEngine } from "../src/server.js";

test("local English resolves to Moonshine on macOS and Kroko on Linux", () => {
  const transcription = { provider: "local", language: "en", local: { models: {} } };
  assert.deepEqual(resolveTranscriptionEngine(transcription, "darwin"), {
    kind: "moonshine",
    provider: "local",
    model: "moonshine-medium",
    label: "Moonshine medium",
    moonshineModel: "medium",
    localModel: resolveTranscriptionEngine(transcription, "darwin").localModel,
  });
  assert.equal(resolveTranscriptionEngine(transcription, "linux").kind, "sherpa");
  assert.equal(resolveTranscriptionEngine(transcription, "linux").model, "kroko-en-2025-08-06");
});

test("local Russian resolves to Vosk, and a saved pick is honoured", () => {
  assert.equal(resolveTranscriptionEngine({ provider: "local", language: "ru" }, "darwin").model, "vosk-small-ru-2025-08-16");
  const picked = resolveTranscriptionEngine({ provider: "local", language: "en", local: { models: { en: "kroko-en-2025-08-06" } } }, "darwin");
  assert.equal(picked.kind, "sherpa");
  assert.equal(picked.label, "Kroko (sherpa-onnx)");
});

test("the legacy moonshine provider and the cloud providers keep their labels", () => {
  assert.deepEqual(resolveTranscriptionEngine({ provider: "moonshine", moonshine: { model: "small" } }, "linux"), {
    kind: "moonshine",
    provider: "moonshine",
    model: "small",
    label: "Moonshine small",
    moonshineModel: "small",
  });
  assert.equal(resolveTranscriptionEngine({ provider: "openai", openai: { model: "gpt-realtime-whisper" } }, "linux").label, "OpenAI gpt-realtime-whisper");
  assert.equal(resolveTranscriptionEngine({ provider: "deepgram", deepgram: { model: "nova-3" } }, "linux").label, "Deepgram nova-3");
});
```

Append to `test/session-cost.test.js`:

```js
test("computeTranscriptionCost returns priced=false for local models", () => {
  assert.deepEqual(computeTranscriptionCost({ provider: "local", model: "vosk-small-ru-2025-08-16", seconds: 60 }), {
    priced: false,
    cost: 0,
    reason: "local",
  });
});
```

Append to `test/server-startup.test.js`:

```js
test("config lists the languages and the local models for the platform", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    platform: "linux",
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
  });
  try {
    const config = await (await fetch(`${url}/api/config`)).json();
    assert.deepEqual(config.languages, ["en", "ru"]);
    assert.deepEqual(config.localModels.map((model) => model.id), ["kroko-en-2025-08-06", "vosk-small-ru-2025-08-16"]);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/transcription-provider-selection.test.js test/session-cost.test.js test/server-startup.test.js`
Expected: FAIL: `resolveTranscriptionEngine` is not exported, local cost is "unknown", config has no `languages`.

- [ ] **Step 3: Write minimal implementation**

`src/session-cost.js`, first line of `computeTranscriptionCost`:

```js
  if (provider === "local" || provider === "moonshine") return { priced: false, cost: 0, reason: "local" };
```

`src/server.js`: import `resolveLocalModel`, `localModelSummaries`, `SUPPORTED_LANGUAGES` from `./local-models.js` and `createSherpaTranscription as createDefaultSherpaTranscription` from `./sherpa-transcription.js`. Add:

```js
/**
 * The engine and model the transcription settings select on this platform.
 * "local" picks from the catalog by language; "moonshine" is the provider
 * name older settings files use, and still means the Moonshine sidecar.
 */
export function resolveTranscriptionEngine(transcription, platform = process.platform) {
  const provider = transcription?.provider ?? "local";
  if (provider === "openai") {
    const model = transcription.openai?.model;
    return { kind: "openai", provider, model, label: `OpenAI ${model}` };
  }
  if (provider === "deepgram") {
    const model = transcription.deepgram?.model ?? "";
    return { kind: "deepgram", provider, model, label: `Deepgram ${model}`.trim() };
  }
  if (provider === "moonshine") {
    const model = transcription.moonshine?.model ?? "medium";
    return { kind: "moonshine", provider, model, label: `Moonshine ${model}`, moonshineModel: model };
  }
  const language = transcription?.language ?? "en";
  const localModel = resolveLocalModel({ language, platform, preferredId: transcription?.local?.models?.[language] });
  return {
    kind: localModel.engine,
    provider: "local",
    model: localModel.id,
    label: localModel.label,
    moonshineModel: localModel.moonshineModel,
    localModel,
  };
}

const ENGINE_FACTORIES = {
  openai: () => createDefaultOpenAITranscription,
  deepgram: () => createDefaultDeepgramTranscription,
  moonshine: () => createDefaultMoonshineTranscription,
  sherpa: () => createDefaultSherpaTranscription,
};
```

Replace `transcriptionFactoryFor` with `export function transcriptionFactoryFor(kind) { return (ENGINE_FACTORIES[kind] ?? ENGINE_FACTORIES.moonshine)(); }` (keep its existing tests passing: `openai`, `deepgram`, unknown → Moonshine).

In `createTranscriptionManager`, derive the engine once per `applyCurrent()`:

```js
  function transcriptionFrom(settings) {
    if (settings) return settings.transcription;
    return {
      provider: options.transcriptionProvider ?? "moonshine",
      moonshine: { model: options.moonshineModel },
      openai: { model: options.openaiTranscriptionModel },
      deepgram: { model: options.deepgramModel },
    };
  }
```

and in `applyCurrent()`:

```js
    const settings = options.settingsStore ? await options.settingsStore.load() : null;
    const engine = resolveTranscriptionEngine(transcriptionFrom(settings), options.platform ?? process.platform);
    const newLabel = engine.label;
    activeProvider = engine.provider;
    activeModel = engine.model;
```

`pickFactory()` becomes `options.createTranscription ?? transcriptionFactoryFor(engine.kind)`, and `buildOptionsForFactory(settings, engine)` adds `moonshineModel: engine.moonshineModel ?? options.moonshineModel`, `localModel: engine.localModel`, `modelsDir: options.modelsDir`. Remove `describeLabel`.

`/api/config` adds:

```js
      languages: SUPPORTED_LANGUAGES,
      localModels: localModelSummaries(options.platform ?? process.platform),
```

`src/cli.js`: pass `modelsDir: path.join(os.homedir(), ".config", "micdraw", "models")` to `startServer`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server.js src/session-cost.js src/cli.js test/transcription-provider-selection.test.js test/session-cost.test.js test/server-startup.test.js
git commit -m "feat(transcription): route the local provider to Moonshine or sherpa-onnx by language and platform"
```

### Task 7: Language and model in the UI

**Files:**
- Modify: `public/app.js`
- Test: `test/frontend-status.test.js`

**Interfaces:**
- Consumes: `/api/config` `languages` and `localModels` (Task 6); settings shape (Task 5).

- [ ] **Step 1: Write the failing test**

```js
test("frontend lets the speaker pick a local language and model", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  assert.match(appSource, /setLocalModels\(config\.localModels \?\? \[\]\)/);
  assert.match(appSource, /\{ value: "local" \}/);
  assert.match(appSource, /const LANGUAGE_LABELS = \{ en: "English", ru: "Русский" \}/);
  assert.match(appSource, /local: \{ models: \{ \[language\]: localModelId \} \}/);
  assert.doesNotMatch(appSource, /MOONSHINE_MODELS/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/frontend-status.test.js`
Expected: FAIL on the new test.

- [ ] **Step 3: Write minimal implementation**

- Remove `MOONSHINE_MODELS`; add `const LANGUAGE_LABELS = { en: "English", ru: "Русский" };`.
- App state: `const [localModels, setLocalModels] = React.useState([]);` and `const [languages, setLanguages] = React.useState(["en"]);`; in the `/api/config` effect call `setLocalModels(config.localModels ?? []);` and `setLanguages(config.languages ?? ["en"]);`.
- `sttModelLabel(settings, engineLabel)`: return `engineLabel` for `local`; keep the other branches. Call it as `sttModelLabel(settings, transcriptionEngine)`.
- Pass `localModels` and `languages` to `TranscriptionEditor`.
- In `TranscriptionEditor`: provider state starts as `"local"` when the saved provider is `"moonshine"`; add `language` state (`settings.transcription.language ?? "en"`) and `localModelId` state (the saved pick for that language, else the first model for it). Changing the language resets `localModelId` to the saved pick or the first model for the new language. Replace the Moonshine model field with a Language field (`labeledSelect` over `languages` with `LANGUAGE_LABELS`) and a Model field (`labeledSelect` over the local models for the language, labelled `Kroko (sherpa-onnx) · 71 MB download`). Provider options: `{ value: "local" }` "Local (this computer)", OpenAI Realtime, Deepgram.
- `submit()` for local: `patch.transcription.language = language; patch.transcription.local = { models: { [language]: localModelId } };`
- Add the helper:

```js
function labeledSelect(value, onChange, options, disabled) {
  return React.createElement(
    "select",
    { value, onChange: (e) => onChange(e.target.value), disabled },
    options.map((option) => React.createElement("option", { key: option.value, value: option.value }, option.label)),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests pass, including the browser smoke test.

- [ ] **Step 5: Commit**

```bash
git add public/app.js test/frontend-status.test.js
git commit -m "feat(ui): choose the transcription language and local model"
```

### Task 8: Docs and end-to-end check

**Files:**
- Modify: `README.md`, `AGENTS.md`, `CHANGELOG.md`

- [ ] **Step 1: Docs.** README: a "Local transcription" section with the language/platform default table, the model list with sizes, licenses and sources (Kroko CC-BY-SA attribution, Vosk Apache-2.0), and the models directory; update "Defaults on first run" (local instead of Moonshine). AGENTS.md: one invariant line pointing at `src/local-models.js` and `resolveTranscriptionEngine`, and that a catalog change updates revision, sizes and SHA-256 together. CHANGELOG: an Unreleased line.

- [ ] **Step 2: End-to-end check.** Start the server with a temporary `HOME` and settings `{ transcription: { provider: "local", language: "ru" } }`, connect a WebSocket from the app's own origin, start a preso, and stream a Russian 24 kHz recording in real time as `audio` messages. Expected: a download of 28.6 MB, then `transcript:partial` messages while audio flows and at least one `transcript:committed`.

- [ ] **Step 3: Full verification.** `npm run typecheck && npm test`.

- [ ] **Step 4: Commit and open the PR.**

```bash
git add README.md AGENTS.md CHANGELOG.md
git commit -m "docs: describe local multilingual transcription"
git push -u origin local-multilingual-transcription
```

import assert from "node:assert/strict";
import { test } from "node:test";

import { LOCAL_MODELS, localModelSummaries, localModelsFor, modelFileUrl, resolveLocalModel, SUPPORTED_LANGUAGES } from "../src/local-models.js";

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
  assert.deepEqual(SUPPORTED_LANGUAGES, ["en", "ru", "de", "fr", "es", "zh"]);
});

test("German, French and Spanish use Kroko, and Mandarin a small CTC model, on every platform", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.equal(resolveLocalModel({ language: "de", platform }).id, "kroko-de-2025-08-06");
    assert.equal(resolveLocalModel({ language: "fr", platform }).id, "kroko-fr-2025-08-06");
    assert.equal(resolveLocalModel({ language: "es", platform }).id, "kroko-es-2025-08-06");
    assert.equal(resolveLocalModel({ language: "zh", platform }).id, "zipformer-ctc-small-zh-2025-04-01");
  }
  // The Chinese model is CTC: one model file instead of encoder, decoder and joiner.
  const chinese = resolveLocalModel({ language: "zh", platform: "linux" });
  assert.deepEqual(Object.keys(chinese.files), ["model", "tokens"]);
  assert.equal(
    modelFileUrl(chinese, chinese.files.model),
    "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01/resolve/a5f60fe00dcfbaf68fcc1c6b5cf53061e144d6da/model.int8.onnx",
  );
});

test("every sherpa model is pinned to a full commit with a size and SHA-256 for each file", () => {
  for (const model of LOCAL_MODELS.filter((entry) => entry.engine === "sherpa")) {
    assert.match(model.revision, /^[0-9a-f]{40}$/, model.id);
    for (const file of Object.values(model.files)) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/, `${model.id} ${file.name}`);
      assert.ok(Number.isInteger(file.size) && file.size > 0, `${model.id} ${file.name}`);
    }
  }
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

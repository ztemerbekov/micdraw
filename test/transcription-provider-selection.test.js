import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeepgramTranscription } from "../src/deepgram-transcription.js";
import { createMoonshineTranscription } from "../src/moonshine-transcription.js";
import { createOpenAITranscription } from "../src/openai-transcription.js";
import { resolveTranscriptionEngine, transcriptionFactoryFor } from "../src/server.js";
import { createSherpaTranscription } from "../src/sherpa-transcription.js";

test("transcriptionFactoryFor maps each provider name to its factory", () => {
  assert.equal(transcriptionFactoryFor("deepgram"), createDeepgramTranscription);
  assert.equal(transcriptionFactoryFor("openai"), createOpenAITranscription);
  assert.equal(transcriptionFactoryFor("moonshine"), createMoonshineTranscription);
});

test("an unset or unknown provider falls back to the engine that needs no key", () => {
  assert.equal(transcriptionFactoryFor(undefined), createMoonshineTranscription);
  assert.equal(transcriptionFactoryFor("nonesuch"), createMoonshineTranscription);
});

test("the sherpa engine kind maps to the sherpa-onnx factory", () => {
  assert.equal(transcriptionFactoryFor("sherpa"), createSherpaTranscription);
});

test("local English resolves to Moonshine on macOS and Kroko on Linux", () => {
  const transcription = { provider: "local", language: "en", local: { models: {} } };
  const mac = resolveTranscriptionEngine(transcription, "darwin");
  assert.deepEqual(mac, {
    kind: "moonshine",
    provider: "local",
    model: "moonshine-medium",
    label: "Moonshine medium",
    moonshineModel: "medium",
    localModel: mac.localModel,
  });
  assert.equal(mac.localModel.id, "moonshine-medium");
  const linux = resolveTranscriptionEngine(transcription, "linux");
  assert.equal(linux.kind, "sherpa");
  assert.equal(linux.model, "kroko-en-2025-08-06");
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

test("cloud engines carry the chosen language", () => {
  assert.equal(resolveTranscriptionEngine({ provider: "openai", language: "uk", openai: { model: "gpt-live-transcribe" } }, "linux").language, "uk");
  assert.equal(resolveTranscriptionEngine({ provider: "deepgram", language: "multi", deepgram: { model: "nova-3" } }, "linux").language, "multi");
});

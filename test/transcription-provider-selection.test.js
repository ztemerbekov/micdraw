import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeepgramTranscription } from "../src/deepgram-transcription.js";
import { createMoonshineTranscription } from "../src/moonshine-transcription.js";
import { createOpenAITranscription } from "../src/openai-transcription.js";
import { transcriptionFactoryFor } from "../src/server.js";

test("transcriptionFactoryFor maps each provider name to its factory", () => {
  assert.equal(transcriptionFactoryFor("deepgram"), createDeepgramTranscription);
  assert.equal(transcriptionFactoryFor("openai"), createOpenAITranscription);
  assert.equal(transcriptionFactoryFor("moonshine"), createMoonshineTranscription);
});

test("an unset or unknown provider falls back to the engine that needs no key", () => {
  assert.equal(transcriptionFactoryFor(undefined), createMoonshineTranscription);
  assert.equal(transcriptionFactoryFor("nonesuch"), createMoonshineTranscription);
});

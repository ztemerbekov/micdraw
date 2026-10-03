import assert from "node:assert/strict";
import { test } from "node:test";

import { CLOUD_LANGUAGES, transcriptionLanguages } from "../src/languages.js";
import { SUPPORTED_LANGUAGES } from "../src/local-models.js";

test("cloud transcription offers the approved languages", () => {
  assert.deepEqual(CLOUD_LANGUAGES, ["en", "ru", "de", "fr", "es", "zh", "pt", "it", "ja", "ko", "hi", "uk", "pl", "tr", "nl", "ar"]);
  assert.deepEqual(transcriptionLanguages("openai"), CLOUD_LANGUAGES);
});

test("Deepgram also offers mixed-language speech", () => {
  assert.deepEqual(transcriptionLanguages("deepgram"), [...CLOUD_LANGUAGES, "multi"]);
});

test("local transcription offers the languages that have a local model", () => {
  assert.deepEqual(transcriptionLanguages("local"), SUPPORTED_LANGUAGES);
  assert.deepEqual(transcriptionLanguages("moonshine"), SUPPORTED_LANGUAGES);
});

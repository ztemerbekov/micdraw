import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const rootDir = path.join(import.meta.dirname, "..");

test("frontend clears stale agent thinking status when the socket is closed", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /ws\.addEventListener\("close",[\s\S]*setAgentStatus\("idle"\)/);
  assert.match(appSource, /async function stopListening\(\)[\s\S]*setAgentStatus\("idle"\)/);
});

test("frontend exports and sends whiteboard screenshots over the websocket", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /import\s*\{[^}]*\bExcalidraw\b[^}]*\bconvertToExcalidrawElements\b/s);
  assert.match(appSource, /type: "whiteboard:screenshot"/);
  // Live screenshot loop still uses the cheap static-canvas path, not
  // exportToBlob with hardcoded 1280x720 dims (the previous regression).
  assert.match(appSource, /canvas\.excalidraw__canvas\.static/);
  assert.match(appSource, /blobToDataUrl/);
  assert.doesNotMatch(appSource, /getDimensions: \(\) => \(\{ width: 1280, height: 720/);
  assert.doesNotMatch(appSource, /fitToContent/);
});

test("frontend downsizes screenshot images before sending them", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /async function downscaleBlobByHalf\(blob\)/);
  assert.match(appSource, /Math\.floor\(bitmap\.width \/ 2\)/);
  assert.match(appSource, /Math\.floor\(bitmap\.height \/ 2\)/);
  assert.match(appSource, /const downscaled = await downscaleBlobByHalf\(blob\);[\s\S]*return await blobToDataUrl\(downscaled\);/);
  assert.match(appSource, /captureStagingSceneAsImage[\s\S]*const downscaled = await downscaleBlobByHalf\(blob\);/);
});

test("frontend skips staging screenshot image when staging is empty", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /if \(!Array\.isArray\(elements\) \|\| elements\.length === 0\) \{[\s\S]*return null;[\s\S]*\}/);
  assert.doesNotMatch(appSource, /PLACEHOLDER_IMAGE/);
});

test("frontend pushes user-drawn live elements to the server", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /type: "whiteboard:user-elements"/);
  assert.match(appSource, /handleExcalidrawChange/);
});

test("frontend flushes pending agent instructions before starting preso", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /async function flushAgentInstructionsSave\(\)/);
  assert.match(appSource, /async function startPreso\(\)[\s\S]*await flushAgentInstructionsSave\(\)[\s\S]*fetch\("\/api\/preso\/start"/);
});

test("frontend handles viewport commands from the agent", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /message\.type === "whiteboard:viewport"/);
  assert.match(appSource, /applyWhiteboardViewportCommand/);
  assert.match(appSource, /action === "scroll_to_content"/);
  assert.match(appSource, /action === "set_zoom"/);
});

test("frontend exposes OpenAI agent base URL and labels the key as API key", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /const \[openaiBaseURL, setOpenaiBaseURL\] = React\.useState\([\s\S]*settings\.agent\.openai\.baseURL/);
  assert.match(appSource, /patch\.agent\.openai\.baseURL = openaiBaseURL/);
  assert.match(appSource, /provider === "openai"[\s\S]*field\([\s\S]*"Base URL"/);
  assert.match(appSource, /field\([\s\S]*"API key"[\s\S]*placeholder: "configured \(enter to replace\)"/);
  assert.doesNotMatch(appSource, /"OpenAI key"/);
});

test("frontend lets the speaker pick a local language and model", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  assert.match(appSource, /setLocalModels\(config\.localModels \?\? \[\]\)/);
  assert.match(appSource, /\{ value: "local" \}/);
  assert.match(appSource, /const LANGUAGE_LABELS = \{\s*en: "English",\s*ru: "Русский",/);
  assert.match(appSource, /patch\.transcription\.local = \{ models: \{ \[language\]: localModelId \} \}/);
  assert.doesNotMatch(appSource, /MOONSHINE_MODELS/);
});

test("frontend shows voice model loading progress in the Voice row", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  assert.match(appSource, /message\.type === "transcription:status"/);
  assert.match(appSource, /setTranscriptionStatus\(config\.transcriptionStatus \?\? null\)/);
  assert.match(appSource, /function voiceRowLabel\(base, status\)/);
});

test("frontend offers GPT-6 agent models and no model Codex has retired", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  const codexModels = appSource.match(/const CODEX_AGENT_MODELS = (\[[^\]]*\])/)?.[1];
  const openaiModels = appSource.match(/const OPENAI_AGENT_MODELS = (\[[^\]]*\])/)?.[1];

  // Real model names only; Fast mode is its own switch.
  assert.deepEqual(JSON.parse(codexModels ?? "[]"), ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]);
  assert.deepEqual(JSON.parse(openaiModels ?? "[]"), ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-5.5"]);
  assert.match(appSource, /type: "checkbox",\s*checked: codexFast,/);
  assert.match(appSource, /patch\.agent\.codex\.fast = codexFast;/);
  // A saved model missing from a menu still shows as selected.
  assert.match(appSource, /function select\(value, onChange, options, disabled\) \{[\s\S]*options\.includes\(value\)/);
});

test("frontend offers only OpenAI models that realtime transcription serves, and a current Ollama example", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  const models = appSource.match(/const OPENAI_TRANSCRIPTION_MODELS = (\[[^\]]*\])/)?.[1] ?? "[]";
  assert.deepEqual(JSON.parse(models.replace(/,\s*\]/, "]")), ["gpt-live-transcribe", "gpt-realtime-whisper"]);
  assert.match(appSource, /placeholder: "e\.g\. qwen3\.6"/);
});

test("frontend lets the speaker pick a language for every transcription provider", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  // The language field is no longer local-only, and lists what the provider offers.
  assert.match(appSource, /field\(\s*"Language",\s*labeledSelect\(\s*language,\s*chooseLanguage,\s*providerLanguages\.map/);
  assert.match(appSource, /const providerLanguages = languages\[provider === "moonshine" \? "local" : provider\] \?\? \["en"\];/);
  for (const label of ["Українська", "Polski", "Türkçe", "Nederlands", "العربية", "日本語", "한국어", "हिन्दी", "Português", "Italiano", "Mixed languages"]) {
    assert.ok(appSource.includes(label), `missing language label ${label}`);
  }
});

test("frontend pushes the live board only after the user touched the canvas", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  // A pointer press on the canvas marks a user edit...
  assert.match(appSource, /onPointerDown: \(\) => \{\s*userTouchedCanvasRef\.current = true;\s*\}/);
  // ...and only then does a canvas change go to the server, so the page never
  // echoes the agent's own board back in Excalidraw's expanded form (#41).
  const handler = appSource.match(/function handleExcalidrawChange\(elements\) \{[\s\S]*?\n  \}\n/)?.[0] ?? "";
  assert.match(handler, /if \(!userTouchedCanvasRef\.current\) return;/);
  // The mark is spent by the push it allowed, and cleared when the page draws the agent's board.
  assert.match(handler, /userTouchedCanvasRef\.current = false;\s*ws\.send\(/);
  assert.match(appSource, /function applyScene\(elements, \{ recenter = false \} = \{\}\) \{[\s\S]*?userTouchedCanvasRef\.current = false;/);
});

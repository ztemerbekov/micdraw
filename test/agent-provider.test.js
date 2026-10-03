import assert from "node:assert/strict";
import { test } from "node:test";

import { createWhiteboardAgentModel } from "../src/agent-provider.js";

test("createWhiteboardAgentModel creates an Ollama chat model", () => {
  const model = createWhiteboardAgentModel({
    provider: "ollama",
    model: "llama3.2",
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
  });

  assert.equal(model.provider, "ollama.chat");
  assert.equal(model.modelId, "llama3.2");
});

test("createWhiteboardAgentModel creates a Codex responses model", () => {
  const model = createWhiteboardAgentModel({
    provider: "codex",
    model: "gpt-5.5",
    baseURL: "https://chatgpt.com/backend-api/codex",
    apiKey: "codex-token",
    reasoningEffort: "low",
  });

  assert.equal(model.provider, "openai-codex.responses");
  assert.equal(model.modelId, "gpt-5.5");
});

test("createWhiteboardAgentModel uses the configured OpenAI base URL", () => {
  const model = createWhiteboardAgentModel({
    provider: "openai",
    model: "gpt-5.5",
    baseURL: "https://gateway.example.test/v1",
    apiKey: "sk-test",
    reasoningEffort: "low",
  });

  assert.equal(model.provider, "openai.responses");
  assert.equal(model.modelId, "gpt-5.5");
  const config = Reflect.get(model, "config");
  assert.equal(
    config.url({ path: "/responses" }).toString(),
    "https://gateway.example.test/v1/responses",
  );
});

test("createWhiteboardAgentModel creates an xAI chat model", () => {
  const model = createWhiteboardAgentModel({
    provider: "xai",
    model: "grok-4.3",
    baseURL: "https://api.x.ai/v1",
    apiKey: "xai-key",
  });

  // Chat Completions: the API upstream autopreso#24 ran its live tool-calling check against.
  assert.equal(model.provider, "xai.chat");
  assert.equal(model.modelId, "grok-4.3");
});

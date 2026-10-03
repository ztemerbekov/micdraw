import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createReasoningEffortLookup,
  lowestOllamaEffort,
  lowestOpenRouterEffort,
  lowestXaiEffort,
} from "../src/reasoning-effort.js";

// Shapes from xAI's GET /v1/language-models, OpenRouter's GET /api/v1/models
// and Ollama's POST /api/show, as documented on 2026-10-03.
const XAI_MODELS = {
  models: [
    { id: "grok-4.3", aliases: ["grok-4.3-latest"], capabilities: { reasoning_effort: ["none", "low", "medium", "high", "xhigh"], default_reasoning_effort: "low" } },
    { id: "grok-4.7", aliases: [], capabilities: { reasoning_effort: ["low", "medium", "high", "xhigh"], default_reasoning_effort: "high" } },
    { id: "grok-build-0.1", aliases: [] },
  ],
};

const OPENROUTER_MODELS = {
  data: [
    { id: "x-ai/grok-4.20", reasoning: { mandatory: false, default_enabled: false } },
    { id: "x-ai/grok-4.3", reasoning: { mandatory: false, default_enabled: true, supported_efforts: ["high", "medium", "low", "none"], default_effort: "low" } },
    { id: "x-ai/grok-4.5", reasoning: { mandatory: true, default_enabled: true, supported_efforts: ["high", "medium", "low"], default_effort: "high" } },
    { id: "some/model-without-reasoning" },
  ],
};

test("lowestXaiEffort picks the lowest effort the model lists", () => {
  assert.equal(lowestXaiEffort(XAI_MODELS, "grok-4.3"), "none");
  assert.equal(lowestXaiEffort(XAI_MODELS, "grok-4.7"), "low");
});

test("lowestXaiEffort finds a model by its alias", () => {
  assert.equal(lowestXaiEffort(XAI_MODELS, "grok-4.3-latest"), "none");
});

test("lowestXaiEffort sends nothing to models without reasoning efforts or missing from the list", () => {
  assert.equal(lowestXaiEffort(XAI_MODELS, "grok-build-0.1"), undefined);
  assert.equal(lowestXaiEffort(XAI_MODELS, "grok-typo"), undefined);
});

test("lowestOpenRouterEffort picks the lowest supported effort", () => {
  assert.equal(lowestOpenRouterEffort(OPENROUTER_MODELS, "x-ai/grok-4.3"), "none");
  assert.equal(lowestOpenRouterEffort(OPENROUTER_MODELS, "x-ai/grok-4.5"), "low");
});

test("lowestOpenRouterEffort leaves reasoning that is off by default alone", () => {
  // Sending an effort would turn reasoning on.
  assert.equal(lowestOpenRouterEffort(OPENROUTER_MODELS, "x-ai/grok-4.20"), undefined);
});

test("lowestOpenRouterEffort sends nothing to models without reasoning data or missing from the list", () => {
  assert.equal(lowestOpenRouterEffort(OPENROUTER_MODELS, "some/model-without-reasoning"), undefined);
  assert.equal(lowestOpenRouterEffort(OPENROUTER_MODELS, "x-ai/grok-typo"), undefined);
});

test("lowestOllamaEffort turns off thinking on an on/off model", () => {
  assert.equal(lowestOllamaEffort({ thinking: { values: [true, false], default: true } }), "none");
});

test("lowestOllamaEffort picks the lowest named level", () => {
  assert.equal(lowestOllamaEffort({ thinking: { values: ["low", "medium", "high"], default: "medium" } }), "low");
});

test("lowestOllamaEffort sends nothing when thinking is already off, cannot be turned off, or is unknown", () => {
  assert.equal(lowestOllamaEffort({ thinking: { values: [true, false], default: false } }), undefined);
  assert.equal(lowestOllamaEffort({ thinking: { values: [false], default: false } }), undefined);
  assert.equal(lowestOllamaEffort({ thinking: { values: [true], default: true } }), undefined);
  assert.equal(lowestOllamaEffort({ capabilities: ["completion", "tools"] }), undefined);
});

function fakeFetch(responses) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const response = responses[String(url)];
    if (response instanceof Error) throw response;
    if (!response) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => response };
  };
  return { fetchFn, calls };
}

const quietLog = { log: () => {}, warn: () => {} };

test("the lookup asks xAI for its model list with the API key", async () => {
  const { fetchFn, calls } = fakeFetch({ "https://api.x.ai/v1/language-models": XAI_MODELS });
  const lookup = createReasoningEffortLookup({ fetchFn, log: quietLog });

  const effort = await lookup({ provider: "xai", model: "grok-4.3", baseURL: "https://api.x.ai/v1", apiKey: "xai-key" });

  assert.equal(effort, "none");
  assert.equal(calls[0].init.headers.Authorization, "Bearer xai-key");
});

test("the lookup falls back to xAI's documented models when the list cannot be fetched", async () => {
  const { fetchFn } = fakeFetch({ "https://api.x.ai/v1/language-models": new Error("offline") });
  const lookup = createReasoningEffortLookup({ fetchFn, log: quietLog });
  const xai = { provider: "xai", baseURL: "https://api.x.ai/v1", apiKey: "xai-key" };

  assert.equal(await lookup({ ...xai, model: "grok-4.3" }), "none");
  assert.equal(await lookup({ ...xai, model: "grok-4.5" }), "low");
  assert.equal(await lookup({ ...xai, model: "grok-unknown" }), undefined);
});

test("the lookup reads OpenRouter's model list", async () => {
  const { fetchFn } = fakeFetch({ "https://openrouter.ai/api/v1/models": OPENROUTER_MODELS });
  const lookup = createReasoningEffortLookup({ fetchFn, log: quietLog });

  const effort = await lookup({ provider: "openrouter", model: "x-ai/grok-4.5", baseURL: "https://openrouter.ai/api/v1", apiKey: "or-key" });

  assert.equal(effort, "low");
});

test("the lookup asks Ollama about the model at the server root", async () => {
  const { fetchFn, calls } = fakeFetch({ "http://localhost:11434/api/show": { thinking: { values: [true, false], default: true } } });
  const lookup = createReasoningEffortLookup({ fetchFn, log: quietLog });

  const effort = await lookup({ provider: "ollama", model: "qwen3.6", baseURL: "http://localhost:11434/v1", apiKey: "ollama" });

  assert.equal(effort, "none");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: "qwen3.6" });
});

test("the lookup sends nothing when OpenRouter or Ollama cannot be asked", async () => {
  const { fetchFn } = fakeFetch({});
  const lookup = createReasoningEffortLookup({ fetchFn, log: quietLog });

  assert.equal(await lookup({ provider: "openrouter", model: "x-ai/grok-4.3", baseURL: "https://openrouter.ai/api/v1" }), undefined);
  assert.equal(await lookup({ provider: "ollama", model: "qwen3.6", baseURL: "http://localhost:11434/v1" }), undefined);
});

test("the lookup asks once per model", async () => {
  const { fetchFn, calls } = fakeFetch({ "https://api.x.ai/v1/language-models": XAI_MODELS });
  const lookup = createReasoningEffortLookup({ fetchFn, log: quietLog });
  const xai = { provider: "xai", baseURL: "https://api.x.ai/v1", apiKey: "xai-key" };

  await lookup({ ...xai, model: "grok-4.3" });
  await lookup({ ...xai, model: "grok-4.3" });
  assert.equal(calls.length, 1);

  await lookup({ ...xai, model: "grok-4.7" });
  assert.equal(calls.length, 2);
});

test("the lookup asks again after a failure", async () => {
  // Ollama started after Mic Draw, or an xAI key fixed after a 401.
  /** @type {Record<string, any>} */
  const responses = { "http://localhost:11434/api/show": new Error("connection refused") };
  const { fetchFn, calls } = fakeFetch(responses);
  const lookup = createReasoningEffortLookup({ fetchFn, log: quietLog });
  const ollama = { provider: "ollama", model: "qwen3.6", baseURL: "http://localhost:11434/v1" };

  assert.equal(await lookup(ollama), undefined);
  responses["http://localhost:11434/api/show"] = { thinking: { values: [true, false], default: true } };
  assert.equal(await lookup(ollama), "none");
  assert.equal(calls.length, 2);
});

test("the lookup leaves OpenAI and Codex alone", async () => {
  const { fetchFn, calls } = fakeFetch({});
  const lookup = createReasoningEffortLookup({ fetchFn, log: quietLog });

  assert.equal(await lookup({ provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "low" }), undefined);
  assert.equal(await lookup({ provider: "codex", model: "gpt-6.1-sol", reasoningEffort: "low" }), undefined);
  assert.equal(calls.length, 0);
});

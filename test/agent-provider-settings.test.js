import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveAgentProviderFromSettings } from "../src/agent-provider.js";
import { codexHomeWith, tempDir } from "./helpers/tmp.js";

function settingsBase() {
  return {
    agent: {
      provider: "openai",
      openai: { model: "gpt-6.1-sol", reasoningEffort: "low", baseURL: "https://api.openai.com/v1" },
      codex: { model: "gpt-6.1-sol", fast: true, baseURL: "https://chatgpt.com/backend-api/codex" },
      ollama: { model: "", baseURL: "http://localhost:11434/v1" },
    },
    apiKeys: { openai: "" },
  };
}

test("resolveAgentProviderFromSettings returns OpenAI provider from settings + key", () => {
  const settings = settingsBase();
  settings.apiKeys.openai = "sk-from-settings";
  settings.agent.openai.model = "gpt-5-pro";
  settings.agent.openai.reasoningEffort = "high";
  settings.agent.openai.baseURL = "https://gateway.example.test/v1/";

  assert.deepEqual(resolveAgentProviderFromSettings({ settings, env: {} }), {
    provider: "openai",
    model: "gpt-5-pro",
    apiKey: "sk-from-settings",
    reasoningEffort: "high",
    baseURL: "https://gateway.example.test/v1",
  });
});

test("the agent takes reasoning effort max and refuses none, which GPT-6.1 Sol rejects", () => {
  const settings = settingsBase();
  settings.apiKeys.openai = "sk-from-settings";
  settings.agent.openai.reasoningEffort = "max";
  assert.deepEqual(resolveAgentProviderFromSettings({ settings, env: {} }), {
    provider: "openai",
    model: "gpt-6.1-sol",
    apiKey: "sk-from-settings",
    reasoningEffort: "max",
    baseURL: "https://api.openai.com/v1",
  });
  settings.agent.openai.reasoningEffort = "none";
  assert.throws(() => resolveAgentProviderFromSettings({ settings, env: {} }), /Use low, medium, high, xhigh, or max\./);
});

test("resolveAgentProviderFromSettings trims OpenAI base URL before defaulting", () => {
  const settings = settingsBase();
  settings.apiKeys.openai = "sk-from-settings";
  settings.agent.openai.baseURL = "  https://gateway.example.test/v1/  ";

  assert.equal(
    resolveAgentProviderFromSettings({ settings, env: {} }).baseURL,
    "https://gateway.example.test/v1",
  );

  settings.agent.openai.baseURL = "   ";

  assert.equal(
    resolveAgentProviderFromSettings({ settings, env: {} }).baseURL,
    "https://api.openai.com/v1",
  );
});

test("resolveAgentProviderFromSettings falls back to env OPENAI_API_KEY when settings has none", () => {
  const settings = settingsBase();

  assert.equal(
    resolveAgentProviderFromSettings({ settings, env: { OPENAI_API_KEY: "sk-env" } }).apiKey,
    "sk-env",
  );
});

test("resolveAgentProviderFromSettings throws when OpenAI provider has no key from any source", () => {
  const settings = settingsBase();

  assert.throws(
    () => resolveAgentProviderFromSettings({ settings, env: {} }),
    /OpenAI API key/,
  );
});

test("resolveAgentProviderFromSettings returns Ollama provider from settings", () => {
  const settings = settingsBase();
  settings.agent.provider = "ollama";
  settings.agent.ollama.model = "llama3";
  settings.agent.ollama.baseURL = "http://example.test:11434/v1/";

  assert.deepEqual(resolveAgentProviderFromSettings({ settings, env: {} }), {
    provider: "ollama",
    model: "llama3",
    baseURL: "http://example.test:11434/v1",
    apiKey: "ollama",
  });
});

test("resolveAgentProviderFromSettings throws when Ollama model is missing", () => {
  const settings = settingsBase();
  settings.agent.provider = "ollama";

  assert.throws(
    () => resolveAgentProviderFromSettings({ settings, env: {} }),
    /Ollama model/,
  );
});

test("resolveAgentProviderFromSettings returns Codex provider using filesystem auth", (t) => {
  const codexHome = codexHomeWith(t);

  const settings = settingsBase();
  settings.agent.provider = "codex";
  settings.agent.codex.model = "gpt-6.1-sol";

  assert.deepEqual(resolveAgentProviderFromSettings({ settings, env: { CODEX_HOME: codexHome } }), {
    provider: "codex",
    model: "gpt-6.1-sol",
    baseURL: "https://chatgpt.com/backend-api/codex",
    apiKey: "codex-token",
    reasoningEffort: "low",
    serviceTier: "priority",
  });
});

test("resolveAgentProviderFromSettings defaults Codex provider to fast mode", (t) => {
  const codexHome = codexHomeWith(t);

  const settings = settingsBase();
  settings.agent.provider = "codex";
  settings.agent.codex.model = "";
  delete settings.agent.codex.fast;

  assert.deepEqual(resolveAgentProviderFromSettings({ settings, env: { CODEX_HOME: codexHome } }), {
    provider: "codex",
    model: "gpt-6.1-sol",
    baseURL: "https://chatgpt.com/backend-api/codex",
    apiKey: "codex-token",
    reasoningEffort: "low",
    serviceTier: "priority",
  });
});

test("resolveAgentProviderFromSettings sends Codex without Fast mode when it is off", (t) => {
  const codexHome = codexHomeWith(t);
  const settings = settingsBase();
  settings.agent.provider = "codex";
  settings.agent.codex.fast = false;

  const resolved = /** @type {any} */ (resolveAgentProviderFromSettings({ settings, env: { CODEX_HOME: codexHome } }));
  assert.equal(resolved.model, "gpt-6.1-sol");
  assert.equal(resolved.serviceTier, undefined);
});

test("resolveAgentProviderFromSettings still reads an old name ending in -fast", (t) => {
  const codexHome = codexHomeWith(t);
  const settings = settingsBase();
  settings.agent.provider = "codex";
  settings.agent.codex = /** @type {any} */ ({ model: "gpt-6.1-sol-fast", baseURL: "https://chatgpt.com/backend-api/codex" });

  const resolved = /** @type {any} */ (resolveAgentProviderFromSettings({ settings, env: { CODEX_HOME: codexHome } }));
  assert.equal(resolved.model, "gpt-6.1-sol");
  assert.equal(resolved.serviceTier, "priority");
});

test("resolveAgentProviderFromSettings throws when Codex auth is unavailable", (t) => {
  const codexHome = tempDir(t, "micdraw-codex-empty-");
  const settings = settingsBase();
  settings.agent.provider = "codex";

  assert.throws(
    () => resolveAgentProviderFromSettings({ settings, env: { CODEX_HOME: codexHome } }),
    /Codex CLI auth/,
  );
});

test("resolveAgentProviderFromSettings returns an OpenRouter provider with its own key", () => {
  const settings = settingsBase();
  settings.agent.provider = "openrouter";
  settings.agent.openrouter = { model: "x-ai/grok-4.20", baseURL: "https://openrouter.ai/api/v1/" };
  settings.apiKeys.openrouter = "sk-or-from-settings";
  // An OpenAI key lying around must not be spent on OpenRouter.
  settings.apiKeys.openai = "sk-openai";

  assert.deepEqual(resolveAgentProviderFromSettings({ settings, env: {} }), {
    provider: "openrouter",
    model: "x-ai/grok-4.20",
    apiKey: "sk-or-from-settings",
    baseURL: "https://openrouter.ai/api/v1",
  });
});

test("the OpenRouter provider carries no reasoningEffort", () => {
  const settings = settingsBase();
  settings.agent.provider = "openrouter";
  settings.agent.openrouter = { model: "x-ai/grok-4.20", baseURL: "https://openrouter.ai/api/v1" };
  settings.agent.openai.reasoningEffort = "xhigh";
  settings.apiKeys.openrouter = "sk-or";

  const resolved = resolveAgentProviderFromSettings({ settings, env: {} });
  // reasoningEffort is an OpenAI-only provider option; forwarding it to an
  // arbitrary OpenRouter model is at best ignored and at worst a 400.
  assert.equal("reasoningEffort" in resolved, false);
});

test("resolveAgentProviderFromSettings falls back to OPENROUTER_API_KEY from env", () => {
  const settings = settingsBase();
  settings.agent.provider = "openrouter";
  settings.agent.openrouter = { model: "", baseURL: "" };

  const resolved = resolveAgentProviderFromSettings({
    settings,
    env: { OPENROUTER_API_KEY: "sk-or-env" },
  });
  assert.equal(resolved.apiKey, "sk-or-env");
  assert.equal(resolved.model, "x-ai/grok-4.20", "an empty model falls back to the default");
  assert.equal(resolved.baseURL, "https://openrouter.ai/api/v1");
});

test("resolveAgentProviderFromSettings refuses OpenRouter without a key", () => {
  const settings = settingsBase();
  settings.agent.provider = "openrouter";
  settings.agent.openrouter = { model: "x-ai/grok-4.20", baseURL: "https://openrouter.ai/api/v1" };

  assert.throws(
    () => resolveAgentProviderFromSettings({ settings, env: {} }),
    /OpenRouter API key is not configured/,
  );
});

test("resolveAgentProviderFromSettings returns an xAI provider with the xAI key and no reasoningEffort", () => {
  const settings = settingsBase();
  settings.agent.provider = "xai";
  settings.agent.xai = { model: "grok-4.3", baseURL: "https://api.x.ai/v1/" };
  /** @type {any} */ (settings.apiKeys).xai = "xai-from-settings";
  // An OpenAI key lying around must not be spent on xAI.
  settings.apiKeys.openai = "sk-openai";
  settings.agent.openai.reasoningEffort = "xhigh";

  assert.deepEqual(resolveAgentProviderFromSettings({ settings, env: {} }), {
    provider: "xai",
    model: "grok-4.3",
    apiKey: "xai-from-settings",
    baseURL: "https://api.x.ai/v1",
  });
});

test("the xAI provider falls back to XAI_API_KEY and the default model, and needs a key", () => {
  const settings = settingsBase();
  settings.agent.provider = "xai";
  settings.agent.xai = { model: "", baseURL: "" };

  const resolved = resolveAgentProviderFromSettings({ settings, env: { XAI_API_KEY: "xai-env" } });
  assert.equal(resolved.apiKey, "xai-env");
  assert.equal(resolved.model, "grok-4.3");
  assert.equal(resolved.baseURL, "https://api.x.ai/v1");
  assert.throws(() => resolveAgentProviderFromSettings({ settings, env: {} }), /xAI API key is not configured/);
});

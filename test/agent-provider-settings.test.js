import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveAgentProviderFromSettings } from "../src/agent-provider.js";

function settingsBase() {
  return {
    agent: {
      provider: "openai",
      openai: { model: "gpt-5.5", reasoningEffort: "low", baseURL: "https://api.openai.com/v1" },
      codex: { model: "gpt-5.5-fast", baseURL: "https://chatgpt.com/backend-api/codex" },
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

test("resolveAgentProviderFromSettings returns Codex provider using filesystem auth", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "micdraw-codex-"));
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "codex-token", refresh_token: "refresh" } }));

  const settings = settingsBase();
  settings.agent.provider = "codex";
  settings.agent.codex.model = "gpt-5.5-fast";

  assert.deepEqual(resolveAgentProviderFromSettings({ settings, env: { CODEX_HOME: codexHome } }), {
    provider: "codex",
    model: "gpt-5.5",
    requestedModel: "gpt-5.5-fast",
    baseURL: "https://chatgpt.com/backend-api/codex",
    apiKey: "codex-token",
    reasoningEffort: "low",
    serviceTier: "priority",
  });
});

test("resolveAgentProviderFromSettings defaults Codex provider to fast mode", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "micdraw-codex-default-"));
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "codex-token", refresh_token: "refresh" } }));

  const settings = settingsBase();
  settings.agent.provider = "codex";
  settings.agent.codex.model = "";

  assert.deepEqual(resolveAgentProviderFromSettings({ settings, env: { CODEX_HOME: codexHome } }), {
    provider: "codex",
    model: "gpt-5.5",
    requestedModel: "gpt-5.5-fast",
    baseURL: "https://chatgpt.com/backend-api/codex",
    apiKey: "codex-token",
    reasoningEffort: "low",
    serviceTier: "priority",
  });
});

test("resolveAgentProviderFromSettings throws when Codex auth is unavailable", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "micdraw-codex-empty-"));
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

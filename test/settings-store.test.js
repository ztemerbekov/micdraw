import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createSettingsStore, DEFAULT_SETTINGS, MAX_AGENT_INSTRUCTIONS_CHARS } from "../src/settings-store.js";

async function tempPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "micdraw-settings-"));
  return path.join(dir, "settings.json");
}

const noCodexAuth = () => null;

test("createSettingsStore returns defaults when file is missing and env is empty", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.equal(settings.agent.codex.model, "gpt-6.1-sol");
  assert.equal(settings.agent.codex.fast, true);
  assert.equal(settings.agent.openai.model, "gpt-6.1-sol");
});

test("createSettingsStore seeds settings from environment on first run", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: {
      OPENAI_API_KEY: "sk-env",
      OPENAI_MODEL: "gpt-5-pro",
      OPENAI_BASE_URL: "https://gateway.example.test/v1",
      OPENAI_REASONING_EFFORT: "high",
      OLLAMA_MODEL: "llama3",
      OLLAMA_BASE_URL: "http://localhost:1234/v1",
    },
    readCodexAuth: noCodexAuth,
  });
  const settings = await store.load();
  assert.equal(settings.apiKeys.openai, "sk-env");
  assert.equal(settings.agent.openai.model, "gpt-5-pro");
  assert.equal(settings.agent.openai.baseURL, "https://gateway.example.test/v1");
  assert.equal(settings.agent.openai.reasoningEffort, "high");
  assert.equal(settings.agent.ollama.model, "llama3");
  assert.equal(settings.agent.ollama.baseURL, "http://localhost:1234/v1");
});

test("createSettingsStore picks ollama agent when OLLAMA_MODEL is set without other auth", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: { OLLAMA_MODEL: "llama3" },
    readCodexAuth: noCodexAuth,
  });
  const settings = await store.load();
  assert.equal(settings.agent.provider, "ollama");
});

test("createSettingsStore picks openai agent and transcription when key is in env", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: { OPENAI_API_KEY: "sk-env" },
    readCodexAuth: noCodexAuth,
  });
  const settings = await store.load();
  assert.equal(settings.agent.provider, "openai");
  assert.equal(settings.transcription.provider, "openai");
});

test("createSettingsStore prefers Codex agent whenever Codex CLI auth is available", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: { OPENAI_API_KEY: "sk-env", OLLAMA_MODEL: "llama3" },
    readCodexAuth: () => ({ tokens: {}, accessToken: "codex-token", refreshToken: null, accountId: null }),
  });
  const settings = await store.load();
  assert.equal(settings.agent.provider, "codex");
  assert.equal(settings.transcription.provider, "openai");
});

test("createSettingsStore tolerates Codex auth read errors and falls back to other providers", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: { OPENAI_API_KEY: "sk-env" },
    readCodexAuth: () => { throw new Error("boom"); },
  });
  const settings = await store.load();
  assert.equal(settings.agent.provider, "openai");
});

test("createSettingsStore falls back to local transcription without OPENAI_API_KEY", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  assert.equal(settings.transcription.provider, "local");
});

test("createSettingsStore.save deep-merges and persists to disk", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ transcription: { provider: "openai", openai: { model: "gpt-realtime-whisper" } } });

  const reloaded = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const settings = await reloaded.load();
  assert.equal(settings.transcription.provider, "openai");
  assert.equal(settings.transcription.openai.model, "gpt-realtime-whisper");
  assert.equal(settings.transcription.moonshine.model, DEFAULT_SETTINGS.transcription.moonshine.model);
});

test("createSettingsStore.save rejects oversized agent instructions", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  await store.load();

  await assert.rejects(
    store.save({ agentInstructions: "x".repeat(MAX_AGENT_INSTRUCTIONS_CHARS + 1) }),
    /Agent instructions must be 100000 characters or fewer\./,
  );
});

test("createSettingsStore.save writes the file with 0600 permissions", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ apiKeys: { openai: "sk-secret" } });

  const stat = await fs.stat(filePath);
  assert.equal(stat.mode & 0o777, 0o600);
});

test("createSettingsStore.getSanitized strips api keys and reports hasOpenAIKey", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: { OPENAI_API_KEY: "sk-env" },
    readCodexAuth: noCodexAuth,
  });
  await store.load();
  const sanitized = await store.getSanitized();
  assert.equal(sanitized.apiKeys, undefined);
  assert.equal(sanitized.hasOpenAIKey, true);
  assert.equal(sanitized.agent.provider, "openai");
});

test("createSettingsStore.getSanitized reports false when no openai key is set", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  const sanitized = await store.getSanitized();
  assert.equal(sanitized.hasOpenAIKey, false);
});

test("createSettingsStore preserves previously-saved values across reloads, ignoring env defaults", async () => {
  const filePath = await tempPath();
  const first = createSettingsStore({
    filePath,
    env: { OPENAI_API_KEY: "sk-original" },
    readCodexAuth: noCodexAuth,
  });
  await first.load();
  await first.save({ agent: { openai: { model: "gpt-5-mini" } } });

  const second = createSettingsStore({
    filePath,
    env: { OPENAI_API_KEY: "sk-different", OPENAI_MODEL: "gpt-different" },
    readCodexAuth: noCodexAuth,
  });
  const settings = await second.load();
  assert.equal(settings.agent.openai.model, "gpt-5-mini");
  assert.equal(settings.apiKeys.openai, "sk-original");
});

test("createSettingsStore.save ignores keys that would change an object's prototype", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.save(JSON.parse('{"__proto__":{"injected":true},"agent":{"constructor":{"prototype":{"injected":true}}}}'));

  const settings = await store.load();
  assert.equal(Object.getPrototypeOf(settings), Object.prototype);
  assert.equal(settings.injected, undefined);
  assert.equal(Object.hasOwn(settings.agent, "constructor"), false);

  const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(Object.hasOwn(onDisk.agent, "constructor"), false);
});

test("createSettingsStore.save rejects base URLs that are not http or https", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });

  for (const baseURL of ["file:///etc/hosts", "ftp://example.test/v1", "not a url", 42]) {
    await assert.rejects(store.save({ agent: { openai: { baseURL } } }), /base URL/);
  }
  await assert.rejects(store.save({ agent: { codex: { baseURL: "file:///tmp/codex" } } }), /base URL/);
  await assert.rejects(store.save({ agent: { ollama: { baseURL: "file:///tmp/ollama" } } }), /base URL/);
  await assert.rejects(store.save({ agent: { openrouter: { baseURL: "file:///tmp/openrouter" } } }), /base URL/);

  const settings = await store.load();
  assert.equal(settings.agent.openai.baseURL, DEFAULT_SETTINGS.agent.openai.baseURL);
  assert.equal(settings.agent.codex.baseURL, DEFAULT_SETTINGS.agent.codex.baseURL);
  assert.equal(settings.agent.ollama.baseURL, DEFAULT_SETTINGS.agent.ollama.baseURL);
  assert.equal(settings.agent.openrouter.baseURL, DEFAULT_SETTINGS.agent.openrouter.baseURL);
});

test("createSettingsStore.save accepts http, https and empty base URLs", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });

  await store.save({
    agent: {
      openai: { baseURL: "https://gateway.example.test/v1" },
      ollama: { baseURL: "http://192.168.1.20:11434/v1" },
    },
  });
  await store.save({ agent: { openai: { baseURL: "" } } });

  const settings = await store.load();
  assert.equal(settings.agent.openai.baseURL, "");
  assert.equal(settings.agent.ollama.baseURL, "http://192.168.1.20:11434/v1");
});

test("createSettingsStore ships Deepgram and OpenRouter defaults", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  assert.equal(settings.transcription.deepgram.model, "nova-3");
  assert.deepEqual(settings.transcription.deepgram.keyterms, []);
  assert.equal(settings.agent.openrouter.model, "x-ai/grok-4.20");
  assert.equal(settings.agent.openrouter.baseURL, "https://openrouter.ai/api/v1");
  assert.equal(settings.apiKeys.deepgram, "");
  assert.equal(settings.apiKeys.openrouter, "");
});

test("createSettingsStore seeds the Deepgram key and model from env, and selects Deepgram STT", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: { DEEPGRAM_API_KEY: "dg-env", DEEPGRAM_MODEL: "nova-2" },
    readCodexAuth: noCodexAuth,
  });
  const settings = await store.load();
  assert.equal(settings.apiKeys.deepgram, "dg-env");
  assert.equal(settings.transcription.deepgram.model, "nova-2");
  assert.equal(settings.transcription.provider, "deepgram");
});

test("a Deepgram key outranks an OpenAI key for speech, and each keeps its own key", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: { DEEPGRAM_API_KEY: "dg-env", OPENAI_API_KEY: "sk-env" },
    readCodexAuth: noCodexAuth,
  });
  const settings = await store.load();
  assert.equal(settings.transcription.provider, "deepgram");
  // The two vendors are separate accounts: neither key may stand in for the other.
  assert.equal(settings.apiKeys.deepgram, "dg-env");
  assert.equal(settings.apiKeys.openai, "sk-env");
});

test("createSettingsStore seeds OpenRouter from env and selects it as the agent", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: {
      OPENROUTER_API_KEY: "sk-or-env",
      OPENROUTER_MODEL: "x-ai/grok-4.20",
      OPENROUTER_BASE_URL: "https://proxy.example.test/api/v1",
    },
    readCodexAuth: noCodexAuth,
  });
  const settings = await store.load();
  assert.equal(settings.apiKeys.openrouter, "sk-or-env");
  assert.equal(settings.agent.provider, "openrouter");
  assert.equal(settings.agent.openrouter.model, "x-ai/grok-4.20");
  assert.equal(settings.agent.openrouter.baseURL, "https://proxy.example.test/api/v1");
});

test("an explicit OpenRouter key outranks a Codex login for the agent", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: { OPENROUTER_API_KEY: "sk-or-env" },
    readCodexAuth: () => ({
      tokens: {},
      accessToken: "codex-token",
      refreshToken: "codex-refresh",
      accountId: "codex-account",
    }),
  });
  const settings = await store.load();
  assert.equal(settings.agent.provider, "openrouter");
});

test("getSanitized reports the new keys as booleans and never returns their values", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: { DEEPGRAM_API_KEY: "dg-secret", OPENROUTER_API_KEY: "sk-or-secret" },
    readCodexAuth: noCodexAuth,
  });
  await store.load();
  const sanitized = await store.getSanitized();
  assert.equal(sanitized.hasDeepgramKey, true);
  assert.equal(sanitized.hasOpenRouterKey, true);
  assert.equal(sanitized.hasOpenAIKey, false);
  assert.equal("apiKeys" in sanitized, false);
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes("dg-secret"), false);
  assert.equal(serialized.includes("sk-or-secret"), false);
});

test("saving keyterms replaces the array rather than merging it", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ transcription: { deepgram: { keyterms: ["gRPC", "Envoy"] } } });
  const afterFirst = await store.load();
  assert.deepEqual(afterFirst.transcription.deepgram.keyterms, ["gRPC", "Envoy"]);

  await store.save({ transcription: { deepgram: { keyterms: ["Kubernetes"] } } });
  const afterSecond = await store.load();
  assert.deepEqual(afterSecond.transcription.deepgram.keyterms, ["Kubernetes"]);
});

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

async function loadWithCodexModel(codexModel, extra = {}) {
  const filePath = await tempPath();
  await fs.writeFile(filePath, JSON.stringify({ agent: { provider: "codex", codex: { model: codexModel, ...extra }, openai: { model: "gpt-5.5" } } }));
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
  return { settings, onDisk };
}

test("load moves a Codex model that left Codex to GPT-6.1 Sol and keeps Fast mode", async () => {
  const { settings, onDisk } = await loadWithCodexModel("gpt-5.5-fast");
  assert.equal(settings.agent.codex.model, "gpt-6.1-sol");
  assert.equal(settings.agent.codex.fast, true);
  assert.deepEqual([onDisk.agent.codex.model, onDisk.agent.codex.fast], ["gpt-6.1-sol", true]);
  // The OpenAI API keeps GPT-5.5, so an API pick stays.
  assert.equal(settings.agent.openai.model, "gpt-5.5");
});

test("load moves a retired standard-mode Codex pick to GPT-6.1 Sol without Fast mode", async () => {
  const { settings } = await loadWithCodexModel("gpt-5.4");
  assert.equal(settings.agent.codex.model, "gpt-6.1-sol");
  assert.equal(settings.agent.codex.fast, false);
});

test("load keeps GPT-6.1 Sol in the mode it was picked", async () => {
  const { settings, onDisk } = await loadWithCodexModel("gpt-6.1-sol");
  assert.equal(settings.agent.codex.model, "gpt-6.1-sol");
  assert.equal(settings.agent.codex.fast, false);
  assert.equal(onDisk.agent.codex.model, "gpt-6.1-sol");
});

test("load moves GPT-6 Sol and Luna, which Mic Draw no longer offers, to GPT-6.1 Sol in the same mode", async () => {
  const luna = await loadWithCodexModel("gpt-6-luna-fast");
  assert.deepEqual([luna.settings.agent.codex.model, luna.settings.agent.codex.fast], ["gpt-6.1-sol", true]);
  assert.deepEqual([luna.onDisk.agent.codex.model, luna.onDisk.agent.codex.fast], ["gpt-6.1-sol", true]);
  const sol = await loadWithCodexModel("gpt-6-sol", { fast: false });
  assert.deepEqual([sol.settings.agent.codex.model, sol.settings.agent.codex.fast], ["gpt-6.1-sol", false]);
});

test("load moves an OpenAI API pick of GPT-6 Sol or Luna to GPT-6.1 Sol", async () => {
  const filePath = await tempPath();
  await fs.writeFile(filePath, JSON.stringify({ agent: { provider: "openai", openai: { model: "gpt-6-luna" } } }));
  const settings = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();
  assert.equal(settings.agent.openai.model, "gpt-6.1-sol");
});

test("load moves a reasoning effort of none, which GPT-6.1 Sol rejects, to low", async () => {
  const filePath = await tempPath();
  await fs.writeFile(filePath, JSON.stringify({ agent: { provider: "codex", openai: { reasoningEffort: "none" } } }));
  const settings = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();
  assert.equal(settings.agent.openai.reasoningEffort, "low");
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).agent.openai.reasoningEffort, "low");
  const seeded = await createSettingsStore({ filePath: await tempPath(), env: { OPENAI_REASONING_EFFORT: "none" }, readCodexAuth: noCodexAuth }).load();
  assert.equal(seeded.agent.openai.reasoningEffort, "low");
});

test("load splits a saved name ending in -fast into the model and Fast mode", async () => {
  const { settings, onDisk } = await loadWithCodexModel("gpt-6.1-sol-fast");
  assert.equal(settings.agent.codex.model, "gpt-6.1-sol");
  assert.equal(settings.agent.codex.fast, true);
  assert.deepEqual([onDisk.agent.codex.model, onDisk.agent.codex.fast], ["gpt-6.1-sol", true]);
});

test("load keeps an explicit Fast mode choice", async () => {
  const { settings } = await loadWithCodexModel("gpt-6.1-sol", { fast: false });
  assert.equal(settings.agent.codex.fast, false);
});

test("new installs transcribe through OpenAI's gpt-live-transcribe", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  assert.equal(settings.transcription.openai.model, "gpt-live-transcribe");
});

test("load moves an OpenAI transcription model that realtime sessions no longer serve", async () => {
  const filePath = await tempPath();
  await fs.writeFile(filePath, JSON.stringify({ transcription: { provider: "openai", openai: { model: "gpt-4o-transcribe" } } }));
  const settings = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();
  assert.equal(settings.transcription.openai.model, "gpt-live-transcribe");
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).transcription.openai.model, "gpt-live-transcribe");
});

test("load keeps gpt-realtime-whisper, which realtime sessions still serve", async () => {
  const filePath = await tempPath();
  await fs.writeFile(filePath, JSON.stringify({ transcription: { provider: "openai", openai: { model: "gpt-realtime-whisper" } } }));
  const settings = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();
  assert.equal(settings.transcription.openai.model, "gpt-realtime-whisper");
});

test("save accepts a language the chosen transcription provider offers", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  await store.save({ transcription: { provider: "openai", language: "uk" } });
  const settings = await store.save({ transcription: { provider: "deepgram", language: "multi" } });
  assert.equal(settings.transcription.language, "multi");
});

test("save rejects a language the chosen transcription provider does not offer", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  await assert.rejects(() => store.save({ transcription: { provider: "local", language: "uk" } }), /Unsupported transcription language "uk"/);
  await store.save({ transcription: { provider: "deepgram", language: "multi" } });
  // Switching to a provider without that language must name a new one.
  await assert.rejects(() => store.save({ transcription: { provider: "openai" } }), /Unsupported transcription language "multi"/);
});

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
  assert.equal(settings.agent.codex.model, "gpt-5.5-fast");
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

test("createSettingsStore falls back to moonshine transcription without OPENAI_API_KEY", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  assert.equal(settings.transcription.provider, "moonshine");
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

  const settings = await store.load();
  assert.equal(settings.agent.openai.baseURL, DEFAULT_SETTINGS.agent.openai.baseURL);
  assert.equal(settings.agent.codex.baseURL, DEFAULT_SETTINGS.agent.codex.baseURL);
  assert.equal(settings.agent.ollama.baseURL, DEFAULT_SETTINGS.agent.ollama.baseURL);
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

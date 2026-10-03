import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveSimulatorAgentProvider } from "../src/simulator-agent-provider.js";

test("resolveSimulatorAgentProvider always uses Codex CLI auth", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "micdraw-sim-codex-"));
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "codex-token", refresh_token: "refresh" } }));

  assert.deepEqual(
    resolveSimulatorAgentProvider({
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: "openai-key",
      OLLAMA_MODEL: "llama3.2",
    }),
    {
      provider: "codex",
      model: "gpt-6-sol",
      baseURL: "https://chatgpt.com/backend-api/codex",
      apiKey: "codex-token",
      reasoningEffort: "low",
    },
  );
});

test("resolveSimulatorAgentProvider disables Codex fast mode", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "micdraw-sim-codex-"));
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "codex-token", refresh_token: "refresh" } }));

  assert.deepEqual(
    resolveSimulatorAgentProvider({
      CODEX_HOME: codexHome,
      CODEX_MODEL: "gpt-6-sol-fast",
    }),
    {
      provider: "codex",
      model: "gpt-6-sol",
      baseURL: "https://chatgpt.com/backend-api/codex",
      apiKey: "codex-token",
      reasoningEffort: "low",
    },
  );
});

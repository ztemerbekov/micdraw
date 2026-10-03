import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSimulatorAgentProvider } from "../scripts/lib/simulator-agent-provider.js";
import { codexHomeWith } from "./helpers/tmp.js";

test("resolveSimulatorAgentProvider always uses Codex CLI auth", (t) => {
  const codexHome = codexHomeWith(t);

  assert.deepEqual(
    resolveSimulatorAgentProvider({
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: "openai-key",
      OLLAMA_MODEL: "llama3.2",
    }),
    {
      provider: "codex",
      model: "gpt-6.1-sol",
      baseURL: "https://chatgpt.com/backend-api/codex",
      apiKey: "codex-token",
      reasoningEffort: "low",
    },
  );
});

test("resolveSimulatorAgentProvider disables Codex fast mode", (t) => {
  const codexHome = codexHomeWith(t);

  assert.deepEqual(
    resolveSimulatorAgentProvider({
      CODEX_HOME: codexHome,
      CODEX_MODEL: "gpt-6.1-sol-fast",
    }),
    {
      provider: "codex",
      model: "gpt-6.1-sol",
      baseURL: "https://chatgpt.com/backend-api/codex",
      apiKey: "codex-token",
      reasoningEffort: "low",
    },
  );
});

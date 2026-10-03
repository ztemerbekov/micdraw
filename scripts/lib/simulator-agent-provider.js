import { resolveAgentProviderFromSettings } from "../../src/agent-provider.js";
import { DEFAULT_SETTINGS } from "../../src/settings-store.js";

export function resolveSimulatorAgentProvider(env = process.env) {
  const defaults = DEFAULT_SETTINGS.agent;
  const requested = env.CODEX_MODEL?.trim() || env.OPENAI_MODEL?.trim() || defaults.codex.model;
  const model = stripFastMode(requested);
  return resolveAgentProviderFromSettings({
    settings: {
      agent: {
        provider: "codex",
        openai: { model: defaults.openai.model, reasoningEffort: defaults.openai.reasoningEffort },
        codex: { model, fast: false, baseURL: defaults.codex.baseURL },
        ollama: { model: "", baseURL: "" },
      },
      apiKeys: { openai: "" },
    },
    env,
  });
}

function stripFastMode(model) {
  if (model.endsWith("-fast")) return model.slice(0, -"-fast".length);
  return model;
}

import { createOpenAI } from "@ai-sdk/openai";

import { cleanEnvValue, createCodexFetch, readCodexCliAuthSync } from "./codex-auth.js";
import { DEFAULT_SETTINGS } from "./settings-store.js";

// Each provider's default model and base URL; src/settings-store.js says why.
const AGENT_DEFAULTS = DEFAULT_SETTINGS.agent;
// What GPT-6.1 Sol takes; it rejects "none".
const OPENAI_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function defaultWhiteboardAgentProvider(options = {}) {
  return {
    provider: "openai",
    model: AGENT_DEFAULTS.openai.model,
    apiKey: options.openaiApiKey,
    baseURL: AGENT_DEFAULTS.openai.baseURL,
    reasoningEffort: AGENT_DEFAULTS.openai.reasoningEffort,
  };
}

export function resolveAgentProviderFromSettings({ settings, env = process.env }) {
  const provider = settings.agent.provider;

  if (provider === "ollama") {
    const model = (settings.agent.ollama.model ?? "").trim();
    if (!model) throw new Error("Ollama model is not configured. Set it in the agent settings.");
    return {
      provider: "ollama",
      model,
      baseURL: withoutTrailingSlash(settings.agent.ollama.baseURL ?? AGENT_DEFAULTS.ollama.baseURL),
      apiKey: "ollama",
    };
  }

  if (provider === "openrouter") {
    const apiKey =
      (settings.agent?.openrouter?.apiKey ?? "").trim() ||
      (settings.apiKeys?.openrouter ?? "").trim() ||
      cleanEnvValue(env.OPENROUTER_API_KEY);
    if (!apiKey) throw new Error("OpenRouter API key is not configured. Add it in the agent settings.");
    // OpenRouter speaks the same `/responses` endpoint as the OpenAI path.
    // Deliberately no `reasoningEffort`: it is an OpenAI-specific provider
    // option, most OpenRouter models reject or ignore it, and
    // createWhiteboardAgentProviderOptions already declines to send provider
    // options for anything that is not openai/codex.
    return {
      provider: "openrouter",
      model: (settings.agent?.openrouter?.model ?? "").trim() || AGENT_DEFAULTS.openrouter.model,
      apiKey,
      baseURL: withoutTrailingSlash(
        cleanEnvValue(settings.agent?.openrouter?.baseURL) ?? AGENT_DEFAULTS.openrouter.baseURL,
      ),
    };
  }

  if (provider === "xai") {
    const apiKey = (settings.apiKeys?.xai ?? "").trim() || cleanEnvValue(env.XAI_API_KEY);
    if (!apiKey) throw new Error("xAI API key is not configured. Add it in the agent settings.");
    // No `reasoningEffort`, as for OpenRouter: it is an OpenAI provider option.
    return {
      provider: "xai",
      model: (settings.agent?.xai?.model ?? "").trim() || AGENT_DEFAULTS.xai.model,
      apiKey,
      baseURL: withoutTrailingSlash(cleanEnvValue(settings.agent?.xai?.baseURL) ?? AGENT_DEFAULTS.xai.baseURL),
    };
  }

  if (provider === "codex") {
    const codexAuth = readCodexCliAuthSync(env);
    if (!codexAuth) throw new Error("Codex CLI auth not found. Run `codex` and sign in with ChatGPT.");
    // Fast mode is OpenAI's "priority" service tier. Older settings named it
    // in the model ("gpt-6.1-sol-fast"); still read that.
    const requested = settings.agent.codex.model || AGENT_DEFAULTS.codex.model;
    const namedFast = requested.endsWith("-fast");
    const fast = namedFast || (settings.agent.codex.fast ?? true);
    return {
      provider: "codex",
      model: namedFast ? requested.slice(0, -"-fast".length) : requested,
      ...(fast ? { serviceTier: "priority" } : {}),
      baseURL: withoutTrailingSlash(settings.agent.codex.baseURL ?? AGENT_DEFAULTS.codex.baseURL),
      apiKey: codexAuth.accessToken,
      reasoningEffort: validateReasoningEffort(settings.agent.openai.reasoningEffort),
    };
  }

  const apiKey = (settings.apiKeys?.openai ?? "").trim() || cleanEnvValue(env.OPENAI_API_KEY);
  if (!apiKey) throw new Error("OpenAI API key is not configured. Add it in the agent settings.");
  return {
    provider: "openai",
    model: settings.agent.openai.model || AGENT_DEFAULTS.openai.model,
    apiKey,
    reasoningEffort: validateReasoningEffort(settings.agent.openai.reasoningEffort),
    baseURL: withoutTrailingSlash(cleanEnvValue(settings.agent.openai.baseURL) ?? AGENT_DEFAULTS.openai.baseURL),
  };
}

function validateReasoningEffort(reasoningEffort) {
  const value = reasoningEffort || AGENT_DEFAULTS.openai.reasoningEffort;
  if (!OPENAI_REASONING_EFFORTS.has(value)) {
    throw new Error(`Unsupported reasoning effort "${value}". Use low, medium, high, xhigh, or max.`);
  }
  return value;
}

// The OpenAI-compatible API each non-OpenAI provider is called through.
const COMPATIBLE_APIS = {
  ollama: { name: "ollama", api: "chat" },
  // `.responses()` rather than `.chat()`: OpenRouter implements the Responses
  // API, and it is the same shape the OpenAI path sends, so tool calls and
  // message reshaping behave identically.
  openrouter: { name: "openrouter", api: "responses" },
  // Chat Completions rather than Responses: it is the API upstream
  // autopreso#24 ran its live tool-calling check against.
  xai: { name: "xai", api: "chat" },
  codex: { name: "openai-codex", api: "responses", createFetch: createCodexFetch },
};

export function createWhiteboardAgentModel(agentProvider) {
  const compatible = COMPATIBLE_APIS[agentProvider.provider];
  if (!compatible) {
    const openai = createOpenAI({ apiKey: agentProvider.apiKey, baseURL: agentProvider.baseURL });
    return openai(agentProvider.model);
  }
  const client = createOpenAI({
    name: compatible.name,
    baseURL: agentProvider.baseURL,
    apiKey: agentProvider.apiKey,
    ...(compatible.createFetch ? { fetch: compatible.createFetch() } : {}),
  });
  return client[compatible.api](agentProvider.model);
}

function withoutTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

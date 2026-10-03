import { createOpenAI } from "@ai-sdk/openai";

import { DEFAULT_CODEX_BASE_URL, createCodexFetch, readCodexCliAuthSync } from "./codex-auth.js";

// The only OpenAI model Mic Draw offers; src/settings-store.js says why.
const DEFAULT_OPENAI_AGENT_MODEL = "gpt-6.1-sol";
const DEFAULT_CODEX_AGENT_MODEL = "gpt-6.1-sol";
const DEFAULT_OPENAI_REASONING_EFFORT = "low";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
// What GPT-6.1 Sol takes; it rejects "none".
const OPENAI_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// OpenRouter fronts many vendors behind an OpenAI-shaped API, including the
// `/responses` endpoint this app's OpenAI path already speaks, so the whole
// provider is a base URL, a key and a model id. Grok is the default because it
// answers a tool-call turn quickly; any OpenRouter model id works. Reviewed
// 2026-10-03 against OpenRouter's catalogue only, not verified live (#25):
// Grok 4.3-4.7 are newer, but nothing public shows them faster and 4.5+ cost
// more, so 4.20 stays until a measured turn says otherwise.
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_AGENT_MODEL = "x-ai/grok-4.20";

// xAI directly, through its OpenAI-compatible API. Ported from upstream
// autopreso#24, whose author checked tool calling against the live API; here
// it is checked against xAI's docs only (#17). grok-4.3 is that PR's default
// and costs the same per token as grok-4.20.
export const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_XAI_AGENT_MODEL = "grok-4.3";

export function defaultWhiteboardAgentProvider(options = {}) {
  return {
    provider: "openai",
    model: DEFAULT_OPENAI_AGENT_MODEL,
    apiKey: options.openaiApiKey,
    baseURL: DEFAULT_OPENAI_BASE_URL,
    reasoningEffort: DEFAULT_OPENAI_REASONING_EFFORT,
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
      baseURL: withoutTrailingSlash(settings.agent.ollama.baseURL ?? DEFAULT_OLLAMA_BASE_URL),
      apiKey: "ollama",
    };
  }

  if (provider === "openrouter") {
    const apiKey =
      (settings.agent?.openrouter?.apiKey ?? "").trim() ||
      (settings.apiKeys?.openrouter ?? "").trim() ||
      cleanEnvValue(env.OPENROUTER_API_KEY);
    if (!apiKey) throw new Error("OpenRouter API key is not configured. Add it in the agent settings.");
    // Deliberately no `reasoningEffort`: it is an OpenAI-specific provider
    // option, most OpenRouter models reject or ignore it, and
    // createWhiteboardAgentProviderOptions already declines to send provider
    // options for anything that is not openai/codex.
    return {
      provider: "openrouter",
      model: (settings.agent?.openrouter?.model ?? "").trim() || DEFAULT_OPENROUTER_AGENT_MODEL,
      apiKey,
      baseURL: withoutTrailingSlash(
        cleanEnvValue(settings.agent?.openrouter?.baseURL) ?? DEFAULT_OPENROUTER_BASE_URL,
      ),
    };
  }

  if (provider === "xai") {
    const apiKey = (settings.apiKeys?.xai ?? "").trim() || cleanEnvValue(env.XAI_API_KEY);
    if (!apiKey) throw new Error("xAI API key is not configured. Add it in the agent settings.");
    // No `reasoningEffort`, as for OpenRouter: it is an OpenAI provider option.
    return {
      provider: "xai",
      model: (settings.agent?.xai?.model ?? "").trim() || DEFAULT_XAI_AGENT_MODEL,
      apiKey,
      baseURL: withoutTrailingSlash(cleanEnvValue(settings.agent?.xai?.baseURL) ?? DEFAULT_XAI_BASE_URL),
    };
  }

  if (provider === "codex") {
    const codexAuth = readCodexCliAuthSync(env);
    if (!codexAuth) throw new Error("Codex CLI auth not found. Run `codex` and sign in with ChatGPT.");
    // Fast mode is OpenAI's "priority" service tier. Older settings named it
    // in the model ("gpt-6.1-sol-fast"); still read that.
    const requested = settings.agent.codex.model || DEFAULT_CODEX_AGENT_MODEL;
    const namedFast = requested.endsWith("-fast");
    const fast = namedFast || (settings.agent.codex.fast ?? true);
    return {
      provider: "codex",
      model: namedFast ? requested.slice(0, -"-fast".length) : requested,
      ...(fast ? { serviceTier: "priority" } : {}),
      baseURL: withoutTrailingSlash(settings.agent.codex.baseURL ?? DEFAULT_CODEX_BASE_URL),
      apiKey: codexAuth.accessToken,
      reasoningEffort: validateReasoningEffort(settings.agent.openai.reasoningEffort),
    };
  }

  const apiKey = (settings.apiKeys?.openai ?? "").trim() || cleanEnvValue(env.OPENAI_API_KEY);
  if (!apiKey) throw new Error("OpenAI API key is not configured. Add it in the agent settings.");
  return {
    provider: "openai",
    model: settings.agent.openai.model || DEFAULT_OPENAI_AGENT_MODEL,
    apiKey,
    reasoningEffort: validateReasoningEffort(settings.agent.openai.reasoningEffort),
    baseURL: withoutTrailingSlash(cleanEnvValue(settings.agent.openai.baseURL) ?? DEFAULT_OPENAI_BASE_URL),
  };
}

function validateReasoningEffort(reasoningEffort) {
  const value = reasoningEffort || DEFAULT_OPENAI_REASONING_EFFORT;
  if (!OPENAI_REASONING_EFFORTS.has(value)) {
    throw new Error(`Unsupported reasoning effort "${value}". Use low, medium, high, xhigh, or max.`);
  }
  return value;
}

export function createWhiteboardAgentModel(agentProvider) {
  if (agentProvider.provider === "ollama") {
    const ollama = createOpenAI({
      name: "ollama",
      baseURL: agentProvider.baseURL,
      apiKey: agentProvider.apiKey,
    });
    return ollama.chat(agentProvider.model);
  }

  if (agentProvider.provider === "openrouter") {
    const openrouter = createOpenAI({
      name: "openrouter",
      baseURL: agentProvider.baseURL,
      apiKey: agentProvider.apiKey,
    });
    // `.responses()` rather than `.chat()`: OpenRouter implements the Responses
    // API, and it is the same shape the OpenAI path sends, so tool calls and
    // message reshaping behave identically.
    return openrouter.responses(agentProvider.model);
  }

  if (agentProvider.provider === "xai") {
    const xai = createOpenAI({
      name: "xai",
      baseURL: agentProvider.baseURL,
      apiKey: agentProvider.apiKey,
    });
    // Chat Completions rather than Responses: it is the API upstream
    // autopreso#24 ran its live tool-calling check against.
    return xai.chat(agentProvider.model);
  }

  if (agentProvider.provider === "codex") {
    const codex = createOpenAI({
      name: "openai-codex",
      baseURL: agentProvider.baseURL,
      apiKey: agentProvider.apiKey,
      fetch: createCodexFetch(),
    });
    return codex.responses(agentProvider.model);
  }

  const openai = createOpenAI({
    apiKey: agentProvider.apiKey,
    baseURL: agentProvider.baseURL,
  });
  return openai(agentProvider.model);
}

function cleanEnvValue(value) {
  const trimmedValue = value?.trim();
  return trimmedValue || undefined;
}

function withoutTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

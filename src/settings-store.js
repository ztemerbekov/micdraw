import fs from "node:fs/promises";
import path from "node:path";

import { readCodexCliAuthSync } from "./codex-auth.js";
import { LOCAL_MODELS, SUPPORTED_LANGUAGES } from "./local-models.js";

export const MAX_AGENT_INSTRUCTIONS_CHARS = 100_000;

export const DEFAULT_SETTINGS = Object.freeze({
  agent: {
    provider: "openai",
    openai: { model: "gpt-5.5", reasoningEffort: "low", baseURL: "https://api.openai.com/v1" },
    codex: { model: "gpt-5.5-fast", baseURL: "https://chatgpt.com/backend-api/codex" },
    ollama: { model: "", baseURL: "http://localhost:11434/v1" },
    openrouter: { model: "x-ai/grok-4.20", baseURL: "https://openrouter.ai/api/v1" },
  },
  transcription: {
    // "local" picks a model by language and platform (src/local-models.js);
    // `local.models` holds a per-language pick. "moonshine" is the provider
    // older settings files use and still means the Moonshine sidecar.
    provider: "local",
    language: "en",
    local: { models: {} },
    moonshine: { model: "medium" },
    openai: { model: "gpt-realtime-whisper" },
    // `keyterms` biases nova-3 toward words its language model has never seen -
    // product names, jargon, people in the room. Empty by default; the staging
    // board's own text is merged in on top of whatever is set here.
    deepgram: { model: "nova-3", keyterms: [] },
  },
  apiKeys: {
    openai: "",
    deepgram: "",
    openrouter: "",
  },
  agentInstructions: "",
});

export function createSettingsStore({ filePath, env = process.env, readCodexAuth = readCodexCliAuthSync }) {
  let cached = null;

  async function readFromDisk() {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return deepMerge(cloneDefaults(), JSON.parse(raw));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function writeToDisk(settings) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    try {
      await fs.chmod(filePath, 0o600);
    } catch {}
  }

  async function load() {
    if (cached) return cached;
    const fromDisk = await readFromDisk();
    if (fromDisk) {
      cached = fromDisk;
      return cached;
    }
    const seeded = seedFromEnv(cloneDefaults(), env, readCodexAuth);
    await writeToDisk(seeded);
    cached = seeded;
    return cached;
  }

  async function save(partial) {
    if (!cached) await load();
    validateAgentInstructions(partial?.agentInstructions);
    validateBaseURLs(partial);
    validateTranscription(partial?.transcription);
    cached = deepMerge(cached, partial);
    await writeToDisk(cached);
    return cached;
  }

  async function getSanitized() {
    const settings = await load();
    const { apiKeys, ...rest } = settings;
    // Keys are exposed as booleans only. The browser is told whether a key is
    // configured, never what it is.
    return {
      ...rest,
      hasOpenAIKey: Boolean(apiKeys?.openai),
      hasDeepgramKey: Boolean(apiKeys?.deepgram),
      hasOpenRouterKey: Boolean(apiKeys?.openrouter),
    };
  }

  return { load, save, getSanitized };
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

// Keys that would replace an object's prototype instead of setting a field.
const UNSAFE_MERGE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepMerge(target, source) {
  if (!source || typeof source !== "object") return target;
  const result = Array.isArray(target) ? [...target] : { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_MERGE_KEYS.has(key)) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(result[key] ?? {}, value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function seedFromEnv(settings, env, readCodexAuth) {
  const next = settings;
  const openaiKey = trimOrEmpty(env.OPENAI_API_KEY);
  if (openaiKey) next.apiKeys.openai = openaiKey;

  const openaiModel = trimOrEmpty(env.OPENAI_MODEL);
  if (openaiModel) next.agent.openai.model = openaiModel;

  const openaiBaseURL = trimOrEmpty(env.OPENAI_BASE_URL);
  if (openaiBaseURL) next.agent.openai.baseURL = openaiBaseURL;

  const reasoningEffort = trimOrEmpty(env.OPENAI_REASONING_EFFORT);
  if (reasoningEffort) next.agent.openai.reasoningEffort = reasoningEffort;

  const codexModel = trimOrEmpty(env.CODEX_MODEL);
  if (codexModel) next.agent.codex.model = codexModel;

  const codexBaseURL = trimOrEmpty(env.CODEX_BASE_URL);
  if (codexBaseURL) next.agent.codex.baseURL = codexBaseURL;

  const ollamaModel = trimOrEmpty(env.OLLAMA_MODEL);
  if (ollamaModel) next.agent.ollama.model = ollamaModel;

  const ollamaBaseURL = trimOrEmpty(env.OLLAMA_BASE_URL);
  if (ollamaBaseURL) next.agent.ollama.baseURL = ollamaBaseURL;

  const deepgramKey = trimOrEmpty(env.DEEPGRAM_API_KEY);
  if (deepgramKey) next.apiKeys.deepgram = deepgramKey;

  const deepgramModel = trimOrEmpty(env.DEEPGRAM_MODEL);
  if (deepgramModel) next.transcription.deepgram.model = deepgramModel;

  const openrouterKey = trimOrEmpty(env.OPENROUTER_API_KEY);
  if (openrouterKey) next.apiKeys.openrouter = openrouterKey;

  const openrouterModel = trimOrEmpty(env.OPENROUTER_MODEL);
  if (openrouterModel) next.agent.openrouter.model = openrouterModel;

  const openrouterBaseURL = trimOrEmpty(env.OPENROUTER_BASE_URL);
  if (openrouterBaseURL) next.agent.openrouter.baseURL = openrouterBaseURL;

  const codexAuth = safeReadCodexAuth(readCodexAuth, env);
  // An explicit OpenRouter key is a deliberate choice of a non-OpenAI agent, so
  // it outranks a Codex login that happens to be lying around.
  if (openrouterKey) next.agent.provider = "openrouter";
  else if (codexAuth) next.agent.provider = "codex";
  else if (ollamaModel) next.agent.provider = "ollama";
  else next.agent.provider = "openai";

  // Deepgram outranks OpenAI for speech: a box with both keys set has gone out
  // of its way to configure the dedicated STT vendor.
  if (deepgramKey) next.transcription.provider = "deepgram";
  else if (openaiKey) next.transcription.provider = "openai";

  return next;
}

function safeReadCodexAuth(readCodexAuth, env) {
  try {
    return readCodexAuth(env);
  } catch {
    return null;
  }
}

function trimOrEmpty(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function validateAgentInstructions(value) {
  if (typeof value === "string" && value.length > MAX_AGENT_INSTRUCTIONS_CHARS) {
    throw new Error(`Agent instructions must be ${MAX_AGENT_INSTRUCTIONS_CHARS} characters or fewer.`);
  }
}

const TRANSCRIPTION_PROVIDERS = ["local", "moonshine", "openai", "deepgram"];

function validateTranscription(transcription) {
  if (!transcription || typeof transcription !== "object") return;
  const { provider, language, local } = transcription;
  if (provider !== undefined && !TRANSCRIPTION_PROVIDERS.includes(provider)) {
    throw new Error(`Unknown transcription provider "${provider}".`);
  }
  if (language !== undefined && !SUPPORTED_LANGUAGES.includes(language)) {
    throw new Error(`Unsupported transcription language "${language}".`);
  }
  for (const [lang, id] of Object.entries(local?.models ?? {})) {
    if (!SUPPORTED_LANGUAGES.includes(lang)) throw new Error(`Unsupported transcription language "${lang}".`);
    if (!LOCAL_MODELS.some((model) => model.id === id && model.language === lang)) {
      throw new Error(`Unknown local model "${id}" for language "${lang}".`);
    }
  }
}

// An empty base URL means "use the provider default".
function validateBaseURLs(partial) {
  for (const provider of ["openai", "codex", "ollama", "openrouter"]) {
    const value = partial?.agent?.[provider]?.baseURL;
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !isHttpUrlOrEmpty(value)) {
      throw new Error(`The ${provider} base URL must start with http:// or https://.`);
    }
  }
}

function isHttpUrlOrEmpty(value) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

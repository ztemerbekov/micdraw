import fs from "node:fs/promises";
import path from "node:path";

import { readCodexCliAuthSync } from "./codex-auth.js";
import { transcriptionLanguages } from "./languages.js";
import { LOCAL_MODELS, SUPPORTED_LANGUAGES } from "./local-models.js";

export const MAX_AGENT_INSTRUCTIONS_CHARS = 100_000;

// Models that Codex with ChatGPT sign-in no longer serves (GPT-5.5 from
// 2026-10-14). A saved pick of one of them would fail every agent turn, so
// load() moves it to GPT-6.1 Sol. The OpenAI API still serves them, so API
// settings are left alone.
const RETIRED_CODEX_MODELS = new Set(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2"]);
const CODEX_REPLACEMENT_MODEL = "gpt-6.1-sol";
// Models Mic Draw stopped offering: GPT-6 Luna deleted stages and duplicated
// cards on replayed real turns (#52), and in use both drew clearly worse than
// GPT-6.1 Sol. They were the defaults for a while, so a saved pick moves on,
// for Codex and the OpenAI API alike.
const DROPPED_AGENT_MODELS = new Set(["gpt-6-sol", "gpt-6-luna"]);
const AGENT_REPLACEMENT_MODEL = "gpt-6.1-sol";
// GPT-6.1 Sol rejects this reasoning effort, which the menu used to offer.
const RETIRED_REASONING_EFFORT = "none";
// OpenAI deprecated these for removal on 2027-02-26, and its model pages
// already list realtime transcription as not supported. A saved pick moves to
// the documented replacement (issue #26, checked against the docs only).
const RETIRED_OPENAI_TRANSCRIPTION_MODELS = new Set(["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"]);
const OPENAI_TRANSCRIPTION_REPLACEMENT_MODEL = "gpt-live-transcribe";

export const DEFAULT_SETTINGS = Object.freeze({
  agent: {
    provider: "openai",
    openai: { model: "gpt-6.1-sol", reasoningEffort: "low", baseURL: "https://api.openai.com/v1" },
    // `fast` sends Codex requests in OpenAI's Fast mode: quicker replies, at
    // 2.5x the ChatGPT plan usage.
    codex: { model: "gpt-6.1-sol", fast: true, baseURL: "https://chatgpt.com/backend-api/codex" },
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
    // OpenAI's recommended realtime transcription model: same price as
    // gpt-realtime-whisper, and it takes the vocabulary prompt. Chosen from
    // the docs, not verified live (issue #26).
    openai: { model: "gpt-live-transcribe" },
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
      const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
      return { settings: deepMerge(cloneDefaults(), saved), saved };
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
      cached = replaceRetiredChoices(splitFastMode(fromDisk.settings, fromDisk.saved));
      if (cached !== fromDisk.settings) await writeToDisk(cached);
      return cached;
    }
    const seededFromEnv = seedFromEnv(cloneDefaults(), env, readCodexAuth);
    const seeded = replaceRetiredChoices(splitFastMode(seededFromEnv, seededFromEnv));
    await writeToDisk(seeded);
    cached = seeded;
    return cached;
  }

  async function save(partial) {
    if (!cached) await load();
    validateAgentInstructions(partial?.agentInstructions);
    validateBaseURLs(partial);
    validateTranscription(partial?.transcription, cached.transcription);
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

// Settings written before Fast mode had its own switch named it in the model
// ("gpt-6.1-sol-fast"), and a name without the suffix meant Fast mode off.
// Split such a name into the real model and the `fast` flag. An explicit
// `fast` in the saved file wins.
function splitFastMode(settings, saved) {
  const savedCodex = saved?.agent?.codex ?? {};
  if (typeof savedCodex.model !== "string" || typeof savedCodex.fast === "boolean") return settings;
  const named = savedCodex.model.endsWith("-fast");
  const model = named ? savedCodex.model.slice(0, -"-fast".length) : savedCodex.model;
  if (model === settings.agent.codex.model && named === settings.agent.codex.fast) return settings;
  return deepMerge(settings, { agent: { codex: { model, fast: named } } });
}

function replaceRetiredChoices(settings) {
  let next = settings;
  const codexModel = next.agent?.codex?.model ?? "";
  if (RETIRED_CODEX_MODELS.has(codexModel)) {
    console.log(`[micdraw] Codex no longer serves ${codexModel}; switched the Codex agent model to ${CODEX_REPLACEMENT_MODEL}.`);
    next = deepMerge(next, { agent: { codex: { model: CODEX_REPLACEMENT_MODEL } } });
  } else if (DROPPED_AGENT_MODELS.has(codexModel)) {
    console.log(`[micdraw] Mic Draw no longer offers ${codexModel}; switched the Codex agent model to ${AGENT_REPLACEMENT_MODEL}.`);
    next = deepMerge(next, { agent: { codex: { model: AGENT_REPLACEMENT_MODEL } } });
  }
  const openaiModel = next.agent?.openai?.model ?? "";
  if (DROPPED_AGENT_MODELS.has(openaiModel)) {
    console.log(`[micdraw] Mic Draw no longer offers ${openaiModel}; switched the OpenAI agent model to ${AGENT_REPLACEMENT_MODEL}.`);
    next = deepMerge(next, { agent: { openai: { model: AGENT_REPLACEMENT_MODEL } } });
  }
  if (next.agent?.openai?.reasoningEffort === RETIRED_REASONING_EFFORT) {
    const replacement = DEFAULT_SETTINGS.agent.openai.reasoningEffort;
    console.log(`[micdraw] GPT-6.1 Sol does not take reasoning effort "${RETIRED_REASONING_EFFORT}"; switched it to ${replacement}.`);
    next = deepMerge(next, { agent: { openai: { reasoningEffort: replacement } } });
  }
  const transcriptionModel = next.transcription?.openai?.model ?? "";
  if (RETIRED_OPENAI_TRANSCRIPTION_MODELS.has(transcriptionModel)) {
    console.log(`[micdraw] OpenAI realtime transcription no longer serves ${transcriptionModel}; switched to ${OPENAI_TRANSCRIPTION_REPLACEMENT_MODEL}.`);
    next = deepMerge(next, { transcription: { openai: { model: OPENAI_TRANSCRIPTION_REPLACEMENT_MODEL } } });
  }
  return next;
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

function validateTranscription(transcription, current = {}) {
  if (!transcription || typeof transcription !== "object") return;
  const { provider, language, local } = transcription;
  if (provider !== undefined && !TRANSCRIPTION_PROVIDERS.includes(provider)) {
    throw new Error(`Unknown transcription provider "${provider}".`);
  }
  // The language must suit the provider it ends up with, including when only
  // one of the two changes.
  const nextProvider = provider ?? current.provider;
  const nextLanguage = language ?? current.language;
  if ((language !== undefined || provider !== undefined) && nextLanguage !== undefined && !transcriptionLanguages(nextProvider).includes(nextLanguage)) {
    throw new Error(`Unsupported transcription language "${nextLanguage}".`);
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

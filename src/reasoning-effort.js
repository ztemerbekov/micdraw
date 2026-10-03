// The lowest reasoning effort a model accepts, for the providers whose models
// Mic Draw does not know in advance: xAI, OpenRouter and Ollama (#78). A
// whiteboard edit needs little thinking, and thinking costs seconds per turn:
// on grok-4.3, ~6.1 s with xAI's default against ~1.7 s with "none", measured
// by the author of upstream autopreso#24. Each provider lists what a model
// accepts, so ask it once per model, send the lowest level, and send nothing
// when the answer is unknown. OpenAI and Codex keep the effort from settings.

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// From xAI's model pages (2026-10-03), for when its model list cannot be
// fetched. grok-4.5 and later reject "none".
const XAI_DOCUMENTED_LOWEST = { "grok-4.3": "none", "grok-4.5": "low", "grok-4.6": "low", "grok-4.7": "low" };

const DEFAULT_TIMEOUT_MS = 3_000;

function lowestEffort(efforts) {
  return EFFORT_ORDER.find((effort) => efforts.includes(effort));
}

/** xAI's GET /v1/language-models lists `capabilities.reasoning_effort` per model. */
export function lowestXaiEffort(payload, model) {
  const entry = payload?.models?.find((candidate) => candidate.id === model || candidate.aliases?.includes(model));
  return lowestEffort(entry?.capabilities?.reasoning_effort ?? []);
}

/**
 * OpenRouter's GET /api/v1/models. A model whose reasoning is off by default
 * gets nothing: sending an effort would turn reasoning on.
 */
export function lowestOpenRouterEffort(payload, model) {
  const reasoning = payload?.data?.find((candidate) => candidate.id === model)?.reasoning;
  if (!reasoning?.default_enabled) return undefined;
  return lowestEffort(reasoning.supported_efforts ?? []);
}

/**
 * Ollama's POST /api/show. `thinking.values` holds booleans for a model that
 * thinks or not, and names for one with levels. Over the OpenAI-compatible
 * API, "none" asks an on/off model not to think.
 */
export function lowestOllamaEffort(payload) {
  const thinking = payload?.thinking;
  if (!Array.isArray(thinking?.values) || thinking.default === false) return undefined;
  if (thinking.values.includes(true)) return thinking.values.includes(false) ? "none" : undefined;
  return lowestEffort(thinking.values.filter((value) => typeof value === "string"));
}

const LOOKUPS = {
  xai: async ({ model, baseURL, apiKey }, request) =>
    lowestXaiEffort(await request(`${baseURL}/language-models`, { headers: { Authorization: `Bearer ${apiKey}` } }), model),
  openrouter: async ({ model, baseURL }, request) => lowestOpenRouterEffort(await request(`${baseURL}/models`), model),
  // /api/show sits at the server root, not under the OpenAI-compatible /v1.
  ollama: async ({ model, baseURL }, request) =>
    lowestOllamaEffort(
      await request(`${baseURL.replace(/\/v1$/, "")}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      }),
    ),
};

/**
 * Returns `(agentProvider) => Promise<effort | undefined>`, asking each
 * provider once per model and base URL for the life of the process; a failed
 * lookup is asked again on the next turn.
 * @param {{ fetchFn?: (url: string, init?: any) => Promise<any>, timeoutMs?: number, log?: { log: (message: string) => void, warn: (message: string) => void } }} [options]
 */
export function createReasoningEffortLookup({ fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, log = console } = {}) {
  const cache = new Map();

  async function request(url, init = {}) {
    const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function lookUp(agentProvider, forget) {
    const { provider, model } = agentProvider;
    try {
      const effort = await LOOKUPS[provider](agentProvider, request);
      log.log(`[micdraw] ${provider} ${model}: reasoning effort ${effort ?? "not sent"}`);
      return effort;
    } catch (error) {
      // Ask again next turn: Ollama may start later, or the key get fixed.
      forget();
      const fallback = provider === "xai" ? XAI_DOCUMENTED_LOWEST[model] : undefined;
      log.warn(`[micdraw] could not look up ${model} on ${provider} (${error.message}); reasoning effort ${fallback ?? "not sent"}`);
      return fallback;
    }
  }

  return (agentProvider) => {
    if (!LOOKUPS[agentProvider.provider]) return Promise.resolve(undefined);
    const key = `${agentProvider.provider} ${agentProvider.baseURL} ${agentProvider.model}`;
    if (!cache.has(key)) cache.set(key, lookUp(agentProvider, () => cache.delete(key)));
    return cache.get(key);
  };
}

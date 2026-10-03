import { SUPPORTED_LANGUAGES } from "./local-models.js";

// Languages each transcription provider offers. Local engines cover the ones
// that have a local model (src/local-models.js). OpenAI Realtime
// (gpt-live-transcribe) and Deepgram (nova-3) cover the approved cloud list;
// checked against their docs on 2026-10-03, not verified live (#14).
export const CLOUD_LANGUAGES = Object.freeze(["en", "ru", "de", "fr", "es", "zh", "pt", "it", "ja", "ko", "hi", "uk", "pl", "tr", "nl", "ar"]);

// Deepgram nova-3 can also transcribe a mix of English, Spanish, French,
// German, Hindi, Russian, Portuguese, Japanese, Italian and Dutch in one
// stream, for example Russian speech with English terms.
export const MIXED_LANGUAGES = "multi";

const DEEPGRAM_LANGUAGES = Object.freeze([...CLOUD_LANGUAGES, MIXED_LANGUAGES]);

export function transcriptionLanguages(provider) {
  if (provider === "openai") return CLOUD_LANGUAGES;
  if (provider === "deepgram") return DEEPGRAM_LANGUAGES;
  return SUPPORTED_LANGUAGES;
}

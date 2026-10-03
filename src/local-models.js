// Local speech-to-text models. The "local" transcription provider picks one by
// language and platform: Moonshine on macOS for English (it commits a phrase
// fastest), sherpa-onnx streaming models everywhere else. Order matters: the
// first model that runs on the platform is the default for its language.
// Changing a sherpa model means updating its revision, sizes and SHA-256 together.
// Reviewed 2026-10-03 (#28): no newer English Moonshine than medium and no
// newer Kroko or Vosk builds, so the defaults stay. Other candidates wait for
// a measurement: T-One for Russian (#15), NVIDIA Nemotron for English (#49).
export const SUPPORTED_LANGUAGES = Object.freeze(["en", "ru"]);

const ALL_PLATFORMS = ["darwin", "linux", "win32"];

export const LOCAL_MODELS = Object.freeze([
  { id: "moonshine-medium", engine: "moonshine", language: "en", label: "Moonshine medium", platforms: ["darwin"], moonshineModel: "medium" },
  { id: "moonshine-small", engine: "moonshine", language: "en", label: "Moonshine small", platforms: ["darwin"], moonshineModel: "small" },
  { id: "moonshine-tiny", engine: "moonshine", language: "en", label: "Moonshine tiny", platforms: ["darwin"], moonshineModel: "tiny" },
  {
    id: "kroko-en-2025-08-06",
    engine: "sherpa",
    language: "en",
    label: "Kroko (sherpa-onnx)",
    license: "CC-BY-SA",
    source: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06",
    revision: "572aaf4e2e0c603c3fc2a574d096e755a178faa1",
    files: {
      encoder: { name: "encoder.onnx", size: 70092599, sha256: "d4881c57449d581e0770fd53fa66c2fdc6cd167d92ece7c715e603defc96d9d4" },
      decoder: { name: "decoder.onnx", size: 617488, sha256: "455ba38466fce8d5a57e7db68a323b684079ca4d9e1dd93a740d9b2429aae3b1" },
      joiner: { name: "joiner.onnx", size: 336817, sha256: "d406f616736350e2a7df3e39398b78eb2fc1a2ca6973a19d3853fa3227e25b52" },
      tokens: { name: "tokens.txt", size: 6310, sha256: "396dbeb5f4858875690716084f54e90d339679d0ba3e6b5b584f3d7589254d2d" },
    },
  },
  {
    id: "vosk-small-ru-2025-08-16",
    engine: "sherpa",
    language: "ru",
    label: "Vosk small (sherpa-onnx)",
    license: "Apache-2.0",
    source: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16",
    revision: "31fa603e4f31279c6e1f7600fed13dc4312663ab",
    files: {
      encoder: { name: "encoder.int8.onnx", size: 26214060, sha256: "e0db705e94ec35d803b1df4f40cda23d064e1142977c80ab288430b109777a9d" },
      decoder: { name: "decoder.onnx", size: 2093080, sha256: "89b3088a9e20e1ef7f2e85ce1a3478afe6a9c4ac57369cabcc4beb8e95328ea0" },
      joiner: { name: "joiner.int8.onnx", size: 259417, sha256: "b55784b071ab7512eab4c7c44e4f5478284ef33c83562cc6a249b972515a31e5" },
      tokens: { name: "tokens.txt", size: 6388, sha256: "93bbbc0bae6b78c0bbb743d4aa9fded3bb5ff3aac5f0200e3a769a5a05e0fdf6" },
    },
  },
]);

function runsOn(model, platform) {
  return (model.platforms ?? ALL_PLATFORMS).includes(platform);
}

export function localModelsFor({ language, platform }) {
  return LOCAL_MODELS.filter((model) => model.language === language && runsOn(model, platform));
}

export function resolveLocalModel({ language, platform, preferredId = undefined }) {
  const candidates = localModelsFor({ language, platform });
  if (candidates.length === 0) throw new Error(`No local speech model for language "${language}" on ${platform}.`);
  return candidates.find((model) => model.id === preferredId) ?? candidates[0];
}

export function modelFileUrl(model, file) {
  return `${model.source}/resolve/${model.revision}/${file.name}`;
}

export function localModelSummaries(platform) {
  return LOCAL_MODELS.filter((model) => runsOn(model, platform)).map((model) => ({
    id: model.id,
    label: model.label,
    language: model.language,
    engine: model.engine,
    downloadBytes: model.files ? Object.values(model.files).reduce((sum, file) => sum + file.size, 0) : null,
  }));
}

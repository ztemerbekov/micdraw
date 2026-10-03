// Local speech-to-text models. The "local" transcription provider picks one by
// language and platform: Moonshine on macOS for English (it commits a phrase
// fastest), sherpa-onnx streaming models everywhere else. Order matters: the
// first model that runs on the platform is the default for its language.
// Changing a sherpa model means updating its revision, sizes and SHA-256 together.
// Reviewed 2026-10-03 (#28): no newer English Moonshine than medium and no
// newer Kroko or Vosk builds, so the defaults stay. German, French, Spanish and
// Mandarin were measured on 40 FLEURS clips each (#13): WER 4.3%, 7.7% and 3.5%,
// and 11.7% by character for Mandarin.
export const SUPPORTED_LANGUAGES = Object.freeze(["en", "ru", "de", "fr", "es", "zh"]);

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
  {
    id: "kroko-de-2025-08-06",
    engine: "sherpa",
    language: "de",
    label: "Kroko (sherpa-onnx)",
    license: "CC-BY-SA",
    source: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-de-kroko-2025-08-06",
    revision: "887db3d083240198c2d2b99fb66cfcfe6948ced8",
    files: {
      encoder: { name: "encoder.onnx", size: 70091557, sha256: "6e83993d6967ec7a3498b055b7e85ace85b5d64d1b1e8773cb29a43a11f5edb5" },
      decoder: { name: "decoder.onnx", size: 617489, sha256: "94a29592b403c53fa2231b478637da1ab4abcef7f5e46e432098416a4a3ed562" },
      joiner: { name: "joiner.onnx", size: 336817, sha256: "28356bff070aea51ab1d725a3278e81d19f9300f860d3248a7014292264df15a" },
      tokens: { name: "tokens.txt", size: 5606, sha256: "86e8370994ff2c01149ba8c4f8709aa93cdc18914b27a717e291e96faf39a6eb" },
    },
  },
  {
    id: "kroko-fr-2025-08-06",
    engine: "sherpa",
    language: "fr",
    label: "Kroko (sherpa-onnx)",
    license: "CC-BY-SA",
    source: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-fr-kroko-2025-08-06",
    revision: "08b84b7b7cf519be9817e9c16919d96a7a8bad91",
    files: {
      encoder: { name: "encoder.onnx", size: 70092599, sha256: "e02facae1daf6f1f13da67ea3ace7c722516d0868d1768d78c0580bc22cc0c5b" },
      decoder: { name: "decoder.onnx", size: 617488, sha256: "6aed547570e3ab5afc05429a017cedd3a056c16df3baa5703f02461cefa25bac" },
      joiner: { name: "joiner.onnx", size: 336817, sha256: "a51eec759bcdcaae2614686fa2a8b57417b2d420dd55a5a5558b388d35a9b2b6" },
      tokens: { name: "tokens.txt", size: 5415, sha256: "fedfb9c844bfb2bf14171f8184863e3d617b815a8667bdd9fc9a3149fde73298" },
    },
  },
  {
    id: "kroko-es-2025-08-06",
    engine: "sherpa",
    language: "es",
    label: "Kroko (sherpa-onnx)",
    license: "CC-BY-SA",
    source: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-es-kroko-2025-08-06",
    revision: "20cf7a4921613397841d31168796cade5b866585",
    files: {
      encoder: { name: "encoder.onnx", size: 154878102, sha256: "2d9f5ef87d1a5257f8a6687e21501c56f3aa2fcbfcfab9364dcc4ce4e06ae81b" },
      decoder: { name: "decoder.onnx", size: 617488, sha256: "d4ce176b94b25f7acc88717bc3f704fcf5d6e131aaac2e0cabab3885541181ee" },
      joiner: { name: "joiner.onnx", size: 336817, sha256: "dae35df88d676e320fcdb99217328e66dcf722bf11b0f2459e14ddb5b982ded5" },
      tokens: { name: "tokens.txt", size: 6385, sha256: "1be5e0a58e05d06d327df4c6b7b5e4f8aba01da6981eb016fcaceafc6a56680f" },
    },
  },
  {
    // A CTC model: one model file instead of encoder, decoder and joiner. Its
    // checkpoint, csukuangfj/icefall-streaming-zipformer-small-ctc-zh-2025-04-01,
    // is Apache-2.0; the larger 2025-06-30 model was passed over because its
    // original weights are gated (#13).
    id: "zipformer-ctc-small-zh-2025-04-01",
    engine: "sherpa",
    language: "zh",
    label: "Zipformer small CTC (sherpa-onnx)",
    license: "Apache-2.0",
    source: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01",
    revision: "a5f60fe00dcfbaf68fcc1c6b5cf53061e144d6da",
    files: {
      model: { name: "model.int8.onnx", size: 26342340, sha256: "68c9c943840f7d9cf3e8a4970ba50f404feb5277f611fa82b7e72267786fa84a" },
      tokens: { name: "tokens.txt", size: 13366, sha256: "6fed8c6c248516f38e7faa19404b57413e8ce259f1cbc1fa4aebc86eac32fdfd" },
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

/** The total size of a model's files, in bytes. */
export function modelDownloadBytes(model) {
  return Object.values(model.files).reduce((sum, file) => sum + file.size, 0);
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
    downloadBytes: model.files ? modelDownloadBytes(model) : null,
  }));
}

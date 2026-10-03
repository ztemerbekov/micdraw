import { Worker } from "node:worker_threads";

import { ensureModelFiles } from "./model-download.js";

// The browser streams 24 kHz PCM16; sherpa-onnx resamples to its 16 kHz features.
const SAMPLE_RATE = 24000;
const ENDPOINT_SILENCE_SECONDS = 0.8;

function defaultCreateWorker(workerData) {
  return new Worker(new URL("./sherpa-worker.js", import.meta.url), { workerData });
}

export function createSherpaTranscription({
  sendTranscript,
  queueTranscript,
  options,
  createWorker = defaultCreateWorker,
  ensureModel = ensureModelFiles,
}) {
  const model = options.localModel;
  let worker = null;
  let closed = false;
  let readyPromise = null;

  function handleMessage(message) {
    if (message.type === "transcript:partial") {
      sendTranscript({ type: "transcript:partial", text: message.text });
    } else if (message.type === "transcript:committed") {
      sendTranscript({ type: "transcript:committed", text: message.text });
      queueTranscript(message.text);
    } else if (message.type === "error") {
      sendTranscript({ type: "error", message: `Local transcription error: ${message.message}` });
    }
  }

  function reportProgress() {
    let reported = 0;
    return ({ receivedBytes, totalBytes }) => {
      const percent = Math.floor((receivedBytes / totalBytes) * 10) * 10;
      if (percent > reported) {
        reported = percent;
        options.onStatus?.(`Downloading ${model.label}: ${percent}%`);
      }
    };
  }

  async function start() {
    const files = await ensureModel(model, { modelsDir: options.modelsDir, onProgress: reportProgress() });
    if (closed) return;
    worker = createWorker({ files, endpointSilenceSeconds: ENDPOINT_SILENCE_SECONDS });
    await new Promise((resolve, reject) => {
      worker.on("message", (message) => (message.type === "ready" ? resolve(undefined) : handleMessage(message)));
      worker.once("error", reject);
    });
    worker.on("error", (error) => {
      const reason = error instanceof Error ? error.message : String(error);
      sendTranscript({ type: "error", message: `Local transcription failed: ${reason}` });
    });
  }

  return {
    ready: () => (readyPromise ??= start()),
    sendAudio: (audio) => {
      if (!worker) return;
      const bytes = Buffer.from(audio, "base64");
      const pcm = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      worker.postMessage({ type: "audio", pcm, sampleRate: SAMPLE_RATE }, [pcm]);
    },
    stop: () => worker?.postMessage({ type: "stop" }),
    close: () => {
      closed = true;
      worker?.terminate();
      worker = null;
    },
    // Staging-board keywords would need sherpa hotwords; not wired up yet.
    setSessionContext: () => {},
  };
}

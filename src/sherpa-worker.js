// Runs one sherpa-onnx streaming recognizer off the main thread, so decoding
// never stalls the server's WebSocket and HTTP handling.
import { parentPort, workerData } from "node:worker_threads";

import { createSherpaSession, sherpaRecognizerConfig } from "./sherpa-session.js";

const { files, endpointSilenceSeconds } = workerData;
const { default: sherpaOnnx } = await import("sherpa-onnx-node");

const recognizer = new sherpaOnnx.OnlineRecognizer(sherpaRecognizerConfig(files, endpointSilenceSeconds));

const session = createSherpaSession(recognizer, {
  onPartial: (text) => parentPort.postMessage({ type: "transcript:partial", text }),
  onCommitted: (text) => parentPort.postMessage({ type: "transcript:committed", text }),
});

parentPort.on("message", (message) => {
  try {
    if (message.type === "audio") {
      const pcm = new Int16Array(message.pcm);
      session.acceptWaveform(Float32Array.from(pcm, (sample) => sample / 32768), message.sampleRate);
    } else if (message.type === "stop") {
      session.stop();
    }
  } catch (error) {
    parentPort.postMessage({ type: "error", message: error.message });
  }
});

parentPort.postMessage({ type: "ready" });

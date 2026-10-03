import assert from "node:assert/strict";
import { test } from "node:test";

import { createSherpaSession, sherpaRecognizerConfig } from "../src/sherpa-session.js";

// Each acceptWaveform call advances one scripted step: the text sherpa would
// report after that chunk and whether its endpoint detector fired.
function scriptedRecognizer(steps) {
  let step = -1;
  const recognizer = {
    streams: [],
    resets: 0,
    createStream() {
      const stream = {
        finished: false,
        acceptWaveform: () => {
          step += 1;
        },
        inputFinished() {
          this.finished = true;
        },
      };
      recognizer.streams.push(stream);
      return stream;
    },
    isReady: () => false,
    decode: () => {},
    getResult: () => ({ text: steps[step]?.text ?? "" }),
    isEndpoint: () => Boolean(steps[step]?.endpoint),
    reset() {
      recognizer.resets += 1;
    },
  };
  return recognizer;
}

function collect() {
  const events = [];
  return {
    events,
    onPartial: (text) => events.push(["partial", text]),
    onCommitted: (text) => events.push(["committed", text]),
  };
}

const chunk = new Float32Array(160);

test("reports growing text as partials and commits it at an endpoint", () => {
  const recognizer = scriptedRecognizer([{ text: "hel" }, { text: "hello" }, { text: "hello" }, { text: "hello world", endpoint: true }]);
  const sink = collect();
  const session = createSherpaSession(recognizer, sink);

  for (let i = 0; i < 4; i += 1) session.acceptWaveform(chunk, 24000);

  assert.deepEqual(sink.events, [
    ["partial", "hel"],
    ["partial", "hello"],
    ["partial", "hello world"],
    ["committed", "hello world"],
  ]);
  assert.equal(recognizer.resets, 1);
});

test("an endpoint on silence commits nothing", () => {
  const recognizer = scriptedRecognizer([{ text: "", endpoint: true }]);
  const sink = collect();
  createSherpaSession(recognizer, sink).acceptWaveform(chunk, 24000);
  assert.deepEqual(sink.events, []);
  assert.equal(recognizer.resets, 1);
});

test("stop commits the unfinished phrase and starts a fresh stream", () => {
  const recognizer = scriptedRecognizer([{ text: "half a" }, { text: "half a sentence" }]);
  const sink = collect();
  const session = createSherpaSession(recognizer, sink);

  session.acceptWaveform(chunk, 24000);
  session.acceptWaveform(chunk, 24000);
  session.stop();

  assert.deepEqual(sink.events.at(-1), ["committed", "half a sentence"]);
  assert.equal(recognizer.streams[0].finished, true);
  assert.equal(recognizer.streams.length, 2);
});

test("the recognizer config runs a transducer from its three files and a CTC model from one", () => {
  const transducer = sherpaRecognizerConfig({ encoder: "e.onnx", decoder: "d.onnx", joiner: "j.onnx", tokens: "t.txt" }, 0.8);
  assert.deepEqual(transducer.modelConfig.transducer, { encoder: "e.onnx", decoder: "d.onnx", joiner: "j.onnx" });
  assert.equal(transducer.modelConfig.zipformer2Ctc, undefined);
  assert.equal(transducer.rule2MinTrailingSilence, 0.8);

  const ctc = sherpaRecognizerConfig({ model: "m.int8.onnx", tokens: "t.txt" }, 0.8);
  assert.deepEqual(ctc.modelConfig.zipformer2Ctc, { model: "m.int8.onnx" });
  assert.equal(ctc.modelConfig.transducer, undefined);
  assert.equal(ctc.modelConfig.tokens, "t.txt");
});

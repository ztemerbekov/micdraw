// The recognizer config for a model's downloaded files: a transducer has an
// encoder, a decoder and a joiner; a CTC model has a single model file.
export function sherpaRecognizerConfig(files, endpointSilenceSeconds) {
  const model = files.model
    ? { zipformer2Ctc: { model: files.model } }
    : { transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner } };
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { ...model, tokens: files.tokens, numThreads: 2, provider: "cpu", debug: 0 },
    decodingMethod: "greedy_search",
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: endpointSilenceSeconds,
    rule3MinUtteranceLength: 30,
  };
}

// One continuous sherpa-onnx streaming session: feeds audio, reports the text
// as it grows, and commits a phrase when sherpa's endpoint detector fires.
export function createSherpaSession(recognizer, { onPartial, onCommitted }) {
  let stream = recognizer.createStream();
  let lastText = "";

  function decodeAvailable() {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    return recognizer.getResult(stream).text.trim();
  }

  function commit(text) {
    if (text) onCommitted(text);
    lastText = "";
  }

  return {
    acceptWaveform(samples, sampleRate) {
      stream.acceptWaveform({ samples, sampleRate });
      const text = decodeAvailable();
      if (text && text !== lastText) {
        lastText = text;
        onPartial(text);
      }
      if (recognizer.isEndpoint(stream)) {
        commit(text);
        recognizer.reset(stream);
      }
    },
    // Stop: finish whatever was said and start a fresh stream for the next session.
    stop() {
      stream.inputFinished();
      commit(decodeAvailable());
      stream = recognizer.createStream();
    },
  };
}

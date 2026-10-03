# Local multilingual streaming transcription

Status: approved 2026-10-03. Measurements behind the decisions: [#3](https://github.com/ztemerbekov/micdraw/issues/3).

## Goal

Speech is transcribed on the user's machine, in their language, with text appearing while they speak. English is the default language and Russian works out of the box. Cloud engines (OpenAI Realtime, Deepgram) stay available.

## Decisions

- **Streaming only.** Every local model shows partial text while the speaker talks and commits a phrase when they pause. Non-streaming models are out of scope.
- **Language is a transcription setting.** `transcription.language`, default `"en"`. Supported now: `"en"`, `"ru"`.
- **A new provider, `"local"`, is the default for new installs.** It picks a model by language and platform from a catalog:

  | Language | macOS | Linux, Windows |
  | --- | --- | --- |
  | English | Moonshine medium (the existing sidecar) | Kroko via sherpa-onnx |
  | Russian | Vosk small via sherpa-onnx | Vosk small via sherpa-onnx |

  Moonshine is the macOS default for English because it commits a phrase about 1.2 s sooner than Kroko at similar accuracy (6.0% vs 6.9% WER on the #3 test set).
- **The user can pick another local model for a language** (`transcription.local.models[language]`), for example Moonshine small or Kroko on macOS. A pick that is not available for the language or platform falls back to the default.
- **Existing settings keep working.** The old provider value `"moonshine"` still means the Moonshine sidecar with `transcription.moonshine.model`, exactly as before.

## Catalog

`src/local-models.js` lists every local model: id, engine (`moonshine` or `sherpa`), language, label, platforms, and for sherpa models the Hugging Face source pinned to a commit with each file's size and SHA-256.

| Id | Engine | Language | Files | License |
| --- | --- | --- | --- | --- |
| `moonshine-medium`, `moonshine-small`, `moonshine-tiny` | Moonshine sidecar | en | managed by the sidecar | MIT |
| `kroko-en-2025-08-06` | sherpa-onnx | en | 71 MB, [csukuangfj/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06) @ `572aaf4e` | CC-BY-SA (Kroko community model) |
| `vosk-small-ru-2025-08-16` | sherpa-onnx | ru | 29 MB, [csukuangfj/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16) @ `31fa603e` | Apache-2.0 |

Adding a language means adding a catalog entry and the language code.

## sherpa-onnx engine

- Same contract as the other engines: `ready()`, `sendAudio(base64Pcm16)`, `stop()`, `close()`. Partial text goes to the page as `transcript:partial`; a committed phrase goes to the page as `transcript:committed` and to the agent queue.
- Runs `sherpa-onnx-node`'s `OnlineRecognizer` in a worker thread so decoding never blocks the server.
- Audio arrives as 24 kHz PCM16 from the browser; sherpa-onnx resamples to 16 kHz.
- Endpoint detection is on: a phrase is committed after 0.8 s of trailing silence. `stop()` commits whatever was said and starts a fresh stream.

## Model download

- Files download on first use into `~/.config/micdraw/models/<model id>/`, straight from Hugging Face at the pinned commit, with no archives to unpack.
- Each file is written to `<name>.part`, hashed while streaming, and renamed only if size and SHA-256 match. A `.complete` marker holding the revision makes later starts skip the download.
- Progress is reported through the existing status messages (CLI output).

## UI

The STT editor offers **Local**, **OpenAI Realtime** and **Deepgram**. For Local it shows a language select (English, Русский) and a model select listing the catalog models for that language on the server's platform, with the download size for models that need one. `/api/config` provides the catalog summary and the language list.

## Out of scope here

- Download progress in the UI and a non-blocking first download (next PR).
- Language for OpenAI Realtime and Deepgram (the PR after).
- Hotwords from the staging board for sherpa-onnx models.
- Removing the Moonshine sidecar.

## Testing

- Catalog resolution, settings validation and engine selection: unit tests.
- Downloader: fake `fetch`, real temp directories, checksum mismatch, resume via the marker.
- Streaming session logic: a fake recognizer.
- Engine: a fake worker.
- End to end, by hand before merging: start the server with `local` + `ru`, stream a Russian recording over the WebSocket in real time, and check that partial and committed messages arrive.

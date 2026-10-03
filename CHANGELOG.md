# Changelog

## Unreleased

- Renamed the project to Mic Draw (npm package and command: `micdraw`).
- Removed the inherited release-please and no-mistakes automation.
- Local multilingual transcription: the new default `local` provider streams English (Moonshine on macOS, Kroko via sherpa-onnx elsewhere) and Russian (Vosk via sherpa-onnx); language and model are chosen in the Voice panel.
- Faster drawing: when a label would overflow its shape, the app grows the shape itself instead of sending the agent on another edit pass, and it measures labels with Excalidraw's own 5 px padding.
- The board shows an agent edit while the agent is still writing it: each element appears once it is complete, and the view follows elements drawn off-screen. Codex provider only for now.
- OpenAI Realtime transcription now defaults to `gpt-live-transcribe`, and its menu drops `whisper-1`, `gpt-4o-transcribe` and `gpt-4o-mini-transcribe`, which OpenAI no longer serves for realtime transcription; a saved pick of one of them switches on start. The Ollama model field suggests `qwen3.6`. Chosen from the vendors' docs, not verified live.
- OpenAI Realtime and Deepgram transcribe in 16 languages, chosen in the Voice panel, and Deepgram adds Mixed languages for talks that switch between them. From the vendors' docs, not verified live.
- The agent's debug and cache logs roll over to `<name>.1` past 10 MB, and the test suite no longer writes into `~/.config/micdraw/logs`.
- The default agent model is now GPT-6 Luna (`gpt-6-luna`; Codex: `gpt-6-luna-fast`), and the settings menus offer the GPT-6 models. GPT-5.5 leaves Codex on 2026-10-14: a saved Codex model that Codex no longer serves switches to GPT-6 Luna on start.
- An agent turn now ends as soon as an edit lands without warnings, instead of asking the model for a closing "DONE". That request took 1.5-3.3 s per turn while the next phrase waited.

Versions up to 0.1.8 were released as autopreso. See the [autopreso changelog](https://github.com/kunchenguid/autopreso/blob/main/CHANGELOG.md).

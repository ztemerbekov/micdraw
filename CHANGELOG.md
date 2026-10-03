# Changelog

## 0.2.1 (2026-10-03)

- When an edit leaves two elements with the same id, the agent gets a warning naming their lines and fixes it on its next step, instead of leaving a stray copy on the board.
- xAI works as an agent provider (Grok, `grok-4.3` by default) and as a speech engine (`grok-voice-transcribe-2.0`, 14 of the 16 cloud languages), with one key for both. Ported from autopreso#24 by Julien Talbot; checked against xAI's docs, not verified live.

## 0.2.0 (2026-10-03)

The first release as Mic Draw.

- Renamed the project to Mic Draw (npm package and command: `micdraw`).
- Replaced the inherited release-please and no-mistakes automation: publishing a GitHub Release now publishes the package to npm.
- Local multilingual transcription: the new default `local` provider streams English (Moonshine on macOS, Kroko via sherpa-onnx elsewhere) and Russian (Vosk via sherpa-onnx); language and model are chosen in the Voice panel.
- Faster drawing: when a label would overflow its shape, the app grows the shape itself instead of sending the agent on another edit pass, and it measures labels with Excalidraw's own 5 px padding.
- OpenAI Realtime transcription now defaults to `gpt-live-transcribe`, and its menu drops `whisper-1`, `gpt-4o-transcribe` and `gpt-4o-mini-transcribe`, which OpenAI no longer serves for realtime transcription; a saved pick of one of them switches on start. The Ollama model field suggests `qwen3.6`. Chosen from the vendors' docs, not verified live.
- OpenAI Realtime and Deepgram transcribe in 16 languages, chosen in the Voice panel, and Deepgram adds Mixed languages for talks that switch between them. From the vendors' docs, not verified live.
- The agent's debug and cache logs roll over to `<name>.1` past 10 MB, and the test suite no longer writes into `~/.config/micdraw/logs`.
- Session cost counts every step of an agent turn, not just the last one, and no longer bills reasoning tokens twice.
- The page no longer sends the agent's own board back as a user drawing, so the agent keeps its compact elements instead of Excalidraw's expanded ones.
- The agent uses GPT-6.1 Sol (`gpt-6.1-sol`), in Fast mode on Codex. It is the only model the OpenAI and Codex menus offer: GPT-6 Sol and GPT-6 Luna reply sooner, but their drawings fell short. Fast mode is its own switch, and an old saved name like `gpt-5.5-fast` means Fast mode on. A saved pick of GPT-6 Sol or Luna, or of a model Codex no longer serves (GPT-5.5 leaves it on 2026-10-14), switches to GPT-6.1 Sol on start in the same mode. The reasoning effort menu runs from `low` to `max`; a saved `none`, which GPT-6.1 Sol rejects, switches to `low`.
- An agent turn now ends as soon as an edit lands without warnings, instead of asking the model for a closing "DONE". That request took 1.5-3.3 s per turn while the next phrase waited.

Versions up to 0.1.8 were released as autopreso. See the [autopreso changelog](https://github.com/kunchenguid/autopreso/blob/main/CHANGELOG.md).

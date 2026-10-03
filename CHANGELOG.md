# Changelog

## Unreleased

- Renamed the project to Mic Draw (npm package and command: `micdraw`).
- Removed the inherited release-please and no-mistakes automation.
- Local multilingual transcription: the new default `local` provider streams English (Moonshine on macOS, Kroko via sherpa-onnx elsewhere) and Russian (Vosk via sherpa-onnx); language and model are chosen in the Voice panel.
- Faster drawing: when a label would overflow its shape, the app grows the shape itself instead of sending the agent on another edit pass, and it measures labels with Excalidraw's own 5 px padding.
- An agent turn now ends as soon as an edit lands without warnings, instead of asking the model for a closing "DONE". That request took 1.5-3.3 s per turn while the next phrase waited.

Versions up to 0.1.8 were released as autopreso. See the [autopreso changelog](https://github.com/kunchenguid/autopreso/blob/main/CHANGELOG.md).

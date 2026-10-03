<h1 align="center">Mic Draw</h1>

<p align="center">
  <a href="https://github.com/ztemerbekov/micdraw/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ztemerbekov/micdraw/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS-blue?style=flat-square" />
</p>

<h3 align="center">You talk. The whiteboard draws.</h3>

> [!WARNING]
> Mic Draw is in **alpha** and under active development. Expect rough edges, breaking changes, and the occasional weird drawing. Bug reports welcome.

Mic Draw runs a local web app with a live Excalidraw canvas and a listening agent.
You speak; transcripts stream to a model; the model draws, labels, and rearranges the whiteboard in real time.
Stage a few seed elements, hit start, and present.

- **Hands free** - your speech drives an agent that edits an Excalidraw scene as you talk, no clicking required.
- **Bring your own model** - use your OpenAI API key or Codex subscription. Mic Draw itself is free and open source.
- **Can run locally** - use Moonshine for transcription and Ollama for the agent and you get a fully local setup.

Mic Draw is based on [autopreso](https://github.com/kunchenguid/autopreso) by Kun Chen.

## Quick Start

You need Node.js 24 or later.

```sh
npx micdraw                  # boots the server, opens the browser
```

`npm install -g micdraw` installs the `micdraw` command instead. To run from source, see [Development](#development).

Then, in the browser:

1. Drop reference materials onto the staging canvas (title, agenda, etc).
2. Pick your microphone, transcription model, agent model, and optional Agent instructions.
3. Click "Start Preso" and start talking.

## How It Works

```
  ┌──────────┐   audio    ┌──────────────┐   text   ┌──────────────┐
  │   mic    │──────────► │     STT      │────────► │  whiteboard  │
  │ (browser)│   24kHz    │ local or     │ chunks   │    agent     │
  └──────────┘            │ cloud        │          │ (OpenAI /    │
                          └──────────────┘          │  Codex /     │
                                                    │  Ollama)     │
                                                    └──────┬───────┘
                                                           │ tool calls
                                                           ▼
                                                  ┌────────────────┐
                                                  │   Excalidraw   │
                                                  │  scene (live)  │
                                                  └────────────────┘
```

- **Two modes** - "staging" lets you sketch seed content client-side; "live" hands the canvas over to the agent, biases OpenAI Realtime transcription toward staging text and labels, and starts streaming transcripts.
- **Local server** - the Express + WebSocket server binds to 127.0.0.1 and only answers its own page. Requests from other sites open in your browser are rejected.
- **Persistent settings** - models, API keys, STT engine choices, and Agent instructions live in `~/.config/micdraw/settings.json` and survive restarts.
- **Warmup loop** - after you hit start the agent primes itself against your staging content and Agent instructions so the first sentence you say doesn't get a cold model.

## CLI Reference

| Command      | Description                                  |
| ------------ | -------------------------------------------- |
| `micdraw`    | Start the local server and open the browser. |
| `micdraw -h` | Show help.                                   |

From a source checkout, `npm start` runs the same command.

### Flags

| Flag         | Description                                   |
| ------------ | --------------------------------------------- |
| `--no-open`  | Start the server without opening the browser. |
| `-h, --help` | Show help.                                    |

## Configuration

Settings persist at `~/.config/micdraw/settings.json` and are managed from the in-app status panel.
Agent instructions are saved automatically from staging, can be up to 100,000 characters, and take effect on the next Start Preso.
The live Session cost card estimates agent token costs and OpenAI Realtime audio costs for the current presentation, resetting on Start Preso or session reset.
OpenAI prices use the built-in October 2026 rate table; local providers show `$0.0000`, Codex shows token volume because it routes through your subscription, and unknown models show `n/a`.

### Defaults on first run

When no settings file exists, Mic Draw picks providers based on what it finds in your environment:

| You have...                                | Agent provider                     | Transcription                   |
| ------------------------------------------ | ---------------------------------- | ------------------------------- |
| Nothing                                    | OpenAI `gpt-6.1-sol` (needs a key) | Local, English                  |
| `OPENAI_API_KEY` in env                    | OpenAI `gpt-6.1-sol`               | OpenAI Realtime                 |
| Codex CLI signed in (`~/.codex/auth.json`) | Codex `gpt-6.1-sol`, Fast mode     | Local, English                  |
| Codex CLI signed in + `OPENAI_API_KEY`     | Codex `gpt-6.1-sol`, Fast mode     | OpenAI Realtime                 |
| `OLLAMA_MODEL` set                         | Ollama (your model)                | Local, English                  |
| `OPENROUTER_API_KEY` in env                | OpenRouter `x-ai/grok-4.20`        | (unchanged by this key)         |
| `DEEPGRAM_API_KEY` in env                  | (unchanged by this key)            | Deepgram `nova-3`               |
| `XAI_API_KEY` in env                       | xAI `grok-4.3`                     | xAI `grok-voice-transcribe-2.0` |

Codex runs in OpenAI's Fast mode by default (the **Fast mode** switch in the agent settings): replies come sooner, but they use your ChatGPT plan 2.5x faster. For OpenAI and Codex the agent settings offer one model, GPT-6.1 Sol: GPT-6 Sol and GPT-6 Luna reply sooner, but their drawings fell short. A saved pick of either, or of a model Codex no longer serves (GPT-5.5 leaves it on 2026-10-14), switches to GPT-6.1 Sol on start, and a saved reasoning effort of `none`, which GPT-6.1 Sol rejects, switches to `low`.

Auto-detection precedence: **`OPENROUTER_API_KEY` wins over Codex CLI auth wins over `OLLAMA_MODEL` wins over `XAI_API_KEY` wins over `OPENAI_API_KEY`** for the agent. For transcription, **`DEEPGRAM_API_KEY` wins over `OPENAI_API_KEY` wins over `XAI_API_KEY`**, otherwise local. After first run, this auto-detection no longer applies - change providers from the in-app status panel.

### Environment variables

Provider variables only seed `settings.json` on first run. Once the file exists, they're ignored - edit the file or use the in-app panel. Log path variables are read on each process start.

| Variable              | Purpose                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `PORT`                | Port to listen on. Default: `3210`.                                                                                   |
| `OPENAI_API_KEY`      | Seeds the OpenAI key for both agent and Realtime STT.                                                                 |
| `OPENAI_MODEL`        | Seeds the OpenAI agent model.                                                                                         |
| `OPENAI_BASE_URL`     | Seeds the OpenAI agent API base URL.                                                                                  |
| `CODEX_MODEL`         | Seeds the Codex model.                                                                                                |
| `OLLAMA_MODEL`        | Seeds the Ollama model.                                                                                               |
| `DEEPGRAM_API_KEY`    | Seeds the Deepgram key (STT only, separate from OpenAI's).                                                            |
| `DEEPGRAM_MODEL`      | Seeds the Deepgram model. Default: `nova-3`.                                                                          |
| `OPENROUTER_API_KEY`  | Seeds the OpenRouter key (agent only).                                                                                |
| `OPENROUTER_MODEL`    | Seeds the OpenRouter agent model. Default: `x-ai/grok-4.20`.                                                          |
| `OPENROUTER_BASE_URL` | Seeds the OpenRouter API base URL.                                                                                    |
| `XAI_API_KEY`         | Seeds the xAI key for both agent and speech-to-text.                                                                  |
| `XAI_MODEL`           | Seeds the xAI agent model. Default: `grok-4.3`.                                                                       |
| `XAI_BASE_URL`        | Seeds the xAI API base URL.                                                                                           |
| `MICDRAW_CACHE_LOG`   | Cache usage log path. Default: `~/.config/micdraw/logs/cache.log`.                                                    |
| `MICDRAW_DEBUG_LOG`   | Agent debug log path. Default: `~/.config/micdraw/logs/debug.log`. Each log moves to `<name>.1` once it passes 10 MB. |

Local transcription runs on your machine on macOS, Linux and Windows; see [Local transcription](#local-transcription) for languages, models and where they are stored.

## Local transcription

**Local (this computer)** is the default speech engine. It streams: text appears while you speak, and a phrase goes to the agent when you pause. Local engines process audio on your machine; the only network traffic is a one-time model download. Pick the language and model in the Voice panel. English is the default.

| Language | macOS | Linux, Windows |
| --- | --- | --- |
| English | Moonshine medium | Kroko (sherpa-onnx) |
| Russian | Vosk small (sherpa-onnx) | Vosk small (sherpa-onnx) |

On macOS you can also pick Moonshine small or tiny, or Kroko. Moonshine is the macOS default for English because it finishes a phrase about a second sooner at similar accuracy; the measurements are in [#3](https://github.com/ztemerbekov/micdraw/issues/3).

sherpa-onnx models download once, on first use, from Hugging Face at a pinned commit, and every file is checked against its SHA-256 before it is used. They are stored in `~/.config/micdraw/models/`. The Voice row shows the download progress, and the previous model keeps transcribing until the new one is ready.

| Model | Size | License | Source |
| --- | --- | --- | --- |
| Kroko English streaming zipformer | 71 MB | CC-BY-SA (Kroko community model) | [Banafo/Kroko-ASR](https://huggingface.co/Banafo/Kroko-ASR), packaged for sherpa-onnx as [csukuangfj/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06) |
| Vosk small Russian streaming zipformer | 29 MB | Apache-2.0 | [alphacep/vosk-model-small-streaming-ru](https://huggingface.co/alphacep/vosk-model-small-streaming-ru), packaged for sherpa-onnx as [csukuangfj/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16) |

Moonshine runs as a native sidecar on `darwin-arm64` and `darwin-x64`. For now these are the sidecar builds published by autopreso (`@autopreso/moonshine-darwin-*`).

## Languages in the cloud

OpenAI Realtime and Deepgram transcribe 16 languages: English, Russian, German, French, Spanish, Mandarin Chinese, Portuguese, Italian, Japanese, Korean, Hindi, Ukrainian, Polish, Turkish, Dutch and Arabic. Pick one in the Voice panel; the engine gets it as a hint (`languages` for OpenAI `gpt-live-transcribe`, `language` for Deepgram). Deepgram also offers **Mixed languages** (`multi`) for a talk that switches between English, Spanish, French, German, Hindi, Russian, Portuguese, Japanese, Italian and Dutch, such as Russian with English terms. OpenAI `gpt-realtime-whisper` takes no language hint and detects the language itself. xAI offers the same languages except Mandarin Chinese and Ukrainian, which its docs do not list.

These settings follow the vendors' documentation and have not been verified live yet.

## Deepgram transcription

Deepgram is a third speech engine alongside Moonshine and OpenAI Realtime. It is a hosted
WebSocket service, so it needs no native sidecar — it is the practical streaming option on
Linux and Windows, where Moonshine does not ship.

Pick **Deepgram** in the STT panel, paste a Deepgram API key, and choose a model
(`nova-3` by default). The key is stored under `apiKeys.deepgram`, separate from the OpenAI
key, so speech and the agent can be billed to different accounts. As with every key, the
browser is only ever told *whether* one is configured.

**Key terms.** `nova-3` accepts `keyterm` hints, which is how a proper noun the model has
never seen gets spelled the way you spell it. Two sources are merged:

- the comma-separated **Key terms** field in the STT panel (`transcription.deepgram.keyterms`),
- every text element on the staging canvas, picked up automatically at Start Preso.

So putting your product names and jargon on the staging board is already enough to bias the
transcript. Key terms are part of the connection URL, so changing them reconnects the socket;
this only happens between sessions, when no audio is in flight.

**How turns are decided.** Interim results stream to the transcript panel as partials — each
one restates the segment from its start rather than appending. A segment Deepgram marks
`is_final` is settled text; the accumulated text is committed as one agent turn when Deepgram
reports `speech_final` (its endpointer saw 1000 ms of silence), on an `UtteranceEnd` backstop,
or when you click Stop. That 1000 ms matches the OpenAI provider's quiet window, so both
engines hand the whiteboard agent turns of about the same size.

Three details that are easy to get wrong and expensive to debug:

- **Encoding is declared, not sniffed.** The browser streams PCM16LE mono at 24 kHz, and the
  socket says so (`encoding=linear16&sample_rate=24000`). Raw PCM has no container, so a wrong
  value here does not error — it transcribes a chipmunk.
- **The socket is pinged every 5 s.** Deepgram hangs up an idle connection after about 10 s,
  and a presenter pausing to think is normal. Without the `KeepAlive` the socket dies mid-pause
  and the rest of the talk vanishes with no error anywhere.
- **`CloseStream` goes first, then the close.** On teardown the provider asks Deepgram to flush
  and waits for the tail before dropping the socket. Reversed, the last words of the last
  sentence die inside Deepgram. Stop uses `Finalize` for the same reason, without closing.

Deepgram streaming is priced per minute of audio in the session cost card; a model that is not
in the built-in rate table shows `n/a` rather than a guessed number.

## OpenRouter agent (Grok and others)

**OpenRouter** is an agent provider alongside OpenAI, Codex and Ollama. It fronts many vendors
behind an OpenAI-shaped API — including the `/responses` endpoint this app already speaks — so
it is the same code path with a different base URL, key and model id.

Pick **OpenRouter** in the agent panel, paste an OpenRouter key, and type a model id. The
default is `x-ai/grok-4.20`; any OpenRouter model that supports function calling will work, and
the field is free text because the catalogue changes faster than any list here could.

Two deliberate differences from the OpenAI provider:

- **No `reasoningEffort` is sent.** It is an OpenAI-specific provider option; forwarding it to
  an arbitrary OpenRouter model is ignored at best and a 400 at worst. The setting stays in the
  OpenAI panel where it belongs.
- **Cost shows token volume, not dollars.** OpenRouter's per-model rates move independently of
  this repo, so the session cost card reports the tokens it measured and leaves the billing
  figure to your OpenRouter activity page rather than printing a confidently wrong number.

## xAI (Grok agent and speech-to-text)

**xAI** works as an agent provider and as a speech engine, with one key for both (`apiKeys.xai`). It comes from [autopreso#24](https://github.com/kunchenguid/autopreso/pull/24) by Julien Talbot, who ran it against the live API. In Mic Draw it is checked against xAI's docs only and has not been verified live yet.

- **Agent.** Pick **xAI** in the agent panel, paste the key and type a model id; the default is `grok-4.3`. Requests go to xAI's OpenAI-compatible Chat Completions API (`https://api.x.ai/v1`). As with OpenRouter, no `reasoningEffort` is sent. The session cost card prices the Grok models in its rate table and shows `n/a` for others.
- **Speech.** Pick **xAI** in the Voice panel. It streams to `grok-voice-transcribe-2.0` over a WebSocket. xAI's Smart Turn decides when a thought is finished: a pause it is unsure about only settles a chunk, and after 1.2 s of silence the turn ends anyway. Text on the staging board becomes `keyterm` hints, as with Deepgram. Stop sends `finalize`, so the last words arrive before the turn is queued. Streaming costs $0.20 per hour of audio.

## Credits

- [autopreso](https://github.com/kunchenguid/autopreso) by Kun Chen - the project Mic Draw started from.
- [Excalidraw](https://github.com/excalidraw/excalidraw) - the whiteboard canvas, scene model, and rendering.
- [Moonshine](https://github.com/moonshine-ai/moonshine) - local English speech-to-text on macOS.
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) - the streaming speech-to-text runtime for the other local models.
- [Kroko](https://huggingface.co/Banafo/Kroko-ASR) and [Vosk](https://alphacephei.com/vosk/) - the English and Russian streaming models.
- [Vercel AI SDK](https://github.com/vercel/ai) - tool-calling agent loop and provider abstraction.

## Development

```sh
git clone https://github.com/ztemerbekov/micdraw.git
cd micdraw
npm install                       # install deps
npm run dev                       # run the CLI from source
npm run typecheck                 # tsc --noEmit
npm test                          # node --test
npm run build:moonshine-sidecars  # build the Python sidecar binaries
```

## License

[MIT](LICENSE).

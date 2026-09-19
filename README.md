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

Mic Draw is not on npm yet. Run it from source:

```sh
git clone https://github.com/ztemerbekov/micdraw.git
cd micdraw
npm install
npm start                    # boots the server, opens the browser
```

Then, in the browser:

1. Drop reference materials onto the staging canvas (title, agenda, etc).
2. Pick your microphone, transcription model, agent model, and optional Agent instructions.
3. Click "Start Preso" and start talking.

## How It Works

```
  ┌──────────┐   audio    ┌──────────────┐   text   ┌──────────────┐
  │   mic    │──────────► │     STT      │────────► │  whiteboard  │
  │ (browser)│   24kHz    │ Moonshine /  │ chunks   │    agent     │
  └──────────┘            │ OpenAI WS    │          │ (OpenAI /    │
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
OpenAI prices use the built-in May 2026 rate table; local providers show `$0.0000`, Codex shows token volume because it routes through your subscription, and unknown models show `n/a`.

### Defaults on first run

When no settings file exists, Mic Draw picks providers based on what it finds in your environment:

| You have...                                | Agent provider                 | Transcription              |
| ------------------------------------------ | ------------------------------ | -------------------------- |
| Nothing                                    | OpenAI `gpt-5.5` (needs a key) | Moonshine `medium` (macOS) |
| `OPENAI_API_KEY` in env                    | OpenAI `gpt-5.5`               | OpenAI Realtime            |
| Codex CLI signed in (`~/.codex/auth.json`) | Codex `gpt-5.5-fast`           | Moonshine `medium`         |
| Codex CLI signed in + `OPENAI_API_KEY`     | Codex `gpt-5.5-fast`           | OpenAI Realtime            |
| `OLLAMA_MODEL` set                         | Ollama (your model)            | Moonshine `medium`         |
| `OPENROUTER_API_KEY` in env                | OpenRouter `x-ai/grok-4.20`    | (unchanged by this key)    |
| `DEEPGRAM_API_KEY` in env                  | (unchanged by this key)        | Deepgram `nova-3`          |

Auto-detection precedence: **`OPENROUTER_API_KEY` wins over Codex CLI auth wins over `OLLAMA_MODEL` wins over `OPENAI_API_KEY`** for the agent. For transcription, **`DEEPGRAM_API_KEY` wins over `OPENAI_API_KEY`**, otherwise Moonshine. After first run, this auto-detection no longer applies - change providers from the in-app status panel.

### Environment variables

Provider variables only seed `settings.json` on first run. Once the file exists, they're ignored - edit the file or use the in-app panel. Log path variables are read on each process start.

| Variable               | Purpose                                               |
| ---------------------- | ----------------------------------------------------- |
| `PORT`                 | Port to listen on. Default: `3210`.                   |
| `OPENAI_API_KEY`       | Seeds the OpenAI key for both agent and Realtime STT. |
| `OPENAI_MODEL`         | Seeds the OpenAI agent model.                         |
| `OPENAI_BASE_URL`      | Seeds the OpenAI agent API base URL.                  |
| `CODEX_MODEL`          | Seeds the Codex model.                                |
| `OLLAMA_MODEL`         | Seeds the Ollama model.                               |
| `DEEPGRAM_API_KEY`     | Seeds the Deepgram key (STT only, separate from OpenAI's). |
| `DEEPGRAM_MODEL`       | Seeds the Deepgram model. Default: `nova-3`.          |
| `OPENROUTER_API_KEY`   | Seeds the OpenRouter key (agent only).                |
| `OPENROUTER_MODEL`     | Seeds the OpenRouter agent model. Default: `x-ai/grok-4.20`. |
| `OPENROUTER_BASE_URL`  | Seeds the OpenRouter API base URL.                    |
| `MICDRAW_CACHE_LOG`    | Cache usage log path. Default: `~/.config/micdraw/logs/cache.log`. |
| `MICDRAW_DEBUG_LOG`    | Agent debug log path. Default: `~/.config/micdraw/logs/debug.log`. |

Local Moonshine transcription ships as an optional native sidecar for `darwin-arm64` and `darwin-x64`. For now these are the sidecar builds published by autopreso (`@autopreso/moonshine-darwin-*`). On other platforms, choose OpenAI Realtime or Deepgram in the STT panel.

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

## Credits

- [autopreso](https://github.com/kunchenguid/autopreso) by Kun Chen - the project Mic Draw started from.
- [Excalidraw](https://github.com/excalidraw/excalidraw) - the whiteboard canvas, scene model, and rendering.
- [Moonshine](https://github.com/moonshine-ai/moonshine) - the local speech-to-text model that makes the offline path possible.
- [Vercel AI SDK](https://github.com/vercel/ai) - tool-calling agent loop and provider abstraction.

## Development

```sh
npm install                       # install deps
npm run dev                       # run the CLI from source
npm run typecheck                 # tsc --noEmit
npm test                          # node --test
npm run build:moonshine-sidecars  # build the Python sidecar binaries
```

## License

[MIT](LICENSE).

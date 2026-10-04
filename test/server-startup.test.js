// @ts-nocheck - injected fakes for streamText/generateText return simplified shapes that don't satisfy the AI SDK return type.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";

import { DEFAULT_AGENT_TIMEOUT_MS, runWhiteboardAgent, startServer, whiteboardSystemPrompt } from "../src/server.js";
import { openWs, startTestServer, withTimeout, wsBarrier, wsUrl } from "./helpers/server.js";

const CODEX_AGENT_PROVIDER = {
  provider: "codex",
  model: "gpt-5.5",
  baseURL: "https://chatgpt.com/backend-api/codex",
  apiKey: "test",
  reasoningEffort: "low",
};

test("default whiteboard agent timeout is 90 seconds", () => {
  assert.equal(DEFAULT_AGENT_TIMEOUT_MS, 90_000);
});

test("startServer waits for Moonshine readiness before listening", async () => {
  let resolveReady;
  let closed = false;
  const progressMessages = [];
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  const serverPromise = startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    onStatus: (message) => progressMessages.push(message),
    createTranscription: () => ({
      ready: () => readyPromise,
      sendAudio: () => {},
      stop: () => {},
      close: () => {
        closed = true;
      },
    }),
  });

  let started = false;
  serverPromise.then(() => {
    started = true;
  });
  await Promise.resolve();
  assert.equal(started, false);
  assert.deepEqual(progressMessages, ["Preparing Moonshine medium transcription model..."]);

  resolveReady();
  const { httpServer } = await serverPromise;
  assert.equal(started, true);
  assert.deepEqual(progressMessages, [
    "Preparing Moonshine medium transcription model...",
    "Moonshine medium transcription model ready.",
  ]);

  await new Promise((resolve) => httpServer.close(resolve));
  assert.equal(closed, true);
});

test("websocket clients receive the current agent status on connect", async (t) => {
  const { url } = await startTestServer(t);

  const messages = await collectWebSocketMessages(wsUrl(url), 6);
  assert.deepEqual(
    messages.map((message) => message.type),
    ["config", "agent:status", "mode", "warmup", "cost", "transcription:status"],
  );
  assert.deepEqual(messages[5], { type: "transcription:status", state: "ready", label: "Moonshine medium" });
  assert.equal(messages[1].status, "idle");
  assert.equal(messages[2].mode, "staging");
  assert.equal(messages[3].state, "idle");
  assert.equal(messages[4].agent.cost, 0);
  assert.equal(messages[4].transcription.cost, 0);
});

test("websocket screenshot messages update agent visual context", async (t) => {
  let resolveGenerateText;
  const generateTextStarted = new Promise((resolve) => {
    resolveGenerateText = resolve;
  });
  const { url, state } = await startTestServer(t, {
    createTranscription: ({ queueTranscript }) => ({
      ready: async () => {},
      sendAudio: () => queueTranscript("Update the visual layout"),
      stop: () => {},
      close: () => {},
    }),
    generateTextFn: async ({ messages }) => {
      const currentCanvasMessage = messages.at(-1);
      assert.deepEqual(currentCanvasMessage.content.at(-1), { type: "image", image: "data:image/png;base64,latest" });
      resolveGenerateText();
      return { text: "DONE", finishReason: "stop" };
    },
  });

  state.mode = "live";
  const ws = await openWs(url);
  ws.send(JSON.stringify({ type: "whiteboard:screenshot", image: "data:image/png;base64,latest" }));
  ws.send(JSON.stringify({ type: "audio", audio: "" }));
  await withTimeout(generateTextStarted, "the agent turn");
});

test("Stop draws the phrase the engine flushes as it stops", async (t) => {
  let generateCalled = false;
  let resolveStopCalled;
  const stopCalled = new Promise((resolve) => {
    resolveStopCalled = resolve;
  });
  const { url, state } = await startTestServer(t, {
    stopDrainMs: 0,
    createTranscription: ({ queueTranscript }) => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {
        queueTranscript("Final flushed words");
        resolveStopCalled();
      },
      close: () => {},
    }),
    generateTextFn: async () => {
      generateCalled = true;
      return { text: "DONE", finishReason: "stop" };
    },
  });

  state.mode = "live";
  const ws = await openWs(url);
  ws.send(JSON.stringify({ type: "stop" }));
  await withTimeout(stopCalled, "transcription stop");
  await state.idle();
  assert.equal(generateCalled, true);
});

/**
 * A server whose agent turn starts, then waits for `releaseTurn()` before it
 * draws a "gateway" rectangle, the way a slow model is still writing its edit
 * when the speaker clicks Stop.
 */
async function startServerWithHeldTurn(t) {
  let releaseTurn;
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  let resolveTurnStarted;
  const turnStarted = new Promise((resolve) => {
    resolveTurnStarted = resolve;
  });
  const server = await startTestServer(t, {
    stopDrainMs: 0,
    generateTextFn: async ({ tools }) => {
      resolveTurnStarted();
      await turnGate;
      await tools.whiteboard_apply.execute({
        operations: [{ type: "insert_after", line: 0, element: { type: "rectangle", id: "gateway", x: 0, y: 0, width: 160, height: 80 } }],
      });
      return { text: "DONE", finishReason: "stop" };
    },
  });
  server.state.mode = "live";
  const ws = await openWs(server.url);
  ws.send(JSON.stringify({ type: "audio:start", sessionId: "listening-1" }));
  await wsBarrier(ws);
  server.state.queueTranscript("The browser talks to an API gateway.");
  await withTimeout(turnStarted, "the agent turn");
  return { ...server, ws, releaseTurn };
}

test("Stop lets the agent finish the turn in flight", async (t) => {
  const { state, ws, releaseTurn } = await startServerWithHeldTurn(t);

  ws.send(JSON.stringify({ type: "stop", sessionId: "listening-1" }));
  await wsBarrier(ws);
  releaseTurn();
  await state.idle();

  assert.deepEqual(state.elements.map((element) => element.id), ["gateway"]);
});

test("Reset while Stop is finishing still drops the edit in flight", async (t) => {
  const { url, state, ws, releaseTurn } = await startServerWithHeldTurn(t);

  ws.send(JSON.stringify({ type: "stop", sessionId: "listening-1" }));
  await wsBarrier(ws);
  const res = await fetch(`${url}/api/session/reset`, { method: "POST" });
  assert.equal(res.status, 200);
  releaseTurn();
  await state.idle();

  assert.deepEqual(state.elements, []);
});

test("Stop ends the session once the queued turns finish", async (t) => {
  const { state, ws, releaseTurn } = await startServerWithHeldTurn(t);
  const listeningSession = state.session;

  ws.send(JSON.stringify({ type: "stop", sessionId: "listening-1" }));
  await wsBarrier(ws);
  assert.equal(listeningSession.active, true, "the session stays open while the turn draws");
  releaseTurn();
  await state.idle();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(listeningSession.active, false);
  assert.notEqual(state.session, listeningSession);
});

test("A hand edit while Stop is finishing drops the agent's edit in flight", async (t) => {
  const { state, ws, releaseTurn } = await startServerWithHeldTurn(t);
  const handDrawn = { type: "rectangle", id: "hand-drawn", x: 400, y: 0, width: 120, height: 60 };

  // The agent's edit was written against the board before this hand edit,
  // so its line numbers no longer point at the same elements.
  ws.send(JSON.stringify({ type: "stop", sessionId: "listening-1" }));
  ws.send(JSON.stringify({ type: "whiteboard:user-elements", elements: [handDrawn] }));
  await wsBarrier(ws);
  releaseTurn();
  await state.idle();

  assert.deepEqual(state.elements, [handDrawn]);
});

test("Stop does not send a lone filler word to the agent", async (t) => {
  let generateCalls = 0;
  const { url, state } = await startTestServer(t, {
    stopDrainMs: 0,
    createTranscription: ({ queueTranscript }) => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => queueTranscript("um"),
      close: () => {},
    }),
    generateTextFn: async () => {
      generateCalls += 1;
      return { text: "DONE", finishReason: "stop" };
    },
  });

  state.mode = "live";
  const ws = await openWs(url);
  ws.send(JSON.stringify({ type: "stop" }));
  await wsBarrier(ws);
  await state.idle();

  assert.equal(generateCalls, 0);
});

test("runWhiteboardAgent rejects with a timeout instead of hanging forever", async () => {
  await assert.rejects(
    () =>
      runWhiteboardAgent({
        transcript: "hello",
        state: { elements: [], agentHistory: [] },
        wss: { clients: new Set() },
        options: { agentTimeoutMs: 1 },
        generateTextFn: () => new Promise(() => {}),
      }),
    /Whiteboard agent timed out/,
  );
});

test("a timed-out turn is cancelled: the model call is aborted and a late edit does not land", async () => {
  const broadcasts = [];
  const state = { elements: [], agentHistory: [] };
  let signal;
  let lateResult;
  let lateEditDone;
  const lateEdit = new Promise((resolve) => { lateEditDone = resolve; });

  await assert.rejects(
    () =>
      runWhiteboardAgent({
        transcript: "hello",
        state,
        wss: { clients: new Set([{ readyState: WebSocket.OPEN, send: (msg) => broadcasts.push(JSON.parse(msg)) }]) },
        options: { agentTimeoutMs: 20 },
        generateTextFn: async ({ tools, abortSignal }) => {
          signal = abortSignal;
          // The model only gets its edit out after the turn has timed out.
          await new Promise((resolve) => setTimeout(resolve, 60));
          lateResult = await tools.whiteboard_apply.execute({
            operations: [{ type: "insert_after", line: 0, element: { type: "rectangle", id: "late", x: 0, y: 0, width: 100, height: 50 } }],
          });
          lateEditDone();
          return {};
        },
      }),
    /Whiteboard agent timed out/,
  );
  await lateEdit;

  assert.equal(signal?.aborted, true);
  assert.match(lateResult, /not applied/);
  assert.deepEqual(state.elements, []);
  assert.deepEqual(broadcasts.filter((message) => message.type === "whiteboard:update"), []);
});

test("runWhiteboardAgent exposes whiteboard_apply that combines edits and viewport in one call", async () => {
  const broadcasts = [];
  const state = {
    elements: [{ type: "text", id: "title", x: 72, y: 68, text: "Mic Draw" }],
    agentHistory: [],
  };

  await runWhiteboardAgent({
    transcript: "Add a voice box and focus on it",
    state,
    wss: {
      clients: new Set([
        {
          readyState: WebSocket.OPEN,
          send: (message) => broadcasts.push(JSON.parse(message)),
        },
      ]),
    },
    options: {},
    generateTextFn: async ({ tools }) => {
      assert.equal(tools.updateWhiteboard, undefined);
      assert.equal(tools.whiteboard_edit, undefined, "whiteboard_edit removed");
      assert.equal(tools.whiteboard_viewport, undefined, "whiteboard_viewport removed");
      assert.ok(tools.whiteboard_overwrite);
      assert.ok(tools.whiteboard_apply);

      const result = await tools.whiteboard_apply.execute({
        operations: [
          {
            type: "insert_after",
            line: 1,
            element: { type: "rectangle", id: "voice", x: 80, y: 140, width: 220, height: 80 },
          },
        ],
        viewport: { action: "scroll_to_content", focus_ids: ["voice"] },
      });

      assert.match(result, /001: \{"type":"text","id":"title"/);
      assert.match(result, /002: \{"type":"rectangle","id":"voice"/);
      assert.match(result, /Viewport scrolled to 1 element: \["voice"\]/);
    },
  });

  assert.deepEqual(state.elements, [
    { type: "text", id: "title", x: 72, y: 68, text: "Mic Draw" },
    { type: "rectangle", id: "voice", x: 80, y: 140, width: 220, height: 80 },
  ]);
  assert.deepEqual(
    broadcasts,
    [
      { type: "whiteboard:update", elements: state.elements },
      { type: "whiteboard:viewport", action: "scroll_to_content", focus_ids: ["voice"] },
    ],
  );
});

test("whiteboard_apply with operations only edits the canvas without touching viewport", async () => {
  const broadcasts = [];
  const state = {
    elements: [{ type: "text", id: "title", x: 0, y: 0, text: "Hi" }],
    agentHistory: [],
  };

  await runWhiteboardAgent({
    transcript: "Add a box",
    state,
    wss: {
      clients: new Set([
        { readyState: WebSocket.OPEN, send: (msg) => broadcasts.push(JSON.parse(msg)) },
      ]),
    },
    options: {},
    generateTextFn: async ({ tools }) => {
      const result = await tools.whiteboard_apply.execute({
        operations: [
          { type: "insert_after", line: 1, element: { type: "rectangle", id: "box", x: 10, y: 50, width: 100, height: 50 } },
        ],
      });
      assert.match(result, /002: \{"type":"rectangle","id":"box"/);
      assert.doesNotMatch(result, /Viewport/);
    },
  });

  assert.equal(broadcasts.filter((m) => m.type === "whiteboard:viewport").length, 0);
});

test("whiteboard_apply grows a shape too small for its label instead of warning the agent", async () => {
  const broadcasts = [];
  const state = { elements: [], agentHistory: [] };
  let result;

  await runWhiteboardAgent({
    transcript: "Add the replay step",
    state,
    wss: {
      clients: new Set([
        { readyState: WebSocket.OPEN, send: (msg) => broadcasts.push(JSON.parse(msg)) },
      ]),
    },
    options: {},
    generateTextFn: async ({ tools }) => {
      result = await tools.whiteboard_apply.execute({
        operations: [
          {
            type: "insert_after",
            line: 0,
            element: {
              type: "rectangle",
              id: "replay",
              x: 100,
              y: 100,
              width: 249,
              height: 110,
              label: { text: "Replay real turns on each model", fontSize: 18 },
            },
          },
        ],
      });
    },
  });

  assert.doesNotMatch(result, /WARNING/);
  assert.match(result, /"id":"replay","x":33,"y":100,"width":383,"height":110/);
  assert.equal(state.elements[0].width, 383);
  assert.deepEqual(broadcasts, [{ type: "whiteboard:update", elements: state.elements }]);
});

test("whiteboard_apply with viewport only moves the camera without editing", async () => {
  const broadcasts = [];
  const state = {
    elements: [{ type: "rectangle", id: "oauth-box", x: 0, y: 0, width: 200, height: 100 }],
    agentHistory: [],
  };

  await runWhiteboardAgent({
    transcript: "Zoom to the OAuth box",
    state,
    wss: {
      clients: new Set([
        { readyState: WebSocket.OPEN, send: (msg) => broadcasts.push(JSON.parse(msg)) },
      ]),
    },
    options: {},
    generateTextFn: async ({ tools }) => {
      const result = await tools.whiteboard_apply.execute({
        viewport: { action: "scroll_to_content", focus_ids: ["oauth-box"] },
      });
      assert.match(result, /Viewport scrolled to 1 element/);
    },
  });

  assert.deepEqual(
    broadcasts.filter((m) => m.type === "whiteboard:viewport"),
    [{ type: "whiteboard:viewport", action: "scroll_to_content", focus_ids: ["oauth-box"] }],
  );
  assert.equal(broadcasts.filter((m) => m.type === "whiteboard:update").length, 0);
});

test("whiteboard_apply rejects calls with neither operations nor viewport", async () => {
  let returned;
  await runWhiteboardAgent({
    transcript: "do nothing",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {},
    generateTextFn: async ({ tools }) => {
      returned = await tools.whiteboard_apply.execute({});
    },
  });
  assert.match(returned, /Provide at least one of operations or viewport/);
});

test("whiteboard_apply scroll_to_content without focus_ids returns a nudge to use them", async () => {
  let returned;
  await runWhiteboardAgent({
    transcript: "scroll please",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {},
    generateTextFn: async ({ tools }) => {
      returned = await tools.whiteboard_apply.execute({
        viewport: { action: "scroll_to_content" },
      });
    },
  });
  assert.match(returned, /focus_ids/);
});

test("runWhiteboardAgent passes OpenAI reasoning effort provider option", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      agentProvider: {
        provider: "openai",
        model: "gpt-5.5",
        apiKey: "test",
        reasoningEffort: "low",
      },
    },
    generateTextFn: async ({ providerOptions }) => {
      assert.deepEqual(providerOptions, {
        openai: { reasoningEffort: "low" },
      });
    },
  });
});

async function agentProviderOptionsFor(agentProvider) {
  let seen;
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: { agentProvider },
    generateTextFn: async ({ providerOptions }) => {
      seen = providerOptions;
    },
  });
  return seen;
}

test("runWhiteboardAgent passes the looked-up reasoning effort to xAI and Ollama", async () => {
  const xai = { provider: "xai", model: "grok-4.3", baseURL: "https://api.x.ai/v1", apiKey: "xai-key" };
  const ollama = { provider: "ollama", model: "qwen3.6", baseURL: "http://localhost:11434/v1", apiKey: "ollama" };

  assert.deepEqual(await agentProviderOptionsFor({ ...xai, reasoningEffort: "none" }), { openai: { reasoningEffort: "none" } });
  assert.deepEqual(await agentProviderOptionsFor({ ...ollama, reasoningEffort: "none" }), { openai: { reasoningEffort: "none" } });
  assert.equal(await agentProviderOptionsFor(xai), undefined);
});

test("runWhiteboardAgent forces OpenRouter's reasoning effort through and keeps the system role", async () => {
  const openrouter = { provider: "openrouter", model: "x-ai/grok-4.5", baseURL: "https://openrouter.ai/api/v1", apiKey: "or-key" };

  // The AI SDK only sends `reasoning` on the Responses API for model ids it
  // recognizes, and forcing it would otherwise turn the system message into a
  // developer message.
  assert.deepEqual(await agentProviderOptionsFor({ ...openrouter, reasoningEffort: "low" }), {
    openai: { reasoningEffort: "low", forceReasoning: true, systemMessageMode: "system" },
  });
  assert.equal(await agentProviderOptionsFor(openrouter), undefined);
});

test("runWhiteboardAgent sends OpenRouter's reasoning effort on the wire", async () => {
  const realFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    throw new Error("stop after the request");
  };
  try {
    await runWhiteboardAgent({
      transcript: "hello",
      state: { elements: [], agentHistory: [] },
      wss: { clients: new Set() },
      options: {
        agentProvider: { provider: "openrouter", model: "x-ai/grok-4.5", baseURL: "https://openrouter.ai/api/v1", apiKey: "or-key", reasoningEffort: "low" },
      },
    }).catch(() => {});
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal(body.input[0].role, "system");
});

test("runWhiteboardAgent looks up the reasoning effort for a provider from settings", async () => {
  const looked = [];
  const settings = {
    agent: { provider: "xai", xai: { model: "grok-4.3", baseURL: "https://api.x.ai/v1" } },
    apiKeys: { xai: "xai-key" },
  };
  let seen;

  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      settingsStore: { load: async () => settings },
      env: {},
      reasoningEffortLookup: async (agentProvider) => {
        looked.push(agentProvider.model);
        return "none";
      },
    },
    generateTextFn: async ({ providerOptions }) => {
      seen = providerOptions;
    },
  });

  assert.deepEqual(looked, ["grok-4.3"]);
  assert.deepEqual(seen, { openai: { reasoningEffort: "none" } });
});

test("runWhiteboardAgent always uses the production system prompt", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: { systemPrompt: "Custom whiteboard instructions" },
    generateTextFn: async ({ system }) => {
      assert.equal(system, whiteboardSystemPrompt());
    },
  });
});

test("runWhiteboardAgent records a model result summary in agent events", async () => {
  const events = [];

  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: { onAgentEvent: (event) => events.push(event) },
    generateTextFn: async () => ({ text: "DONE", finishReason: "stop", usage: { totalTokens: 12 } }),
  });

  const endEvent = events.find((event) => event.type === "model:end");
  assert.deepEqual(endEvent.result, {
    text: "DONE",
    finishReason: "stop",
    usage: { totalTokens: 12 },
  });
});

test("runWhiteboardAgent passes Codex reasoning effort provider option", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: { agentProvider: CODEX_AGENT_PROVIDER },
    streamTextFn: ({ providerOptions }) => ({
      consumeStream: async () => {
        assert.deepEqual(providerOptions, {
          openai: { reasoningEffort: "low", store: false, instructions: whiteboardSystemPrompt() },
        });
      },
    }),
  });
});

test("runWhiteboardAgent passes Codex fast mode provider option", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      agentProvider: { ...CODEX_AGENT_PROVIDER, requestedModel: "gpt-5.5-fast", serviceTier: "priority" },
    },
    streamTextFn: ({ providerOptions }) => ({
      consumeStream: async () => {
        assert.deepEqual(providerOptions, {
          openai: { reasoningEffort: "low", serviceTier: "priority", store: false, instructions: whiteboardSystemPrompt() },
        });
      },
    }),
  });
});

test("runWhiteboardAgent passes Codex instructions provider option", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: { agentProvider: CODEX_AGENT_PROVIDER },
    streamTextFn: ({ providerOptions, system }) => ({
      consumeStream: async () => {
        assert.equal(providerOptions.openai.instructions, system);
      },
    }),
  });
});

test("runWhiteboardAgent uses streaming for Codex responses", async () => {
  let consumed = false;

  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: { agentProvider: CODEX_AGENT_PROVIDER },
    generateTextFn: async () => {
      throw new Error("Codex should use streamText");
    },
    streamTextFn: () => ({
      consumeStream: async () => {
        consumed = true;
      },
    }),
  });

  assert.equal(consumed, true);
});

function collectWebSocketMessages(url, count) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out waiting for ${count} websocket messages.`));
    }, 2000);

    ws.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()));
      if (messages.length === count) {
        clearTimeout(timeout);
        ws.close();
        resolve(messages);
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test("config lists the languages and the local models for the platform", async (t) => {
  const { url } = await startTestServer(t, { platform: "linux" });
  const config = await (await fetch(`${url}/api/config`)).json();
  const cloud = ["en", "ru", "de", "fr", "es", "zh", "pt", "it", "ja", "ko", "hi", "uk", "pl", "tr", "nl", "ar"];
  assert.deepEqual(config.languages, {
    local: ["en", "ru", "de", "fr", "es", "zh"],
    openai: cloud,
    deepgram: [...cloud, "multi"],
    xai: cloud.filter((language) => language !== "zh" && language !== "uk"),
  });
  assert.deepEqual(config.localModels.map((model) => model.id), [
    "kroko-en-2025-08-06",
    "vosk-small-ru-2025-08-16",
    "kroko-de-2025-08-06",
    "kroko-fr-2025-08-06",
    "kroko-es-2025-08-06",
    "zipformer-ctc-small-zh-2025-04-01",
  ]);
});

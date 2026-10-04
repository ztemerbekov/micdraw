import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";

import { MAX_AGENT_INSTRUCTIONS_CHARS } from "../src/settings-store.js";
import { goLive, openWs, startTestServer, waitForMessage, withTimeout, wsBarrier, wsUrl } from "./helpers/server.js";

const SAMPLE_STAGING_ELEMENTS = [
  { type: "text", id: "ref-title", x: 0, y: 0, text: "Reference notes" },
  { type: "rectangle", id: "ref-card", x: 0, y: 40, width: 200, height: 80 },
];
const SAMPLE_SCREENSHOT = "data:image/png;base64,c3RhZ2luZw==";
const SAMPLE_GO_LIVE_BODY = { stagingElements: SAMPLE_STAGING_ELEMENTS, stagingScreenshot: SAMPLE_SCREENSHOT };

test("session starts in staging mode by default", async (t) => {
  const { state } = await startTestServer(t);
  assert.equal(state.mode, "staging");
});

test("WebSocket clients receive mode on connect", async (t) => {
  const { url } = await startTestServer(t);
  const modeMsg = await waitForMessage(new WebSocket(wsUrl(url)), (m) => m.type === "mode");
  assert.equal(modeMsg.mode, "staging");
});

test("POST /api/live/start flips to live, primes agentHistory, blanks the live canvas", async (t) => {
  const { url, state } = await startTestServer(t);
  state.agentHistory = [{ role: "user", content: "stale turn" }];
  state.elements = [{ type: "text", id: "stale", x: 0, y: 0, text: "stale" }];
  state.latestScreenshot = "data:image/png;base64,old";

  const res = await goLive(url, SAMPLE_GO_LIVE_BODY);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  assert.equal(state.mode, "live");
  assert.deepEqual(state.elements, [], "live canvas starts blank");
  assert.equal(state.latestScreenshot, undefined);

  // Primer lives at index 0; the warmup loop appends a priming pair (warmup
  // user msg + assistant("UNDERSTOOD")) after it finishes so subsequent turns
  // share the cached prefix, but the primer itself stays at index 0.
  await state.warmupPromise;
  assert.equal(state.agentHistory.length, 3, "primer + warmup priming pair");
  const primer = state.agentHistory[0];
  assert.equal(primer.role, "user");
  assert.ok(Array.isArray(primer.content), "primer with screenshot is multimodal");
  const textPart = primer.content.find((p) => p.type === "text");
  const imagePart = primer.content.find((p) => p.type === "image");
  assert.ok(textPart, "primer should include a text part");
  assert.ok(imagePart, "primer should include an image part");
  assert.equal(imagePart.image, SAMPLE_SCREENSHOT);
  assert.match(textPart.text, /reference/i, "primer should mention reference context");
  assert.match(textPart.text, /structure|layout/i, "primer should nudge the agent to follow staging structure");
  assert.ok(
    textPart.text.includes("ref-title") || textPart.text.includes("Reference notes"),
    "primer text should embed staging elements info",
  );
});

test("POST /api/live/start broadcasts mode change and fresh whiteboard", async (t) => {
  const { url } = await startTestServer(t);
  const ws = new WebSocket(wsUrl(url));
  // The snapshot a client gets on connect ends with transcription:status.
  await waitForMessage(ws, (m) => m.type === "transcription:status");
  const modeMsg = waitForMessage(ws, (m) => m.type === "mode");
  const update = waitForMessage(ws, (m) => m.type === "whiteboard:update");

  const res = await goLive(url, SAMPLE_GO_LIVE_BODY);
  assert.equal(res.status, 200);

  assert.equal((await modeMsg).mode, "live");
  assert.deepEqual((await update).elements, []);
});

test("POST /api/live/start pushes staging keyword vocabulary to the transcription provider", async (t) => {
  const { url, transcription } = await startTestServer(t);
  const res = await goLive(url, {
    stagingElements: [
      { type: "text", id: "t1", text: "Schema registry" },
      { type: "rectangle", id: "r1", label: { text: "Kafka consumer group" } },
      { type: "ellipse", id: "e1" },
    ],
    stagingScreenshot: SAMPLE_SCREENSHOT,
  });
  assert.equal(res.status, 200);

  assert.equal(transcription.sessionContextCalls.length, 1, "expected one setSessionContext call on Go Live");
  const { keywords } = transcription.sessionContextCalls[0];
  assert.ok(Array.isArray(keywords));
  assert.ok(keywords.includes("Schema registry"));
  assert.ok(keywords.includes("Kafka consumer group"));
});

test("settings reload reapplies staging keyword vocabulary to the new transcription provider", async (t) => {
  const instances = [];
  const settings = {
    transcription: {
      provider: "openai",
      openai: { model: "gpt-4o-mini-transcribe" },
      moonshine: { model: "medium" },
    },
    apiKeys: { openai: "test" },
  };
  const settingsStore = {
    load: async () => settings,
    save: async (next) => {
      Object.assign(settings, next);
    },
    getSanitized: async () => settings,
  };
  const createTranscription = () => {
    const instance = {
      sessionContextCalls: [],
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      setSessionContext: (ctx) => instance.sessionContextCalls.push(ctx),
      close: () => {},
    };
    instances.push(instance);
    return instance;
  };
  const { url } = await startTestServer(t, { settingsStore, createTranscription });
  const startRes = await goLive(url, {
    stagingElements: [{ type: "text", id: "t1", text: "Schema registry" }],
    stagingScreenshot: SAMPLE_SCREENSHOT,
  });
  assert.equal(startRes.status, 200);
  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0].sessionContextCalls.at(-1), { keywords: ["Schema registry"] });

  const settingsRes = await fetch(`${url}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transcription: {
        provider: "openai",
        openai: { model: "gpt-4o-transcribe" },
        moonshine: { model: "medium" },
      },
      apiKeys: { openai: "test" },
    }),
  });
  assert.equal(settingsRes.status, 200);
  assert.equal(instances.length, 2);
  assert.deepEqual(instances[1].sessionContextCalls.at(-1), { keywords: ["Schema registry"] });
});

test("POST /api/live/back-to-staging clears any previously pushed transcription vocabulary", async (t) => {
  const { url, transcription } = await startTestServer(t);
  await goLive(url, {
    stagingElements: [{ type: "text", id: "t1", text: "Kafka consumer group" }],
    stagingScreenshot: SAMPLE_SCREENSHOT,
  });
  transcription.sessionContextCalls.length = 0;

  const res = await fetch(`${url}/api/live/back-to-staging`, { method: "POST" });
  assert.equal(res.status, 200);

  assert.equal(transcription.sessionContextCalls.length, 1, "expected one clearing setSessionContext call");
  assert.deepEqual(transcription.sessionContextCalls[0], { keywords: [] });
});

test("POST /api/live/back-to-staging flips mode without clearing history", async (t) => {
  const { url, state } = await startTestServer(t);
  await goLive(url, SAMPLE_GO_LIVE_BODY);
  assert.equal(state.mode, "live");
  const historyBefore = state.agentHistory;

  const res = await fetch(`${url}/api/live/back-to-staging`, { method: "POST" });
  assert.equal(res.status, 200);

  assert.equal(state.mode, "staging");
  assert.equal(state.agentHistory, historyBefore, "agentHistory reference should be unchanged");
});

test("audio frames received in staging mode are not forwarded to transcription", async (t) => {
  const { url, transcription } = await startTestServer(t);
  const ws = await openWs(url);

  ws.send(JSON.stringify({ type: "audio", audio: "AAAA" }));
  await wsBarrier(ws);

  assert.equal(transcription.audioCalls.length, 0, "audio should be dropped while in staging mode");
});

test("audio frames are forwarded to transcription after Go Live", async (t) => {
  const { url, transcription } = await startTestServer(t);
  const ws = await openWs(url);

  await goLive(url, SAMPLE_GO_LIVE_BODY);

  ws.send(JSON.stringify({ type: "audio", audio: "BBBB" }));
  await wsBarrier(ws);

  assert.equal(transcription.audioCalls.length, 1);
  assert.equal(transcription.audioCalls[0], "BBBB");
});

test("late audio frames from a stopped listening session are ignored", async (t) => {
  const { url, transcription } = await startTestServer(t);
  const ws = await openWs(url);

  await goLive(url, SAMPLE_GO_LIVE_BODY);

  ws.send(JSON.stringify({ type: "audio:start", sessionId: "session-1" }));
  ws.send(JSON.stringify({ type: "audio", sessionId: "session-1", audio: "BBBB" }));
  ws.send(JSON.stringify({ type: "stop", sessionId: "session-1" }));
  ws.send(JSON.stringify({ type: "audio", sessionId: "session-1", audio: "CCCC" }));
  await wsBarrier(ws);

  assert.deepEqual(transcription.audioCalls, ["BBBB"]);
});

test("transcript queued in staging mode does not invoke the agent", async (t) => {
  const agentInvocations = [];
  const { state } = await startTestServer(t, {
    generateTextFn: async (opts) => {
      agentInvocations.push(opts);
      return { text: "DONE", finishReason: "stop" };
    },
  });
  assert.equal(state.mode, "staging");
  state.queueTranscript("hello world");
  await state.idle();
  assert.equal(agentInvocations.length, 0, "agent should not run while in staging mode");
});

test("repeat Go Live calls cleanly replace the primer", async (t) => {
  const { url, state } = await startTestServer(t);
  await goLive(url, SAMPLE_GO_LIVE_BODY);
  await state.warmupPromise;
  assert.equal(state.agentHistory.length, 3, "primer + warmup priming pair");

  const secondScreenshot = "data:image/png;base64,c2Vjb25k";
  const secondElements = [
    { type: "text", id: "ref-2", x: 0, y: 0, text: "Updated reference content here" },
  ];
  await goLive(url, { stagingElements: secondElements, stagingScreenshot: secondScreenshot });
  await state.warmupPromise;

  assert.equal(state.agentHistory.length, 3, "primer reset + new warmup priming pair");
  const primer = state.agentHistory[0];
  const imagePart = Array.isArray(primer.content) && primer.content.find((p) => p.type === "image");
  assert.ok(imagePart, "primer with screenshot should be multimodal");
  assert.equal(imagePart.image, secondScreenshot, "primer reflects the latest staging screenshot");
});

test("warmup loop retries until cache is hit, then stops", async (t) => {
  const calls = [];
  // 50% threshold for "primer is primed" - see whiteboard-session.js. 0 + 0
  // are misses, 600/1000 = 60% trips the threshold.
  const cachedSeq = [0, 0, 600];
  const { url, state } = await startTestServer(t, {
    warmupMaxAttempts: 8,
    warmupDelays: [1, 1, 1, 1, 1, 1, 1],
    generateTextFn: async (opts) => {
      const i = calls.length;
      calls.push({ messages: opts.messages, system: opts.system });
      const cached = cachedSeq[i] ?? 0;
      // Mimic OpenAI Chat Completions usage shape with cached_tokens.
      return {
        text: "UNDERSTOOD",
        finishReason: "stop",
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: cached },
        },
      };
    },
  });
  await goLive(url, SAMPLE_GO_LIVE_BODY);
  await state.warmupPromise;

  assert.equal(calls.length, 3, "ran 3 attempts: misses on 1+2, hit on 3");
  assert.equal(state.warmupState.state, "confirmed");
  // Same system prompt across retries (the cached prefix is what we want stable).
  assert.equal(calls[0].system, calls[1].system);
  assert.equal(calls[1].system, calls[2].system);
  // Same primer message across retries.
  assert.deepEqual(calls[0].messages[0], calls[1].messages[0]);
  assert.deepEqual(calls[1].messages[0], calls[2].messages[0]);
});

test("warmup loop transitions to exhausted after maxAttempts without a cache hit", async (t) => {
  let calls = 0;
  const { url, state } = await startTestServer(t, {
    warmupMaxAttempts: 3,
    warmupDelays: [1, 1, 1],
    generateTextFn: async () => {
      calls += 1;
      return {
        text: "UNDERSTOOD",
        finishReason: "stop",
        usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
      };
    },
  });
  await goLive(url, SAMPLE_GO_LIVE_BODY);
  await state.warmupPromise;
  assert.equal(calls, 3);
  assert.equal(state.warmupState.state, "exhausted");
});

test("POST /api/live/warmup/cancel short-circuits the loop", async (t) => {
  let calls = 0;
  let resolveStarted = (..._args) => {};
  const started = new Promise((r) => { resolveStarted = r; });
  let resolveBlock = (..._args) => {};
  const block = new Promise((r) => { resolveBlock = r; });
  const { url, state } = await startTestServer(t, {
    warmupMaxAttempts: 8,
    warmupDelays: [1, 1, 1, 1, 1, 1, 1],
    generateTextFn: async () => {
      calls += 1;
      resolveStarted();
      await block;
      return {
        text: "UNDERSTOOD",
        finishReason: "stop",
        usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
      };
    },
  });
  await goLive(url, SAMPLE_GO_LIVE_BODY);
  // Cancel while attempt 1 is still in-flight.
  await withTimeout(started, "the first warmup attempt");
  const res = await fetch(`${url}/api/live/warmup/cancel`, { method: "POST" });
  assert.equal(res.status, 200);
  resolveBlock();
  await state.warmupPromise;
  assert.equal(calls, 1, "no further attempts after cancel");
  assert.equal(state.warmupState.state, "cancelled");
});

test("Go Live fires a warmup call shaped like a real transcript turn", async (t) => {
  const calls = [];
  const { url, state } = await startTestServer(t, {
    generateTextFn: async (opts) => {
      calls.push({ messages: opts.messages, system: opts.system });
      return { text: "UNDERSTOOD", finishReason: "stop" };
    },
  });
  await goLive(url, SAMPLE_GO_LIVE_BODY);
  await state.warmupPromise;

  assert.equal(calls.length, 1, "expected exactly one warmup call");
  const messages = calls[0].messages;
  // primer (image-only after text stripped to system) + warmup placeholder
  assert.equal(messages.length, 2, `warmup should be image primer + warmup placeholder; got ${messages.length}`);
  assert.equal(messages[0].role, "user");
  assert.ok(Array.isArray(messages[0].content), "primer image part stays as multimodal user content");
  const onlyImage = messages[0].content.every((p) => p.type === "image");
  assert.ok(onlyImage, "primer message should contain only image parts (text now lives in system)");
  assert.match(messages[1].content, /cache warmup/i, "speaker turn should be a warmup placeholder");
  // Primer text should be folded into the system prompt for both providers.
  assert.match(calls[0].system, /Reference context for this presentation/, "system should include primer text");
});

test("transcripts queued during warmup wait for warmup to finish, then run", async (t) => {
  let resolveWarmup = (..._args) => {};
  const warmupBlocker = new Promise((resolve) => { resolveWarmup = resolve; });
  const calls = [];
  // A warmup call sends [primer, warmup_user_msg] (2 messages, no assistant).
  // A real turn sends [primer, warmup_user_msg, assistant("UNDERSTOOD"), transcript, currentBoard].
  const isWarmupCall = (opts) => !opts.messages.some((m) => m.role === "assistant");
  const { url, state } = await startTestServer(t, {
    generateTextFn: async (opts) => {
      const kind = isWarmupCall(opts) ? "warmup" : "real";
      calls.push({ kind, messages: opts.messages });
      if (kind === "warmup") await warmupBlocker;
      return { text: "UNDERSTOOD", finishReason: "stop" };
    },
  });
  await goLive(url, SAMPLE_GO_LIVE_BODY);

  // Queue a transcript before warmup resolves. Nothing between the queue and
  // the model waits on I/O here, so one macrotask gives a turn that skipped
  // the warmup time to reach generateText.
  state.queueTranscript("hello world");
  await new Promise((resolve) => setImmediate(resolve));

  const realBeforeUnblock = calls.filter((c) => c.kind === "real");
  assert.equal(realBeforeUnblock.length, 0, "real turn must not run while warmup is pending");

  resolveWarmup();
  await state.idle();

  const realAfterUnblock = calls.filter((c) => c.kind === "real");
  assert.equal(realAfterUnblock.length, 1, "real turn should run after warmup completes");
});

test("multiple transcripts queued during warmup run only after the warmup call", async (t) => {
  let resolveWarmup = (..._args) => {};
  const warmupBlocker = new Promise((resolve) => { resolveWarmup = resolve; });
  const calls = [];
  // A warmup call sends [primer, warmup_user_msg] (2 messages, no assistant).
  // A real turn sends [primer, warmup_user_msg, assistant("UNDERSTOOD"), transcript, currentBoard].
  const isWarmupCall = (opts) => !opts.messages.some((m) => m.role === "assistant");
  const { url, state } = await startTestServer(t, {
    generateTextFn: async (opts) => {
      const kind = isWarmupCall(opts) ? "warmup" : "real";
      calls.push({ kind, messages: opts.messages });
      if (kind === "warmup") await warmupBlocker;
      return { text: "UNDERSTOOD", finishReason: "stop" };
    },
  });
  await goLive(url, SAMPLE_GO_LIVE_BODY);

  state.queueTranscript("first chunk");
  state.queueTranscript("second chunk");
  state.queueTranscript("third chunk");

  resolveWarmup();
  await state.idle();

  // How chunks are batched into turns is covered in whiteboard-session.test.js.
  const realCalls = calls.filter((c) => c.kind === "real");
  assert.ok(realCalls.length >= 1, "at least one real turn should run");
  assert.equal(calls[0].kind, "warmup", "warmup must run before any real turn");
});

test("warmup broadcasts agent:status thinking while running, idle when done", async (t) => {
  let resolveWarmup = (..._args) => {};
  const warmupBlocker = new Promise((resolve) => { resolveWarmup = resolve; });
  const { url } = await startTestServer(t, {
    generateTextFn: async (opts) => {
      // Warmup has no assistant message in its prefix; turns do.
      if (!opts.messages.some((m) => m.role === "assistant")) await warmupBlocker;
      return { text: "UNDERSTOOD", finishReason: "stop" };
    },
  });
  const ws = await openWs(url);

  const thinking = waitForMessage(ws, (m) => m.type === "agent:status" && m.status === "thinking");
  await goLive(url, SAMPLE_GO_LIVE_BODY);
  await thinking;

  const idleAfterThinking = waitForMessage(ws, (m) => m.type === "agent:status" && m.status === "idle");
  resolveWarmup();
  await idleAfterThinking;
});

test("whiteboard:user-elements WS messages update state.elements in live mode", async (t) => {
  const { url, state } = await startTestServer(t);
  const ws = await openWs(url);

  // Drop staging mode by going live first.
  await goLive(url, { stagingElements: SAMPLE_STAGING_ELEMENTS });
  assert.equal(state.mode, "live");
  assert.deepEqual(state.elements, []);

  const userDrawn = [
    { type: "rectangle", id: "user-1", x: 100, y: 100, width: 200, height: 80 },
    { type: "text", id: "user-2", x: 110, y: 120, text: "OAuth flow" },
  ];
  ws.send(JSON.stringify({ type: "whiteboard:user-elements", elements: userDrawn }));
  await wsBarrier(ws);

  assert.deepEqual(state.elements, userDrawn);
});

test("whiteboard:user-elements is ignored in staging mode", async (t) => {
  const { url, state } = await startTestServer(t);
  const ws = await openWs(url);
  assert.equal(state.mode, "staging");
  const before = state.elements;
  ws.send(JSON.stringify({
    type: "whiteboard:user-elements",
    elements: [{ type: "rectangle", id: "x", x: 0, y: 0, width: 1, height: 1 }],
  }));
  await wsBarrier(ws);
  assert.equal(state.elements, before, "staging mode must not accept live-canvas pushes");
});

test("POST /api/live/start rejects payload missing required fields", async (t) => {
  const { url } = await startTestServer(t);
  const res = await goLive(url, {});
  assert.equal(res.status, 400);
});

function makeSettingsStore(seed = {}) {
  const settings = {
    agent: {
      provider: "openai",
      openai: { model: "gpt-5.5", reasoningEffort: "low" },
      codex: { model: "gpt-5.5", baseURL: "https://chatgpt.com/backend-api/codex" },
      ollama: { model: "", baseURL: "http://localhost:11434/v1" },
    },
    transcription: {
      provider: "moonshine",
      moonshine: { model: "medium" },
      openai: { model: "gpt-realtime-whisper" },
    },
    apiKeys: { openai: "sk-test" },
    agentInstructions: "",
    ...seed,
  };
  return {
    load: async () => settings,
    save: async (patch) => Object.assign(settings, patch),
    getSanitized: async () => {
      const { apiKeys, ...rest } = settings;
      return { ...rest, hasOpenAIKey: Boolean(apiKeys?.openai) };
    },
  };
}

test("agent instructions snapshot at Go Live are folded into system prompt for warmup", async (t) => {
  const calls = [];
  const settingsStore = makeSettingsStore({
    agentInstructions: "Use a Lewis Carroll quill, never use the colour red.",
  });
  const { url, state } = await startTestServer(t, {
    settingsStore,
    generateTextFn: async (opts) => {
      calls.push({ system: opts.system, messages: opts.messages });
      return { text: "UNDERSTOOD", finishReason: "stop" };
    },
  });
  await goLive(url, SAMPLE_GO_LIVE_BODY);
  await state.warmupPromise;
  assert.equal(calls.length, 1, "expected one warmup call");
  assert.match(
    calls[0].system,
    /Lewis Carroll quill, never use the colour red/,
    "warmup system prompt must include the user's agent instructions",
  );
});

test("POST /api/live/start rejects oversized saved agent instructions", async (t) => {
  const settingsStore = makeSettingsStore({ agentInstructions: "x".repeat(MAX_AGENT_INSTRUCTIONS_CHARS + 1) });
  const { url } = await startTestServer(t, { settingsStore });
  const res = await goLive(url, SAMPLE_GO_LIVE_BODY);
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /Agent instructions must be 100000 characters or fewer\./);
});

test("agent instructions are included in real-turn system prompt and stay stable for cache", async (t) => {
  const calls = [];
  const settingsStore = makeSettingsStore({
    agentInstructions: "Always start with a giant title block.",
  });
  const { url, state } = await startTestServer(t, {
    settingsStore,
    generateTextFn: async (opts) => {
      calls.push({ system: opts.system, messages: opts.messages });
      return { text: "DONE", finishReason: "stop" };
    },
  });
  await goLive(url, SAMPLE_GO_LIVE_BODY);
  await state.warmupPromise;

  state.queueTranscript("hello world from the speaker");
  await state.idle();

  const realCalls = calls.filter((c) => c.messages.some((m) => m.role === "assistant"));
  assert.ok(realCalls.length >= 1, "expected at least one real turn");
  assert.match(
    realCalls[0].system,
    /Always start with a giant title block/,
    "real-turn system prompt must include the user's agent instructions",
  );
  // Cache stability: warmup and real-turn must share the same system prefix.
  const warmupCalls = calls.filter((c) => !c.messages.some((m) => m.role === "assistant"));
  assert.equal(warmupCalls[0].system, realCalls[0].system, "system prompt must match between warmup and real turn");
});

test("agent instructions changed while live do NOT affect the running session (cache stability)", async (t) => {
  const calls = [];
  const settingsStore = makeSettingsStore({ agentInstructions: "ORIGINAL_INSTRUCTIONS" });
  const { url, state } = await startTestServer(t, {
    settingsStore,
    generateTextFn: async (opts) => {
      calls.push({ system: opts.system, messages: opts.messages });
      return { text: "DONE", finishReason: "stop" };
    },
  });
  await goLive(url, SAMPLE_GO_LIVE_BODY);
  await state.warmupPromise;

  // User edits instructions while live. Per design, the snapshot taken at
  // /api/live/start wins for the whole live session so the cached prefix
  // doesn't get invalidated mid-stream.
  await settingsStore.save({ agentInstructions: "CHANGED_INSTRUCTIONS" });

  state.queueTranscript("first speaker turn");
  await state.idle();

  const realCalls = calls.filter((c) => c.messages.some((m) => m.role === "assistant"));
  assert.ok(realCalls.length >= 1);
  assert.match(realCalls[0].system, /ORIGINAL_INSTRUCTIONS/);
  assert.doesNotMatch(realCalls[0].system, /CHANGED_INSTRUCTIONS/);
});

test("empty agentInstructions adds nothing to the system prompt", async (t) => {
  const calls = [];
  const settingsStore = makeSettingsStore({ agentInstructions: "" });
  const { url, state } = await startTestServer(t, {
    settingsStore,
    generateTextFn: async (opts) => {
      calls.push({ system: opts.system });
      return { text: "UNDERSTOOD", finishReason: "stop" };
    },
  });
  await goLive(url, SAMPLE_GO_LIVE_BODY);
  await state.warmupPromise;
  assert.ok(calls.length >= 1);
  // No "User instructions" header should appear when the field is blank.
  assert.doesNotMatch(calls[0].system, /User instructions:/i);
});

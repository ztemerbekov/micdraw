// @ts-nocheck - scripted stream parts stand in for a real model.
import assert from "node:assert/strict";
import { test } from "node:test";

import { streamText } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream, simulateReadableStream } from "ai/test";
import { WebSocket } from "ws";

import { createArrayItemScanner, runWhiteboardAgent } from "../src/server.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

// One whiteboard tool call streamed the way the Codex backend sends it: the
// arguments arrive in small pieces, a moment apart, before the call completes.
function toolCallStream(toolName, input) {
  const json = JSON.stringify(input);
  const pieces = json.match(/[\s\S]{1,16}/g) ?? [];
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "call-1", toolName },
    ...pieces.map((delta) => ({ type: "tool-input-delta", id: "call-1", delta })),
    { type: "tool-input-end", id: "call-1" },
    { type: "tool-call", toolCallId: "call-1", toolName, input: json },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
  ];
}

const doneStream = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "text-1" },
  { type: "text-delta", id: "text-1", delta: "DONE" },
  { type: "text-end", id: "text-1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];

async function streamTurn({ toolName, input, session }) {
  const model = new MockLanguageModelV3({
    doStream: [
      { stream: simulateReadableStream({ chunks: toolCallStream(toolName, input), chunkDelayInMs: 1 }) },
      { stream: convertArrayToReadableStream(doneStream) },
    ],
  });
  const broadcasts = [];
  const state = { elements: [], agentHistory: [], ...(session ? { session } : {}) };
  await runWhiteboardAgent({
    transcript: "Draw the boxes",
    state,
    wss: { clients: new Set([{ readyState: WebSocket.OPEN, send: (message) => broadcasts.push(JSON.parse(message)) }]) },
    options: { agentProvider: { provider: "codex", model: "gpt-6-luna", apiKey: "test", baseURL: "http://127.0.0.1:9", reasoningEffort: "low" } },
    streamTextFn: (callOptions) => streamText({ ...callOptions, model }),
  });
  return { updates: broadcasts.filter((message) => message.type === "whiteboard:update"), state };
}

const box = (id, x) => ({ type: "rectangle", id, x, y: 0, width: 120, height: 60 });

// How many previews arrive depends on timing; what must hold is that each one
// is a growing slice of the final board and that the final board comes last.
function assertPreviewsLeadTo(updates, finalElements) {
  const final = updates.at(-1);
  assert.deepEqual(final, { type: "whiteboard:update", elements: finalElements });
  const previews = updates.slice(0, -1);
  assert.ok(previews.length > 0, "at least one preview before the finished edit");
  let shown = 0;
  for (const preview of previews) {
    assert.equal(preview.preview, true);
    assert.ok(preview.elements.length > shown && preview.elements.length < finalElements.length);
    assert.deepEqual(preview.elements, finalElements.slice(0, preview.elements.length));
    shown = preview.elements.length;
  }
}

test("a whiteboard edit shows each finished operation while the agent is still writing", async () => {
  const { updates, state } = await streamTurn({
    toolName: "whiteboard_apply",
    input: {
      operations: [
        { type: "insert_after", line: 0, element: box("a", 0) },
        { type: "insert_after", line: 1, element: box("b", 200) },
      ],
    },
  });
  assertPreviewsLeadTo(updates, [box("a", 0), box("b", 200)]);
  assert.deepEqual(state.elements, [box("a", 0), box("b", 200)]);
});

test("a whiteboard overwrite shows each finished element while the agent is still writing", async () => {
  const { updates } = await streamTurn({
    toolName: "whiteboard_overwrite",
    input: { elements: [box("a", 0), box("b", 200), box("c", 400)] },
  });
  assertPreviewsLeadTo(updates, [box("a", 0), box("b", 200), box("c", 400)]);
});

test("an edit that fails takes its preview back off the canvas", async () => {
  const { updates, state } = await streamTurn({
    toolName: "whiteboard_apply",
    input: {
      operations: [
        { type: "insert_after", line: 0, element: box("a", 0) },
        { type: "replace", line: 5, element: box("b", 200) },
      ],
    },
  });
  assert.deepEqual(updates, [
    { type: "whiteboard:update", preview: true, elements: [box("a", 0)] },
    { type: "whiteboard:update", elements: [] },
  ]);
  assert.deepEqual(state.elements, []);
});

test("a session that has ended gets no previews", async () => {
  const { updates } = await streamTurn({
    toolName: "whiteboard_apply",
    input: {
      operations: [
        { type: "insert_after", line: 0, element: box("a", 0) },
        { type: "insert_after", line: 1, element: box("b", 200) },
      ],
    },
    session: { id: 1, active: false },
  });
  assert.deepEqual(updates, []);
});

test("the item scanner ignores brackets, commas and quotes inside strings", () => {
  const operations = [
    { type: "insert_after", line: 0, element: { type: "text", id: "a", text: 'Braces {x}, [y] and "quotes" \\ done' } },
    { type: "insert_after", line: 1, element: { type: "rectangle", id: "b", label: { text: "Шаг 2, финал" } } },
    { type: "delete", line: 1 },
  ];
  const json = JSON.stringify({ viewport: { action: "scroll_to_content", focus_ids: ["a"] }, operations });
  const scanner = createArrayItemScanner("operations");
  for (const ch of json) scanner.push(ch);
  // The last operation is left to the finished tool call.
  assert.deepEqual(scanner.items, operations.slice(0, 2));
});

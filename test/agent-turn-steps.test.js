import assert from "node:assert/strict";
import { test } from "node:test";

import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { runWhiteboardAgent } from "../src/server.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function applyStep(operations) {
  return {
    content: [{ type: "tool-call", toolCallId: "call-1", toolName: "whiteboard_apply", input: JSON.stringify({ operations }) }],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage,
    warnings: [],
  };
}

const doneStep = {
  content: [{ type: "text", text: "DONE" }],
  finishReason: { unified: "stop", raw: "stop" },
  usage,
  warnings: [],
};

// Runs one agent turn against a scripted model and reports how many model
// requests it made.
async function runTurn(steps) {
  const model = new MockLanguageModelV3({ doGenerate: steps });
  const state = { elements: [], agentHistory: [] };
  await runWhiteboardAgent({
    transcript: "Add a box",
    state,
    wss: { clients: new Set() },
    options: {},
    generateTextFn: (callOptions) => generateText({ ...callOptions, model }),
  });
  return { requests: model.doGenerateCalls.length, state };
}

const box = { type: "rectangle", id: "box", x: 0, y: 0, width: 200, height: 80 };

test("a turn ends right after an edit that lands without warnings", async () => {
  const { requests, state } = await runTurn([applyStep([{ type: "insert_after", line: 0, element: box }]), doneStep]);
  assert.equal(requests, 1);
  assert.deepEqual(state.elements, [box]);
});

test("a turn whose edit comes back with a warning gets another step", async () => {
  // Standalone text on top of a shape is a warning only the agent can fix.
  const loose = { type: "text", id: "loose", x: 10, y: 10, text: "Box", fontSize: 18 };
  const { requests } = await runTurn([
    applyStep([
      { type: "insert_after", line: 0, element: box },
      { type: "insert_after", line: 1, element: loose },
    ]),
    doneStep,
  ]);
  assert.equal(requests, 2);
});

test("a turn whose edit fails gets another step", async () => {
  const { requests } = await runTurn([applyStep([{ type: "replace", line: 5, element: box }]), doneStep]);
  assert.equal(requests, 2);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { createTranscriptTurnQueue } from "../src/transcript-turn-queue.js";

test("queue sends a transcript immediately", async () => {
  const turns = [];
  const queue = createTranscriptTurnQueue({
    runTurn: async (text) => {
      turns.push(text);
    },
  });

  await queue.enqueue("first point");
  await queue.idle();

  assert.deepEqual(turns, ["first point"]);
});

test("queue keeps accumulating when isReady says the buffer isn't substantive yet", async () => {
  const turns = [];
  const queue = createTranscriptTurnQueue({
    runTurn: async (text) => {
      turns.push(text);
    },
    isReady: (text) => /[a-zA-Z]{4,}/.test(text), // need at least one 4+ letter word
  });

  queue.enqueue("uh");
  queue.enqueue("um");
  // Only fillers - isReady returns false, so nothing fires.
  assert.deepEqual(turns, []);

  queue.enqueue("OpenAI just released a new model");
  await queue.idle();

  // Now the buffer is substantive - all three chunks fire as one combined turn.
  assert.deepEqual(turns, ["uh\num\nOpenAI just released a new model"]);
});

test("queue idle() force-flushes a not-ready buffer so it always terminates", async () => {
  const turns = [];
  const queue = createTranscriptTurnQueue({
    runTurn: async (text) => {
      turns.push(text);
    },
    isReady: () => false, // never ready
  });

  queue.enqueue("uh");
  queue.enqueue("um");
  await queue.idle();

  // idle() forces the flush even though isReady would normally hold it.
  assert.deepEqual(turns, ["uh\num"]);
});

test("queue buffers chunks that arrive during a running turn into one follow-up turn", async () => {
  const turns = [];
  let releaseFirstTurn = (..._args) => {};
  const firstTurnDone = new Promise((resolve) => {
    releaseFirstTurn = resolve;
  });

  const queue = createTranscriptTurnQueue({
    runTurn: async (text) => {
      turns.push(text);
      if (text === "first") {
        await firstTurnDone;
      }
    },
  });

  queue.enqueue("first");
  // Wait for first to enter the runTurn body before enqueuing the followups.
  await new Promise((resolve) => setTimeout(resolve, 0));
  queue.enqueue("second");
  queue.enqueue("third");

  assert.deepEqual(turns, ["first"]);

  releaseFirstTurn();
  await queue.idle();

  assert.deepEqual(turns, ["first", "second\nthird"]);
});

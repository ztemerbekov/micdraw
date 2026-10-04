import assert from "node:assert/strict";
import { test } from "node:test";

import { goLive, openWs, startTestServer, waitForMessage } from "./helpers/server.js";

test("POST /api/session/reset restores starter whiteboard and clears agent history", async (t) => {
  const { url, state } = await startTestServer(t);
  state.elements = [{ type: "text", id: "scratch", x: 0, y: 0, text: "scratch" }];
  state.agentHistory = [{ role: "user", content: "old turn" }];
  state.latestScreenshot = "data:image/png;base64,old";

  const res = await fetch(`${url}/api/session/reset`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  // Live canvas resets to blank - the user can draw
  // on it before the first transcript turn fires.
  assert.deepEqual(state.elements, []);
  assert.deepEqual(state.agentHistory, []);
  assert.equal(state.latestScreenshot, undefined);
});

test("session reset broadcasts the starter whiteboard to connected websocket clients", async (t) => {
  const { url, state } = await startTestServer(t);
  state.elements = [{ type: "text", id: "scratch", x: 0, y: 0, text: "scratch" }];
  // In staging the connect snapshot carries no whiteboard:update, so the
  // first one is the reset broadcast.
  const ws = await openWs(url);
  const update = waitForMessage(ws, (m) => m.type === "whiteboard:update");

  const res = await fetch(`${url}/api/session/reset`, { method: "POST" });
  assert.equal(res.status, 200);

  assert.deepEqual((await update).elements, []);
});

test("POST /api/session/reset clears transcription vocabulary context", async (t) => {
  const { url, transcription } = await startTestServer(t);
  const startRes = await goLive(url, {
    stagingElements: [{ type: "text", id: "t1", text: "Kafka consumer group" }],
    stagingScreenshot: "data:image/png;base64,c3RhZ2luZw==",
  });
  assert.equal(startRes.status, 200);
  assert.deepEqual(transcription.sessionContextCalls.at(-1), { keywords: ["Kafka consumer group"] });

  const resetRes = await fetch(`${url}/api/session/reset`, { method: "POST" });
  assert.equal(resetRes.status, 200);

  assert.deepEqual(transcription.sessionContextCalls.at(-1), { keywords: [] });
});

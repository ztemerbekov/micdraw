import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import { WebSocket } from "ws";

import { MAX_WS_PAYLOAD_BYTES } from "../src/server.js";
import { openWs, startTestServer, wsUrl } from "./helpers/server.js";

function sendRequest(url, { method = "POST", path = "/api/session/reset", headers = {} } = {}) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

async function expectRejectedHandshake(ws) {
  const [req, res] = await once(ws, "unexpected-response");
  res.resume();
  req.destroy();
  return res.statusCode;
}

test("HTTP API answers requests from its own page", async (t) => {
  const { url } = await startTestServer(t);
  assert.equal(await sendRequest(url, { headers: { origin: url } }), 200);
});

test("HTTP API answers requests without an Origin header", async (t) => {
  const { url } = await startTestServer(t);
  assert.equal(await sendRequest(url), 200);
});

test("HTTP API rejects requests from another origin", async (t) => {
  const { url } = await startTestServer(t);
  assert.equal(await sendRequest(url, { headers: { origin: "https://example.com" } }), 403);
});

test("HTTP server rejects requests that name a non-loopback host", async (t) => {
  const { url } = await startTestServer(t);
  const { port } = new URL(url);
  const host = `example.com:${port}`;
  assert.equal(await sendRequest(url, { method: "GET", path: "/api/config", headers: { host } }), 403);
  assert.equal(await sendRequest(url, { method: "GET", path: "/", headers: { host } }), 403);
});

test("WebSocket accepts connections from its own page", async (t) => {
  const { url } = await startTestServer(t);
  const ws = await openWs(url, { origin: url });
  ws.close();
  await once(ws, "close");
});

test("WebSocket rejects connections from another origin", async (t) => {
  const { url } = await startTestServer(t);
  const ws = new WebSocket(wsUrl(url), { origin: "https://example.com" });
  assert.equal(await expectRejectedHandshake(ws), 403);
});

test("WebSocket rejects connections that name a non-loopback host", async (t) => {
  const { url } = await startTestServer(t);
  const { port } = new URL(url);
  const ws = new WebSocket(wsUrl(url), { headers: { host: `example.com:${port}` } });
  assert.equal(await expectRejectedHandshake(ws), 403);
});

test("WebSocket closes the connection on messages above the payload limit", async (t) => {
  const { url } = await startTestServer(t);
  const ws = await openWs(url, { origin: url });
  ws.send("x".repeat(MAX_WS_PAYLOAD_BYTES + 1));
  const [code] = await once(ws, "close");
  assert.equal(code, 1009);
});

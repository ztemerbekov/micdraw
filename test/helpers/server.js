import { once } from "node:events";
import { WebSocket } from "ws";

import { startServer } from "../../src/server.js";

/** A transcription engine that records what the server sends it. */
export function fakeTranscription() {
  const audioCalls = [];
  const stopCalls = [];
  const sessionContextCalls = [];
  const factory = () => ({
    ready: async () => {},
    sendAudio: (audio) => audioCalls.push(audio),
    stop: () => stopCalls.push(true),
    setSessionContext: (ctx) => sessionContextCalls.push(ctx),
    close: () => {},
  });
  return { factory, audioCalls, stopCalls, sessionContextCalls };
}

/**
 * Starts the server on a free loopback port and closes it when the test ends.
 * Transcription and the model are fakes, so nothing reaches the network, and
 * warmup makes one attempt with no delay. `overrides` replace any option.
 *
 * @param {import("node:test").TestContext} t
 * @param {Record<string, any>} [overrides]
 */
export async function startTestServer(t, overrides = {}) {
  const transcription = fakeTranscription();
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: transcription.factory,
    generateTextFn: async () => ({ text: "DONE", finishReason: "stop" }),
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
    ...overrides,
  });
  // Closing waits for every open connection, upgraded WebSockets included,
  // so the teardown ends them first.
  const sockets = new Set();
  server.httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.httpServer.close(resolve));
  });
  return { ...server, transcription };
}

/** POSTs `body` to /api/live/start. */
export function goLive(url, body) {
  return fetch(`${url}/api/live/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The WebSocket address of the server at `url`. */
export function wsUrl(url) {
  return url.replace("http:", "ws:") + "/ws";
}

/**
 * A WebSocket to the server at `url`, once it is open.
 *
 * @param {string} url
 * @param {import("ws").ClientOptions} [options]
 */
export async function openWs(url, options) {
  const ws = new WebSocket(wsUrl(url), options);
  await once(ws, "open");
  return ws;
}

/**
 * The first message on `ws` that matches `predicate`, parsed. Only messages
 * that arrive after the call count, so start waiting before the action that
 * sends the message. Works on a socket that is still connecting.
 *
 * @param {WebSocket} ws
 * @param {(message: any) => boolean} predicate
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export function waitForMessage(ws, predicate, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
      settle(value);
    };
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (predicate(message)) finish(resolve, message);
    };
    const onError = (error) => finish(reject, error);
    const onClose = () => finish(reject, new Error(`WebSocket closed before a message matching ${predicate}.`));
    const timer = setTimeout(
      () => finish(reject, new Error(`Timed out after ${timeoutMs} ms waiting for a message matching ${predicate}.`)),
      timeoutMs,
    );
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

/**
 * Resolves once the server has dispatched every message sent on `ws` before
 * the call: it reads a socket's frames in order and answers this ping after
 * the messages ahead of it. Handlers that act without awaiting (audio, stop,
 * whiteboard:user-elements) have finished by then; settings:update has not.
 *
 * @param {WebSocket} ws
 */
export async function wsBarrier(ws) {
  ws.ping();
  await withTimeout(once(ws, "pong"), "the server to answer a ping");
}

/**
 * Settles like `promise`, or rejects if it has not settled within `timeoutMs`.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {string} description what the test is waiting for
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export async function withTimeout(promise, description, timeoutMs = 2000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Headless Chrome driven over the DevTools protocol, for the agent simulator
// and the browser smoke test.
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import { WebSocket } from "ws";

export function launchChrome(chromeBin, { debugPort, userDataDir, url, extraArgs = [] }) {
  return spawn(
    chromeBin,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      ...extraArgs,
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      url,
    ],
    { stdio: "ignore" },
  );
}

export async function stopChrome(chrome) {
  if (chrome.exitCode !== null) return;
  chrome.kill();
  // A Chrome that ignores the kill gets two seconds. The timeout's timer does
  // not keep the process alive once Chrome has exited.
  await once(chrome, "exit", { signal: AbortSignal.timeout(2000) }).catch(() => {});
}

export class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.ws = new WebSocket(webSocketDebuggerUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const deferred = this.pending.get(message.id);
      if (!deferred) return;
      this.pending.delete(message.id);
      if (message.error) deferred.reject(new Error(message.error.message));
      else deferred.resolve(message);
    });
  }

  static async connect(webSocketDebuggerUrl) {
    const client = new CdpClient(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      client.ws.once("open", resolve);
      client.ws.once("error", reject);
    });
    return client;
  }

  request(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws.close();
  }
}

// On GitHub's Ubuntu runners Chrome has taken more than 15 s to show the
// page, so the waits below are generous. They only run out when something is
// broken.
const CHROME_WAIT_MS = 60_000;

/** The DevTools target showing `url`. Ends early if `chrome` exits. */
export async function waitForChromeTab(debugPort, url, chrome = undefined) {
  const deadline = Date.now() + CHROME_WAIT_MS;
  let lastSeen = "no answer from the debugging endpoint";
  while (Date.now() < deadline) {
    if (chrome && (chrome.exitCode !== null || chrome.signalCode !== null)) {
      throw new Error(`Chrome exited (${chrome.exitCode ?? chrome.signalCode}) before showing ${url}.`);
    }
    try {
      const tabs = await fetch(`http://127.0.0.1:${debugPort}/json`).then((res) => res.json());
      const tab = tabs.find((item) => item.url === url || item.url === `${url}/`);
      if (tab?.webSocketDebuggerUrl) return tab;
      lastSeen = `tabs ${JSON.stringify(tabs.map((item) => item.url))}`;
    } catch {
      // Chrome can take a moment to expose the debugging endpoint.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for Chrome debug tab for ${url}; last saw ${lastSeen}.`);
}

/** Resolves with the page's text once it contains `expectedText`. */
export async function waitForRenderedText(cdp, expectedText, timeoutMs = CHROME_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  while (Date.now() < deadline) {
    lastText = (await evaluateInPage(cdp, "document.body.innerText")) ?? "";
    if (lastText.includes(expectedText)) return lastText;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for rendered text: ${expectedText}. Last text: ${lastText}`);
}

/** The expression's value; a promise is awaited. */
export async function evaluateInPage(cdp, expression) {
  const response = await cdp.request("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return response.result?.result?.value;
}

export function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

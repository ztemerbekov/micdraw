import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  CdpClient,
  evaluateInPage,
  getAvailablePort,
  launchChrome,
  stopChrome,
  waitForChromeTab,
  waitForRenderedText,
} from "../scripts/lib/chrome-cdp.js";
import { startServer } from "../src/server.js";

const CHROME_BIN = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("browser renders the app shell", async (t) => {
  if (!existsSync(CHROME_BIN)) {
    t.skip("Chrome is not installed. Set CHROME_BIN to enable this smoke test.");
    return;
  }

  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });

  t.after(() => {
    httpServer.close();
  });

  const userDataDir = await mkdtemp(path.join(tmpdir(), "micdraw-chrome-"));
  const debugPort = await getAvailablePort();
  const chrome = launchChrome(CHROME_BIN, { debugPort, userDataDir, url });

  t.after(async () => {
    await stopChrome(chrome);
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const tab = await waitForChromeTab(debugPort, url);
  const cdp = await CdpClient.connect(tab.webSocketDebuggerUrl);
  t.after(() => cdp.close());
  const text = await waitForRenderedText(cdp, "Start Preso");

  assert.match(text, /Start Preso/);

  const controls = await evaluateInPage(cdp, `Array.from(document.querySelectorAll(".controls button")).map((button) => button.textContent.trim())`);
  // Page starts in staging: Start Preso + Reset staging.
  assert.ok(controls.some((label) => label.includes("Start Preso")), `expected a Start Preso button, got ${JSON.stringify(controls)}`);
  assert.ok(controls.some((label) => label.includes("Reset Staging")), `expected a Reset Staging button, got ${JSON.stringify(controls)}`);

  // The page's own origin has to pass the request guard for the app WebSocket.
  const webSocketState = await evaluateInPage(
    cdp,
    `new Promise((resolve) => {
      const socket = new WebSocket(\`ws://\${location.host}/ws\`);
      socket.onopen = () => { socket.close(); resolve("open"); };
      socket.onerror = () => resolve("error");
    })`,
  );
  assert.equal(webSocketState, "open");
});

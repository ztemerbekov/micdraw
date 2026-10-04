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
import { FAKE_MICROPHONE_ARGS, goLiveAndListen } from "../scripts/lib/simulator-page.js";
import { startServer } from "../src/server.js";
import { createSettingsStore } from "../src/settings-store.js";
import { startTestServer } from "./helpers/server.js";
import { tempDir } from "./helpers/tmp.js";

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

  const tab = await waitForChromeTab(debugPort, url, chrome);
  const cdp = await CdpClient.connect(tab.webSocketDebuggerUrl);
  t.after(() => cdp.close());
  const text = await waitForRenderedText(cdp, "Go Live");

  assert.match(text, /Go Live/);

  const controls = await evaluateInPage(cdp, `Array.from(document.querySelectorAll(".controls button")).map((button) => button.textContent.trim())`);
  // Page starts in staging: Go Live + Reset staging.
  assert.ok(controls.some((label) => label.includes("Go Live")), `expected a Go Live button, got ${JSON.stringify(controls)}`);
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

test("the simulator's page steps reach Live and start listening", async (t) => {
  if (!existsSync(CHROME_BIN)) {
    t.skip("Chrome is not installed. Set CHROME_BIN to enable this smoke test.");
    return;
  }

  // Go Live saves the agent instructions first, so the page needs a settings store.
  const settingsStore = createSettingsStore({ filePath: path.join(tempDir(t), "settings.json"), env: {}, readCodexAuth: () => null });
  const { url } = await startTestServer(t, { settingsStore });

  const userDataDir = await mkdtemp(path.join(tmpdir(), "micdraw-chrome-"));
  const debugPort = await getAvailablePort();
  const chrome = launchChrome(CHROME_BIN, { debugPort, userDataDir, url, extraArgs: FAKE_MICROPHONE_ARGS });

  t.after(async () => {
    await stopChrome(chrome);
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const tab = await waitForChromeTab(debugPort, url, chrome);
  const cdp = await CdpClient.connect(tab.webSocketDebuggerUrl);
  t.after(() => cdp.close());

  await goLiveAndListen(cdp);

  assert.equal(await evaluateInPage(cdp, `document.querySelector(".record-toggle").classList.contains("recording")`), true);
});

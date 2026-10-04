// Drives the Mic Draw page the way a presenter does, for the whiteboard agent
// simulator: switch to Preso, wait for warmup, start listening.

import { setTimeout as sleep } from "node:timers/promises";

import { evaluateInPage, waitForRenderedText } from "./chrome-cdp.js";

/** Chrome flags that let the page "listen" with a fake microphone and no permission prompt. */
export const FAKE_MICROPHONE_ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"];

const PRESO_TIMEOUT_MS = 60_000;
// Warmup makes up to 8 attempts over about two minutes of delays when the
// prompt cache doesn't hit (src/whiteboard-session.js), plus the model's time.
const WARMUP_TIMEOUT_MS = 300_000;
const LISTEN_TIMEOUT_MS = 30_000;
const RETRY_MS = 500;

/**
 * Switches the page from Staging to Preso and starts listening. Start Preso
 * needs Excalidraw's API, which arrives after the first render, so the Preso
 * toggle is pressed until the page leaves Staging. Pressing it in Preso does
 * nothing.
 */
export async function startPresoAndListen(cdp) {
  const presoDeadline = Date.now() + PRESO_TIMEOUT_MS;
  while (!/Start Talking|Warming up/.test((await evaluateInPage(cdp, "document.body.innerText")) ?? "")) {
    if (Date.now() > presoDeadline) throw new Error("The page did not switch to Preso.");
    await evaluateInPage(cdp, `document.querySelector('.mode-toggle-option[title="Preso mode"]')?.click()`);
    await sleep(RETRY_MS);
  }
  // The record button reads "Warming up..." and stays disabled until warmup ends.
  await waitForRenderedText(cdp, "Start Talking", WARMUP_TIMEOUT_MS);
  await evaluateInPage(cdp, `document.querySelector(".record-toggle").click()`);
  const listenDeadline = Date.now() + LISTEN_TIMEOUT_MS;
  while (!(await evaluateInPage(cdp, `document.querySelector(".record-toggle")?.classList.contains("recording") ?? false`))) {
    if (Date.now() > listenDeadline) throw new Error("The page did not start listening.");
    await sleep(RETRY_MS);
  }
}

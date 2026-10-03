import assert from "node:assert/strict";
import { test } from "node:test";

import { waitForRenderedText } from "../scripts/lib/chrome-cdp.js";

/** A CDP client whose page text never changes. */
function staticPage(text) {
  return { request: async () => ({ result: { result: { value: text } } }) };
}

test("waitForRenderedText gives up after the timeout it is given", async () => {
  const started = Date.now();

  await assert.rejects(waitForRenderedText(staticPage("Warming up... (3 / 8)"), "Start Talking", 300), /Start Talking/);

  assert.ok(Date.now() - started < 5_000, "should not fall back to the 60 s default");
});

test("waitForRenderedText returns the page text once it appears", async () => {
  assert.equal(await waitForRenderedText(staticPage("Start Talking"), "Start Talking", 300), "Start Talking");
});

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { agentLogPaths, appendToLog, dumpAgentRequest, logAgentUsage } from "../src/server.js";
import { tempDir } from "./helpers/tmp.js";

test("agent debug and cache logs create nested log directories", async (t) => {
  const tmp = tempDir(t, "micdraw-logs-");

  const previousCacheLog = process.env.MICDRAW_CACHE_LOG;
  const previousDebugLog = process.env.MICDRAW_DEBUG_LOG;
  process.env.MICDRAW_CACHE_LOG = path.join(tmp, "nested", "cache", "cache.log");
  process.env.MICDRAW_DEBUG_LOG = path.join(tmp, "nested", "debug", "debug.log");
  t.after(() => {
    if (previousCacheLog === undefined) delete process.env.MICDRAW_CACHE_LOG;
    else process.env.MICDRAW_CACHE_LOG = previousCacheLog;
    if (previousDebugLog === undefined) delete process.env.MICDRAW_DEBUG_LOG;
    else process.env.MICDRAW_DEBUG_LOG = previousDebugLog;
  });

  logAgentUsage("turn", { usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 } });
  dumpAgentRequest("turn", { system: "system", messages: [{ role: "user", content: "hello" }] });

  assert.equal(existsSync(process.env.MICDRAW_CACHE_LOG), true);
  assert.equal(existsSync(process.env.MICDRAW_DEBUG_LOG), true);

  const cacheRecord = JSON.parse(readFileSync(process.env.MICDRAW_CACHE_LOG, "utf8").trim());
  assert.equal(cacheRecord.label, "turn");
  assert.equal(cacheRecord.cachePct, 40);

  const debugLog = readFileSync(process.env.MICDRAW_DEBUG_LOG, "utf8");
  const debugRecord = JSON.parse(debugLog.slice(debugLog.indexOf("{")));
  assert.equal(debugRecord.label, "turn");
  assert.equal(debugRecord.systemLength, 6);
});

test("while tests run, agent logs stay out of the user's ~/.config/micdraw/logs", () => {
  const env = { ...process.env, MICDRAW_CACHE_LOG: undefined, MICDRAW_DEBUG_LOG: undefined };
  for (const file of Object.values(agentLogPaths(env))) {
    assert.ok(file.startsWith(os.tmpdir()), file);
    assert.ok(!file.startsWith(path.join(os.homedir(), ".config", "micdraw")), file);
  }
});

test("an agent log over its size cap rolls over to .1 and starts fresh", async (t) => {
  const tmp = tempDir(t, "micdraw-logs-");
  const file = path.join(tmp, "debug.log");

  appendToLog(file, "old line one\nold line two\n", { maxBytes: 10 });
  appendToLog(file, "new line\n", { maxBytes: 10 });

  assert.equal(readFileSync(`${file}.1`, "utf8"), "old line one\nold line two\n");
  assert.equal(readFileSync(file, "utf8"), "new line\n");
});

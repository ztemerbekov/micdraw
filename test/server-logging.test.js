import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("agent debug and cache logs create nested log directories", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "micdraw-logs-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

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

  const { dumpAgentRequest, logAgentUsage } = await import(`../src/server.js?logging-test=${Date.now()}`);

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

test("while tests run, agent logs stay out of the user's ~/.config/micdraw/logs", async (t) => {
  const previous = { cache: process.env.MICDRAW_CACHE_LOG, debug: process.env.MICDRAW_DEBUG_LOG };
  delete process.env.MICDRAW_CACHE_LOG;
  delete process.env.MICDRAW_DEBUG_LOG;
  t.after(() => {
    if (previous.cache !== undefined) process.env.MICDRAW_CACHE_LOG = previous.cache;
    if (previous.debug !== undefined) process.env.MICDRAW_DEBUG_LOG = previous.debug;
  });

  const { agentLogPaths } = await import(`../src/server.js?test-log-dir=${Date.now()}`);
  for (const file of Object.values(agentLogPaths())) {
    assert.ok(file.startsWith(os.tmpdir()), file);
    assert.ok(!file.startsWith(path.join(os.homedir(), ".config", "micdraw")), file);
  }
});

test("an agent log over its size cap rolls over to .1 and starts fresh", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "micdraw-logs-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, "debug.log");
  const { appendToLog } = await import("../src/server.js");

  appendToLog(file, "old line one\nold line two\n", { maxBytes: 10 });
  appendToLog(file, "new line\n", { maxBytes: 10 });

  assert.equal(readFileSync(`${file}.1`, "utf8"), "old line one\nold line two\n");
  assert.equal(readFileSync(file, "utf8"), "new line\n");
});

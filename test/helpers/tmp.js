import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A fresh directory, deleted when the test ends. */
export function tempDir(t, prefix = "micdraw-test-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** A CODEX_HOME holding Codex CLI auth with these tokens, deleted when the test ends. */
export function codexHomeWith(t, { accessToken = "codex-token", refreshToken = "refresh" } = {}) {
  const codexHome = tempDir(t, "micdraw-codex-");
  writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: accessToken, refresh_token: refreshToken } }));
  return codexHome;
}

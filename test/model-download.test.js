import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ensureModelFiles } from "../src/model-download.js";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function fakeModel(contents) {
  return {
    id: "fake-model",
    source: "https://example.test/repo",
    revision: "rev1",
    files: Object.fromEntries(
      Object.entries(contents).map(([role, text]) => [role, { name: `${role}.bin`, size: Buffer.byteLength(text), sha256: sha256(text) }]),
    ),
  };
}

function fakeFetch(bodies) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const name = url.split("/").pop();
    return new Response(bodies[name] ?? "", { status: bodies[name] === undefined ? 404 : 200 });
  };
  return { fetchFn, calls };
}

test("downloads every file, verifies it and returns the paths", async () => {
  const modelsDir = mkdtempSync(path.join(tmpdir(), "micdraw-models-"));
  const model = fakeModel({ encoder: "enc", tokens: "tok" });
  const { fetchFn, calls } = fakeFetch({ "encoder.bin": "enc", "tokens.bin": "tok" });
  const progress = [];

  const paths = await ensureModelFiles(model, { modelsDir, fetchFn, onProgress: (event) => progress.push(event) });

  assert.deepEqual(calls, ["https://example.test/repo/resolve/rev1/encoder.bin", "https://example.test/repo/resolve/rev1/tokens.bin"]);
  assert.equal(readFileSync(paths.encoder, "utf8"), "enc");
  assert.equal(readFileSync(paths.tokens, "utf8"), "tok");
  assert.deepEqual(progress.at(-1), { receivedBytes: 6, totalBytes: 6 });
});

test("a completed model is not downloaded again", async () => {
  const modelsDir = mkdtempSync(path.join(tmpdir(), "micdraw-models-"));
  const model = fakeModel({ encoder: "enc" });
  await ensureModelFiles(model, { modelsDir, fetchFn: fakeFetch({ "encoder.bin": "enc" }).fetchFn });

  const second = fakeFetch({ "encoder.bin": "enc" });
  await ensureModelFiles(model, { modelsDir, fetchFn: second.fetchFn });
  assert.deepEqual(second.calls, []);
});

test("a file with the wrong checksum is rejected and not kept", async () => {
  const modelsDir = mkdtempSync(path.join(tmpdir(), "micdraw-models-"));
  const model = fakeModel({ encoder: "enc" });

  await assert.rejects(
    ensureModelFiles(model, { modelsDir, fetchFn: fakeFetch({ "encoder.bin": "xyz" }).fetchFn }),
    /Checksum mismatch for encoder\.bin/,
  );
  const dir = path.join(modelsDir, "fake-model");
  assert.equal(existsSync(path.join(dir, "encoder.bin")), false);
  assert.equal(existsSync(path.join(dir, "encoder.bin.part")), false);
  assert.equal(existsSync(path.join(dir, ".complete")), false);
});

test("an HTTP error names the file", async () => {
  const modelsDir = mkdtempSync(path.join(tmpdir(), "micdraw-models-"));
  await assert.rejects(
    ensureModelFiles(fakeModel({ encoder: "enc" }), { modelsDir, fetchFn: fakeFetch({}).fetchFn }),
    /Download failed \(404\) for encoder\.bin/,
  );
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const rootDir = path.join(import.meta.dirname, "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"));
}

test("root package keeps platform sidecars as optional published packages, not local workspaces", () => {
  const rootPackage = readJson("package.json");

  assert.deepEqual(rootPackage.files, ["assets/", "LICENSE", "public/", "src/"]);
  assert.equal(rootPackage.bin["autopreso"], "src/cli.js");
  assert.equal(rootPackage.scripts.dev, "node ./src/cli.js");
  assert.equal(rootPackage.scripts["build:moonshine-sidecars"], "node ./scripts/build-moonshine-sidecars.js");
  assert.equal(rootPackage.workspaces, undefined);
  assert.ok(rootPackage.optionalDependencies["@autopreso/moonshine-darwin-arm64"]);
  assert.ok(rootPackage.optionalDependencies["@autopreso/moonshine-darwin-x64"]);
});

test("Moonshine sidecar packages share one version, decoupled from autopreso", () => {
  const armPackage = readJson("packages/moonshine-darwin-arm64/package.json");
  const x64Package = readJson("packages/moonshine-darwin-x64/package.json");
  const rootPackage = readJson("package.json");

  // Both sidecar packages must always agree on their version, since they ship
  // the same binary contract for two architectures.
  assert.equal(armPackage.version, x64Package.version);

  // Root optionalDependencies must pin the exact sidecar version that's
  // checked into the sidecar package.jsons, otherwise `npm ci` (and the
  // resolver in src/moonshine-transcription.js) sees a version mismatch.
  assert.equal(rootPackage.optionalDependencies["@autopreso/moonshine-darwin-arm64"], armPackage.version);
  assert.equal(rootPackage.optionalDependencies["@autopreso/moonshine-darwin-x64"], x64Package.version);
});

test("Moonshine sidecar packages expose the resolver binary contract", () => {
  const packages = [
    {
      dir: "packages/moonshine-darwin-arm64",
      name: "@autopreso/moonshine-darwin-arm64",
      cpu: "arm64",
    },
    {
      dir: "packages/moonshine-darwin-x64",
      name: "@autopreso/moonshine-darwin-x64",
      cpu: "x64",
    },
  ];

  for (const sidecarPackage of packages) {
    const packageJson = readJson(`${sidecarPackage.dir}/package.json`);

    assert.equal(packageJson.name, sidecarPackage.name);
    assert.deepEqual(packageJson.os, ["darwin"]);
    assert.deepEqual(packageJson.cpu, [sidecarPackage.cpu]);
    assert.deepEqual(packageJson.files, ["bin/autopreso-moonshine"]);
    assert.equal(packageJson.bin["autopreso-moonshine"], "bin/autopreso-moonshine");
  }
});

test("Moonshine sidecars are built from a pinned release recipe", () => {
  const sidecarConfig = readJson("moonshine-sidecar.config.json");

  assert.equal(sidecarConfig.moonshineVoiceVersion, "0.0.59");
  assert.equal(sidecarConfig.moonshineReleaseTag, "v0.0.59");
  assert.deepEqual(sidecarConfig.targets.map((target) => target.packageDir), [
    "packages/moonshine-darwin-arm64",
    "packages/moonshine-darwin-x64",
  ]);
});

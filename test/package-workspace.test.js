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

  assert.deepEqual(rootPackage.files, ["LICENSE", "public/", "src/"]);
  assert.equal(rootPackage.bin["micdraw"], "src/cli.js");
  assert.equal(rootPackage.scripts.dev, "node ./src/cli.js");
  assert.equal(rootPackage.scripts["build:moonshine-sidecars"], "node ./scripts/build-moonshine-sidecars.js");
  assert.equal(rootPackage.workspaces, undefined);

  // Until micdraw publishes its own sidecars, the root package installs the
  // upstream autopreso builds.
  assert.ok(rootPackage.optionalDependencies["@autopreso/moonshine-darwin-arm64"]);
  assert.ok(rootPackage.optionalDependencies["@autopreso/moonshine-darwin-x64"]);
});

test("package.json, package-lock.json and the changelog agree on the version", () => {
  const { version } = readJson("package.json");
  const lock = readJson("package-lock.json");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");

  assert.equal(lock.version, version);
  assert.equal(lock.packages[""].version, version);
  // A release PR turns "## Unreleased" into the section of the version it publishes.
  assert.match(changelog, new RegExp(`^## ${version.replaceAll(".", "\\.")} \\(\\d{4}-\\d{2}-\\d{2}\\)$`, "m"));
});

test("Moonshine sidecar packages share one version", () => {
  const armPackage = readJson("packages/moonshine-darwin-arm64/package.json");
  const x64Package = readJson("packages/moonshine-darwin-x64/package.json");

  // Both sidecar packages must always agree on their version, since they ship
  // the same binary contract for two architectures.
  assert.equal(armPackage.version, x64Package.version);
});

test("micdraw sidecar packages declare their platform and binary", () => {
  const packages = [
    {
      dir: "packages/moonshine-darwin-arm64",
      name: "@micdraw/moonshine-darwin-arm64",
      cpu: "arm64",
    },
    {
      dir: "packages/moonshine-darwin-x64",
      name: "@micdraw/moonshine-darwin-x64",
      cpu: "x64",
    },
  ];

  for (const sidecarPackage of packages) {
    const packageJson = readJson(`${sidecarPackage.dir}/package.json`);

    assert.equal(packageJson.name, sidecarPackage.name);
    assert.deepEqual(packageJson.os, ["darwin"]);
    assert.deepEqual(packageJson.cpu, [sidecarPackage.cpu]);
    assert.deepEqual(packageJson.files, ["bin/micdraw-moonshine"]);
    assert.equal(packageJson.bin["micdraw-moonshine"], "bin/micdraw-moonshine");
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

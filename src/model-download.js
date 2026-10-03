import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { modelFileUrl } from "./local-models.js";

const COMPLETE_MARKER = ".complete";

/**
 * Downloads a model's files into `<modelsDir>/<model id>/` once, checking each
 * against its pinned size and SHA-256, and returns absolute paths by role.
 */
export async function ensureModelFiles(model, { modelsDir, fetchFn = fetch, onProgress = (_event) => {} }) {
  const dir = path.join(modelsDir, model.id);
  const paths = Object.fromEntries(Object.entries(model.files).map(([role, file]) => [role, path.join(dir, file.name)]));
  if (await isComplete(dir, model)) return paths;

  await mkdir(dir, { recursive: true });
  const totalBytes = Object.values(model.files).reduce((sum, file) => sum + file.size, 0);
  let receivedBytes = 0;
  for (const [role, file] of Object.entries(model.files)) {
    await downloadVerified(modelFileUrl(model, file), paths[role], file, fetchFn, (bytes) => {
      receivedBytes += bytes;
      onProgress({ receivedBytes, totalBytes });
    });
  }
  await writeFile(path.join(dir, COMPLETE_MARKER), model.revision);
  return paths;
}

async function isComplete(dir, model) {
  try {
    return (await readFile(path.join(dir, COMPLETE_MARKER), "utf8")) === model.revision;
  } catch {
    return false;
  }
}

async function downloadVerified(url, target, file, fetchFn, onBytes) {
  const partial = `${target}.part`;
  try {
    const response = await fetchFn(url);
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${file.name}`);
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.length;
          onBytes(chunk.length);
          yield chunk;
        }
      },
      createWriteStream(partial),
    );
    const digest = hash.digest("hex");
    if (size !== file.size || digest !== file.sha256) {
      throw new Error(`Checksum mismatch for ${file.name}: expected ${file.sha256}, got ${digest}`);
    }
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

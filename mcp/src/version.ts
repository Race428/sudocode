/**
 * Build identity for the MCP server.
 *
 * The version reported to MCP clients is derived, never hand-maintained — a
 * hardcoded string drifts from package.json silently (it sat at 0.1.1 through
 * two releases). In a dev checkout the build timestamp is appended so you can
 * tell at a glance, from any client's server info, whether the running build
 * includes your latest changes.
 */

import {readFileSync, existsSync, statSync} from "fs";
import {dirname, join} from "path";
import {fileURLToPath} from "url";

let cached: string | undefined;

export function getVersion(): string {
  if (cached !== undefined) return cached;

  const thisFile = fileURLToPath(import.meta.url);
  const pkgRoot = dirname(dirname(thisFile)); // dist/version.js -> pkg root

  let version = "0.0.0";
  try {
    version = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version ?? version;
  } catch {
    // ponytail: unreadable package.json is not worth failing startup over
  }

  // Dev checkout only: published tarballs ship no src/, so this stays clean for users.
  if (existsSync(join(pkgRoot, "src"))) {
    try {
      // Second precision is enough to distinguish builds; drop ms and the trailing Z.
      const builtAt = statSync(thisFile).mtime.toISOString().replace(/\.\d+Z$/, "Z");
      version = `${version}+build.${builtAt}`;
    } catch {
      // ponytail: stamp is a nice-to-have, never a startup blocker
    }
  }

  cached = version;
  return cached;
}

/**
 * Git hooks that bridge the decoupled store to git:
 *   - pre-commit: refresh + stage the JSONL from the live SQLite, so every
 *     commit carries a fresh, complete artifact even when autoExport is off.
 *   - post-merge: import JSONL into the cache after a pull/merge, so the local
 *     view reflects what other agents committed.
 *
 * Installed into the git-common hooks dir (one install covers every worktree),
 * mirroring backup.ts. Idempotent; appends to a foreign existing hook via a
 * managed marker rather than clobbering it. All hook bodies are best-effort and
 * never block the git operation.
 */

import * as fs from "fs";
import * as path from "path";
import { getGitCommonDir } from "./store-resolution.js";

export type HookResult = "installed" | "exists" | "skipped";

const MARKER = "# sudocode-store-sync";

const PRE_COMMIT_BODY = `${MARKER} (pre-commit: refresh + stage JSONL from the live store)
sudocode export --stage --quiet >/dev/null 2>&1 || true
`;

const POST_MERGE_BODY = `${MARKER} (post-merge: import JSONL into the cache)
sudocode import --quiet >/dev/null 2>&1 || true
`;

function installOne(hooksDir: string, name: string, body: string): HookResult {
  const hookPath = path.join(hooksDir, name);
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, "utf8");
    if (existing.includes(MARKER)) return "exists";
    fs.appendFileSync(hookPath, `\n${body}`);
    return "installed";
  }
  fs.writeFileSync(hookPath, `#!/bin/sh\n${body}`, "utf8");
  fs.chmodSync(hookPath, 0o755);
  return "installed";
}

/**
 * Install the pre-commit + post-merge sync hooks. Returns per-hook status;
 * "skipped" when not inside a git repo.
 */
export function installSyncHooks(cwd: string = process.cwd()): {
  preCommit: HookResult;
  postMerge: HookResult;
} {
  const common = getGitCommonDir(cwd);
  if (!common) return { preCommit: "skipped", postMerge: "skipped" };
  const hooksDir = path.join(common, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  return {
    preCommit: installOne(hooksDir, "pre-commit", PRE_COMMIT_BODY),
    postMerge: installOne(hooksDir, "post-merge", POST_MERGE_BODY),
  };
}

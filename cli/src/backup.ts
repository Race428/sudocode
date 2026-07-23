/**
 * Store backup — the store lives under .git/ (untracked), so it never rides a
 * normal push. This exports the store's JSONL into a dedicated orphan ref
 * (refs/heads/sudocode-store) using pure git plumbing (no working-tree checkout,
 * no branch switch), giving durable + distributable + historical backup at the
 * one moment data should leave the machine: `git push`.
 *
 * A pre-push hook refreshes the ref (but does NOT push it — that would recurse);
 * a push refspec added at init/migrate carries the ref out with the normal push.
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { getGitCommonDir } from "./store-resolution.js";
import type Database from "better-sqlite3";

export const BACKUP_BRANCH = "sudocode-store";
export const BACKUP_REF = `refs/heads/${BACKUP_BRANCH}`;
const JSONL_FILES = ["specs.jsonl", "issues.jsonl"];

function git(args: string[], cwd: string, input?: Buffer | string): string {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function gitQuiet(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** Author/committer identity for backup commits, with a fallback when git config is unset. */
function identityEnv(cwd: string): NodeJS.ProcessEnv {
  const name = gitQuiet(["config", "user.name"], cwd) || "sudocode";
  const email = gitQuiet(["config", "user.email"], cwd) || "sudocode@localhost";
  return {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

export interface BackupOptions {
  /** Store dir holding the JSONL files (default: resolved). */
  storeDir: string;
  /** Working dir inside the repo (default: process.cwd()). */
  cwd?: string;
}

/**
 * Snapshot the store's JSONL into the backup orphan ref. Returns the new commit
 * sha, or null when there is nothing to back up (no repo / no JSONL).
 */
export function runBackup(opts: BackupOptions): string | null {
  const cwd = opts.cwd ?? process.cwd();
  if (!getGitCommonDir(cwd)) return null; // not in a git repo

  // Hash each present JSONL into a blob; build a tree.
  const treeLines: string[] = [];
  for (const name of JSONL_FILES) {
    const file = path.join(opts.storeDir, name);
    if (!fs.existsSync(file)) continue;
    const sha = execFileSync("git", ["hash-object", "-w", "--", file], {
      cwd,
      encoding: "utf8",
    }).trim();
    treeLines.push(`100644 blob ${sha}\t${name}`);
  }
  if (treeLines.length === 0) return null;

  const tree = git(["mktree"], cwd, treeLines.join("\n") + "\n");

  // Skip a no-op backup: if the current ref already points at this exact tree.
  const parent = gitQuiet(["rev-parse", "--verify", "--quiet", BACKUP_REF], cwd);
  if (parent) {
    const parentTree = gitQuiet(["rev-parse", `${parent}^{tree}`], cwd);
    if (parentTree === tree) return parent;
  }

  const commitArgs = ["commit-tree", tree, "-m", "sudocode store backup"];
  if (parent) commitArgs.push("-p", parent);
  const commit = execFileSync("git", commitArgs, {
    cwd,
    encoding: "utf8",
    env: identityEnv(cwd),
  }).trim();

  git(["update-ref", BACKUP_REF, commit], cwd);
  return commit;
}

/**
 * The best backup ref to restore FROM: the local branch if present, else a
 * remote-tracking ref (origin preferred) that arrived on clone. This is what
 * makes "clone and go" work — a fresh clone has no local sudocode-store branch,
 * only refs/remotes/origin/sudocode-store. Returns a fully-qualified ref, or
 * null when no backup exists anywhere.
 */
export function findRestorableBackupRef(cwd: string = process.cwd()): string | null {
  if (gitQuiet(["rev-parse", "--verify", "--quiet", BACKUP_REF], cwd)) return BACKUP_REF;
  // Scan actual remote-tracking refs (a fresh clone has these), preferring origin.
  const listed = gitQuiet(
    ["for-each-ref", "--format=%(refname)", "refs/remotes/"],
    cwd
  );
  const remoteRefs = (listed || "")
    .split("\n")
    .filter((r) => r.endsWith(`/${BACKUP_BRANCH}`));
  const origin = `refs/remotes/origin/${BACKUP_BRANCH}`;
  return remoteRefs.find((r) => r === origin) || remoteRefs[0] || null;
}

/**
 * Restore the store's JSONL from the backup ref and import into the db.
 * Returns true when a backup was found and restored.
 */
export async function restoreBackup(
  opts: BackupOptions & { db: Database.Database }
): Promise<boolean> {
  const cwd = opts.cwd ?? process.cwd();
  const ref = findRestorableBackupRef(cwd);
  if (!ref) return false;

  fs.mkdirSync(opts.storeDir, { recursive: true });
  let restoredAny = false;
  for (const name of JSONL_FILES) {
    const content = gitQuiet(["cat-file", "-p", `${ref}:${name}`], cwd);
    if (content === null) continue;
    fs.writeFileSync(path.join(opts.storeDir, name), content + "\n", "utf8");
    restoredAny = true;
  }
  if (!restoredAny) return false;

  const { importFromJSONL } = await import("./import.js");
  await importFromJSONL(opts.db, { inputDir: opts.storeDir, resolveCollisions: true });
  return true;
}

const HOOK_MARKER = "# sudocode-store-backup";
// Refresh the backup ref, then push it to the SAME remote ($1) the user is
// pushing to. The push is guarded (env var + --no-verify) so it doesn't recurse
// into this hook, and does NOT use a `remote.push` refspec (which would disable
// the user's normal branch push). All best-effort — never block the user's push.
const HOOK_BODY = `${HOOK_MARKER}
if [ -z "$SUDOCODE_BACKUP_PUSH" ]; then
  sudocode backup >/dev/null 2>&1 || true
  if [ -n "$1" ]; then
    SUDOCODE_BACKUP_PUSH=1 git push --no-verify "$1" +refs/heads/${BACKUP_BRANCH}:refs/heads/${BACKUP_BRANCH} >/dev/null 2>&1 || true
  fi
fi
`;
const PRE_PUSH_HOOK = `#!/bin/sh\n${HOOK_BODY}`;

/**
 * Install the pre-push backup hook in the shared git common hooks dir (one hook
 * covers every worktree). Idempotent; appends to a foreign existing hook rather
 * than clobbering it. Returns "installed" | "exists" | "skipped".
 */
export function installBackupHook(cwd: string = process.cwd()): "installed" | "exists" | "skipped" {
  const common = getGitCommonDir(cwd);
  if (!common) return "skipped";
  const hooksDir = path.join(common, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "pre-push");

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, "utf8");
    if (existing.includes(HOOK_MARKER)) return "exists";
    fs.appendFileSync(hookPath, `\n${HOOK_BODY}`);
    return "installed";
  }

  fs.writeFileSync(hookPath, PRE_PUSH_HOOK, "utf8");
  fs.chmodSync(hookPath, 0o755);
  return "installed";
}

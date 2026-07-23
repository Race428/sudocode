/**
 * Store resolution — find the one .sudocode store that every worktree and tool
 * should agree on. Resolves the way git/npm/cargo resolve their root, plus one
 * worktree trick: anchor to git's common dir, which every linked worktree shares.
 *
 * Precedence (bind only to a store that actually EXISTS at a tier before falling
 * through — never mint an empty store at a higher tier and shadow real data lower):
 *   1. --db flag / SUDOCODE_DB env      (explicit db path override)
 *   2. config.json storeRef             (explicit project override)
 *   3. git common-dir store             (<common>/sudocode — shared across worktrees)
 *   4. legacy upward .sudocode/ walk    (back-compat for un-migrated repos)
 *   5. cwd/.sudocode                    (last resort)
 *
 * SUDOCODE_WORKING_DIR is not a tier — it sets the effective cwd that every tier
 * resolves FROM, so it stays git-aware (and matches how the MCP wrapper uses it:
 * as the CLI child's working directory). This means an interim
 * SUDOCODE_WORKING_DIR pin still lands on the shared git-common store rather than
 * forcing a legacy per-dir .sudocode.
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

/** Directory name of the store when it lives under the git common dir. */
export const STORE_SUBDIR = "sudocode";
export const DB_FILENAME = "cache.db";

export type StoreSource =
  | "db-flag"
  | "config-storeRef"
  | "git-common"
  | "legacy-walk"
  | "cwd-fallback";

export interface ResolvedStore {
  /** Directory holding cache.db + JSONL. */
  storeDir: string;
  /** Full path to cache.db. */
  dbPath: string;
  /** How it was resolved (diagnostics/tests). */
  source: StoreSource;
}

/** Run a git command, returning trimmed stdout or null on any failure. */
function git(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Absolute path to the git common dir (the main checkout's .git, shared by every
 * linked worktree), or null when cwd is not inside a git work tree.
 */
export function getGitCommonDir(cwd: string = process.cwd()): string | null {
  // --path-format=absolute needs git >= 2.31; fall back to resolving manually.
  const abs = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  if (abs) return path.resolve(abs);
  const rel = git(["rev-parse", "--git-common-dir"], cwd);
  if (!rel) return null;
  return path.resolve(cwd, rel);
}

/** True when cwd is inside a LINKED worktree (git-dir differs from common dir). */
export function isLinkedWorktree(cwd: string = process.cwd()): boolean {
  const insideWorkTree = git(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
  if (!insideWorkTree) return false;
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"], cwd);
  const commonDir = getGitCommonDir(cwd);
  if (!gitDir || !commonDir) return false;
  return path.resolve(gitDir) !== path.resolve(commonDir);
}

/** The canonical store dir under the git common dir, or null when not in a repo. */
export function gitCommonStoreDir(cwd: string = process.cwd()): string | null {
  const common = getGitCommonDir(cwd);
  return common ? path.join(common, STORE_SUBDIR) : null;
}

/** Absolute path to this worktree's top-level, or null when not in a repo. */
export function getGitTopLevel(cwd: string = process.cwd()): string | null {
  const top = git(["rev-parse", "--path-format=absolute", "--show-toplevel"], cwd);
  return top ? path.resolve(top) : null;
}

function storeAt(storeDir: string, source: StoreSource): ResolvedStore {
  return { storeDir, dbPath: path.join(storeDir, DB_FILENAME), source };
}

/** A directory counts as an existing store if it exists (cache.db may be absent
 *  in a fresh clone/worktree — the store dir itself is the boundary). */
function isExistingStore(dir: string): boolean {
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

/** Read storeRef from a .sudocode/config.json without pulling in the full config loader. */
function readStoreRef(sudocodeDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(sudocodeDir, "config.json"), "utf8");
    const ref = (JSON.parse(raw) as { storeRef?: string }).storeRef;
    return typeof ref === "string" && ref.length > 0 ? ref : null;
  } catch {
    return null;
  }
}

/**
 * Nearest ancestor (inclusive) containing a .sudocode/ directory, or null.
 * When `ceiling` is given (the git work-tree root), the walk stops there and
 * never binds to an unrelated `.sudocode` above the repo (e.g. a stray one in
 * /tmp or $HOME). Outside a repo it walks to the filesystem root as before.
 */
function findLegacySudocodeDir(cwd: string, ceiling: string | null): string | null {
  let dir = cwd;
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, ".sudocode");
    if (isExistingStore(candidate)) return candidate;
    if (ceiling && path.resolve(dir) === path.resolve(ceiling)) return null;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

export interface ResolveStoreOptions {
  cwd?: string;
  /** Explicit db path (from --db or SUDOCODE_DB). Highest precedence. */
  dbPath?: string;
}

/**
 * Where a fresh `sudocode init` should create the store.
 *
 * If a store already resolves (existing repo, or a linked worktree whose main
 * checkout was already initialized), reuse it — init is idempotent and never
 * mints a second store. Otherwise, in a git repo the store goes under the shared
 * git common dir (`<common>/sudocode`) so every worktree/tool agrees on it
 * automatically; in a non-git dir it falls back to `cwd/.sudocode`.
 */
export function storeDirForInit(cwdArg: string = process.cwd()): {
  dir: string;
  underGit: boolean;
  linkedWorktree: boolean;
} {
  // Honor SUDOCODE_WORKING_DIR the same way resolveStore does.
  const cwd = process.env.SUDOCODE_WORKING_DIR || cwdArg;
  const linkedWorktree = isLinkedWorktree(cwd);
  const resolved = resolveStore({ cwd });
  if (resolved.source !== "cwd-fallback" && isExistingStore(resolved.storeDir)) {
    return {
      dir: resolved.storeDir,
      underGit: resolved.source === "git-common",
      linkedWorktree,
    };
  }
  const common = gitCommonStoreDir(cwd);
  if (common) return { dir: common, underGit: true, linkedWorktree };
  return { dir: path.join(cwd, ".sudocode"), underGit: false, linkedWorktree };
}

/**
 * Resolve the store for the current invocation. Does NOT create anything — a
 * dormant git-common store (dir absent) falls through to legacy/cwd so we never
 * shadow an un-migrated repo's real data with an empty store.
 */
export function resolveStore(options: ResolveStoreOptions = {}): ResolvedStore {
  // SUDOCODE_WORKING_DIR overrides cwd for the whole resolution (git-aware).
  const cwd = process.env.SUDOCODE_WORKING_DIR || options.cwd || process.cwd();

  // 1. Explicit db path.
  if (options.dbPath) {
    return {
      storeDir: path.dirname(options.dbPath),
      dbPath: options.dbPath,
      source: "db-flag",
    };
  }

  // 2. config.json storeRef, read from the nearest legacy .sudocode (if any).
  // Bound the legacy walk by the git work-tree root so it never binds to an
  // unrelated .sudocode above the repo.
  const topLevel = getGitTopLevel(cwd);
  const legacyDir = findLegacySudocodeDir(cwd, topLevel);
  if (legacyDir) {
    const ref = readStoreRef(legacyDir);
    if (ref) {
      const resolved = path.isAbsolute(ref) ? ref : path.resolve(legacyDir, ref);
      return storeAt(resolved, "config-storeRef");
    }
  }

  // 3. git common-dir store, only if it already exists.
  const commonStore = gitCommonStoreDir(cwd);
  if (commonStore && isExistingStore(commonStore)) {
    return storeAt(commonStore, "git-common");
  }

  // 4. legacy upward .sudocode/ walk.
  if (legacyDir) {
    return storeAt(legacyDir, "legacy-walk");
  }

  // 5. cwd/.sudocode fallback.
  return storeAt(path.join(cwd, ".sudocode"), "cwd-fallback");
}

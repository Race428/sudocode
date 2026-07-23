/**
 * Unit tests for git-aware store resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  resolveStore,
  getGitCommonDir,
  isLinkedWorktree,
  gitCommonStoreDir,
  storeDirForInit,
  STORE_SUBDIR,
} from "../../src/store-resolution.js";

function initRepo(dir: string) {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  // Need a commit before `git worktree add` works.
  fs.writeFileSync(path.join(dir, "README"), "x\n");
  execFileSync("git", ["add", "README"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
}

// realpath both sides: macOS tmpdir is a /var -> /private/var symlink.
function samePath(a: string, b: string) {
  return fs.realpathSync(a) === fs.realpathSync(b);
}

describe("store resolution", () => {
  let tmp: string;
  const savedWorkingDir = process.env.SUDOCODE_WORKING_DIR;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-res-"));
    delete process.env.SUDOCODE_WORKING_DIR;
  });

  afterEach(() => {
    if (savedWorkingDir === undefined) delete process.env.SUDOCODE_WORKING_DIR;
    else process.env.SUDOCODE_WORKING_DIR = savedWorkingDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("explicit db path wins", () => {
    const r = resolveStore({ cwd: tmp, dbPath: "/somewhere/cache.db" });
    expect(r.source).toBe("db-flag");
    expect(r.dbPath).toBe("/somewhere/cache.db");
    expect(r.storeDir).toBe("/somewhere");
  });

  it("SUDOCODE_WORKING_DIR sets the effective cwd (git-aware, not forced-legacy)", () => {
    // Non-git target → cwd fallback there.
    process.env.SUDOCODE_WORKING_DIR = "/work";
    const r = resolveStore({ cwd: tmp });
    expect(r.storeDir).toBe(path.join("/work", ".sudocode"));

    // Git repo target with a common store → resolves to that shared store,
    // overriding the passed cwd. (An interim pin still lands on the shared store.)
    initRepo(tmp);
    const commonStore = gitCommonStoreDir(tmp)!;
    fs.mkdirSync(commonStore, { recursive: true });
    process.env.SUDOCODE_WORKING_DIR = tmp;
    const r2 = resolveStore({ cwd: "/somewhere/else" });
    expect(r2.source).toBe("git-common");
    expect(samePath(r2.storeDir, commonStore)).toBe(true);
  });

  it("config storeRef overrides (relative to .sudocode)", () => {
    const sud = path.join(tmp, ".sudocode");
    fs.mkdirSync(sud, { recursive: true });
    fs.writeFileSync(path.join(sud, "config.json"), JSON.stringify({ storeRef: "../store" }));
    const r = resolveStore({ cwd: tmp });
    expect(r.source).toBe("config-storeRef");
    expect(path.dirname(r.dbPath)).toBe(path.resolve(sud, "../store"));
  });

  it("non-git dir with .sudocode resolves via legacy walk", () => {
    fs.mkdirSync(path.join(tmp, ".sudocode"), { recursive: true });
    const r = resolveStore({ cwd: tmp });
    expect(r.source).toBe("legacy-walk");
    expect(r.storeDir).toBe(path.join(tmp, ".sudocode"));
  });

  it("legacy walk finds an ancestor .sudocode from a nested subdir", () => {
    fs.mkdirSync(path.join(tmp, ".sudocode"), { recursive: true });
    const nested = path.join(tmp, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    const r = resolveStore({ cwd: nested });
    expect(r.source).toBe("legacy-walk");
    expect(r.storeDir).toBe(path.join(tmp, ".sudocode"));
  });

  it("no store anywhere falls back to cwd/.sudocode", () => {
    const r = resolveStore({ cwd: tmp });
    expect(r.source).toBe("cwd-fallback");
    expect(r.storeDir).toBe(path.join(tmp, ".sudocode"));
  });

  it("git-common store binds only when it exists (dormant otherwise)", () => {
    initRepo(tmp);
    // .sudocode present in worktree, but no store under .git yet -> legacy walk.
    fs.mkdirSync(path.join(tmp, ".sudocode"), { recursive: true });
    const before = resolveStore({ cwd: tmp });
    expect(before.source).toBe("legacy-walk");

    // Create the common-dir store -> now it binds there.
    const commonStore = gitCommonStoreDir(tmp)!;
    fs.mkdirSync(commonStore, { recursive: true });
    const after = resolveStore({ cwd: tmp });
    expect(after.source).toBe("git-common");
    expect(samePath(after.storeDir, commonStore)).toBe(true);
  });

  it("every linked worktree resolves to the SAME common-dir store", () => {
    initRepo(tmp);
    const commonStore = gitCommonStoreDir(tmp)!;
    fs.mkdirSync(commonStore, { recursive: true });

    const wt = path.join(tmp, "..", path.basename(tmp) + "-wt");
    execFileSync("git", ["worktree", "add", wt, "-b", "feature"], { cwd: tmp });
    try {
      expect(isLinkedWorktree(wt)).toBe(true);
      expect(isLinkedWorktree(tmp)).toBe(false);

      const fromMain = resolveStore({ cwd: tmp });
      const fromWt = resolveStore({ cwd: wt });
      expect(fromMain.source).toBe("git-common");
      expect(fromWt.source).toBe("git-common");
      expect(samePath(fromMain.storeDir, fromWt.storeDir)).toBe(true);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: tmp });
    }
  });

  it("getGitCommonDir is shared across worktrees; null outside a repo", () => {
    expect(getGitCommonDir(tmp)).toBeNull();
    initRepo(tmp);
    const common = getGitCommonDir(tmp)!;
    expect(common).not.toBeNull();
    expect(path.basename(gitCommonStoreDir(tmp)!)).toBe(STORE_SUBDIR);
  });

  describe("storeDirForInit", () => {
    it("fresh git repo → under the git common dir", () => {
      initRepo(tmp);
      const loc = storeDirForInit(tmp);
      expect(loc.underGit).toBe(true);
      // dir not created yet, so compare the computed paths directly.
      expect(loc.dir).toBe(gitCommonStoreDir(tmp)!);
    });

    it("non-git dir → cwd/.sudocode", () => {
      const loc = storeDirForInit(tmp);
      expect(loc.underGit).toBe(false);
      expect(loc.dir).toBe(path.join(tmp, ".sudocode"));
    });

    it("existing git-common store is reused", () => {
      initRepo(tmp);
      fs.mkdirSync(gitCommonStoreDir(tmp)!, { recursive: true });
      const loc = storeDirForInit(tmp);
      expect(loc.underGit).toBe(true);
      expect(samePath(loc.dir, gitCommonStoreDir(tmp)!)).toBe(true);
    });

    it("linked worktree resolves to the shared store, flagged as linked", () => {
      initRepo(tmp);
      fs.mkdirSync(gitCommonStoreDir(tmp)!, { recursive: true });
      const wt = path.join(tmp, "..", path.basename(tmp) + "-wt2");
      execFileSync("git", ["worktree", "add", wt, "-b", "feat2"], { cwd: tmp });
      try {
        const loc = storeDirForInit(wt);
        expect(loc.linkedWorktree).toBe(true);
        expect(samePath(loc.dir, gitCommonStoreDir(wt)!)).toBe(true);
      } finally {
        execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: tmp });
      }
    });
  });
});

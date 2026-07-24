/**
 * Tests for the store<->git sync hooks (pre-commit export, post-merge import).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { installSyncHooks } from "../../src/git-hooks.js";

describe("installSyncHooks", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudocode-hooks-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips when not inside a git repo", () => {
    const res = installSyncHooks(dir);
    expect(res).toEqual({ preCommit: "skipped", postMerge: "skipped" });
  });

  it("installs both managed hooks inside a git repo", () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const res = installSyncHooks(dir);
    expect(res.preCommit).toBe("installed");
    expect(res.postMerge).toBe("installed");

    const pre = fs.readFileSync(path.join(dir, ".git/hooks/pre-commit"), "utf8");
    const post = fs.readFileSync(path.join(dir, ".git/hooks/post-merge"), "utf8");
    expect(pre).toContain("sudocode-store-sync");
    expect(pre).toContain("sudocode export --stage --quiet");
    expect(post).toContain("sudocode import --quiet");
    // executable
    expect(fs.statSync(path.join(dir, ".git/hooks/pre-commit")).mode & 0o111).toBeTruthy();
  });

  it("is idempotent (second install reports exists, no duplicate block)", () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    installSyncHooks(dir);
    const res2 = installSyncHooks(dir);
    expect(res2.preCommit).toBe("exists");
    expect(res2.postMerge).toBe("exists");

    const pre = fs.readFileSync(path.join(dir, ".git/hooks/pre-commit"), "utf8");
    expect(pre.match(/sudocode-store-sync/g)?.length).toBe(1);
  });

  it("appends to a foreign existing hook without clobbering it", () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const preCommitPath = path.join(dir, ".git/hooks/pre-commit");
    fs.writeFileSync(preCommitPath, "#!/bin/sh\necho custom-user-hook\n");
    const res = installSyncHooks(dir);
    expect(res.preCommit).toBe("installed");

    const pre = fs.readFileSync(preCommitPath, "utf8");
    expect(pre).toContain("echo custom-user-hook"); // preserved
    expect(pre).toContain("sudocode-store-sync"); // appended
  });
});

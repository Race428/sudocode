/**
 * Unit tests for store backup (orphan-ref export/restore + hook install).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  runBackup,
  restoreBackup,
  installBackupHook,
  findRestorableBackupRef,
  BACKUP_REF,
} from "../../src/backup.js";
import { gitCommonStoreDir } from "../../src/store-resolution.js";
import { initDatabase } from "../../src/db.js";

function initRepo(dir: string) {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
}

function refExists(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", BACKUP_REF], { cwd });
    return true;
  } catch {
    return false;
  }
}

describe("store backup", () => {
  let repo: string;
  let storeDir: string;

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backup-")));
    initRepo(repo);
    storeDir = gitCommonStoreDir(repo)!;
    fs.mkdirSync(storeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("runBackup returns null with no data and no repo", () => {
    expect(runBackup({ storeDir, cwd: repo })).toBeNull(); // no jsonl yet
    expect(refExists(repo)).toBe(false);
  });

  it("backs up JSONL into the orphan ref and round-trips via restore", async () => {
    const specs = '{"id":"s-1","title":"Spec One","file_path":"specs/s-1.md"}\n';
    const issues = '{"id":"i-1","title":"Issue One","status":"open"}\n';
    fs.writeFileSync(path.join(storeDir, "specs.jsonl"), specs);
    fs.writeFileSync(path.join(storeDir, "issues.jsonl"), issues);

    const commit = runBackup({ storeDir, cwd: repo });
    expect(commit).not.toBeNull();
    expect(refExists(repo)).toBe(true);

    // The ref's tree holds the JSONL blobs.
    const stored = execFileSync("git", ["cat-file", "-p", `${BACKUP_REF}:issues.jsonl`], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(stored).toContain("i-1");

    // Wipe the store, then restore from the ref.
    fs.rmSync(path.join(storeDir, "specs.jsonl"));
    fs.rmSync(path.join(storeDir, "issues.jsonl"));
    const db = initDatabase({ path: path.join(storeDir, "cache.db") });
    try {
      const ok = await restoreBackup({ storeDir, cwd: repo, db });
      expect(ok).toBe(true);
      expect(fs.existsSync(path.join(storeDir, "issues.jsonl"))).toBe(true);
      const row = db.prepare("SELECT id FROM issues WHERE id = ?").get("i-1") as { id: string } | undefined;
      expect(row?.id).toBe("i-1");
    } finally {
      db.close();
    }
  });

  it("is a no-op when the data has not changed (same tree)", () => {
    fs.writeFileSync(path.join(storeDir, "issues.jsonl"), '{"id":"i-1"}\n');
    const first = runBackup({ storeDir, cwd: repo });
    const second = runBackup({ storeDir, cwd: repo });
    expect(second).toBe(first); // unchanged tree → same commit, no new snapshot
  });

  it("findRestorableBackupRef prefers the local ref, else a remote-tracking ref", () => {
    // None yet.
    expect(findRestorableBackupRef(repo)).toBeNull();

    // A remote-tracking ref (as a fresh clone would have) is found as a fallback.
    fs.writeFileSync(path.join(storeDir, "issues.jsonl"), '{"id":"i-1"}\n');
    const commit = runBackup({ storeDir, cwd: repo })!;
    execFileSync("git", ["update-ref", "refs/remotes/origin/sudocode-store", commit], { cwd: repo });
    execFileSync("git", ["update-ref", "-d", BACKUP_REF], { cwd: repo }); // drop local
    expect(findRestorableBackupRef(repo)).toBe("refs/remotes/origin/sudocode-store");

    // Local ref wins when both exist.
    execFileSync("git", ["update-ref", BACKUP_REF, commit], { cwd: repo });
    expect(findRestorableBackupRef(repo)).toBe(BACKUP_REF);
  });

  it("restore works from a remote-tracking ref only (fresh-clone case)", async () => {
    fs.writeFileSync(path.join(storeDir, "issues.jsonl"), '{"id":"i-9","title":"Cloned","status":"open"}\n');
    const commit = runBackup({ storeDir, cwd: repo })!;
    // Simulate a fresh clone: only origin/sudocode-store exists, no local branch, empty store.
    execFileSync("git", ["update-ref", "refs/remotes/origin/sudocode-store", commit], { cwd: repo });
    execFileSync("git", ["update-ref", "-d", BACKUP_REF], { cwd: repo });
    fs.rmSync(path.join(storeDir, "issues.jsonl"));

    const db = initDatabase({ path: path.join(storeDir, "cache.db") });
    try {
      expect(await restoreBackup({ storeDir, cwd: repo, db })).toBe(true);
      const row = db.prepare("SELECT id FROM issues WHERE id = ?").get("i-9") as { id: string } | undefined;
      expect(row?.id).toBe("i-9");
    } finally {
      db.close();
    }
  });

  it("installBackupHook writes an executable pre-push hook, idempotently", () => {
    expect(installBackupHook(repo)).toBe("installed");
    const hookPath = path.join(gitCommonStoreDir(repo)!, "..", "hooks", "pre-push");
    expect(fs.existsSync(hookPath)).toBe(true);
    expect(fs.readFileSync(hookPath, "utf8")).toContain("sudocode backup");
    // executable bit
    expect(fs.statSync(hookPath).mode & 0o111).not.toBe(0);
    expect(installBackupHook(repo)).toBe("exists");
  });
});

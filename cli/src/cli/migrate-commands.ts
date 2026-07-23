/**
 * CLI handler for `sudocode migrate` — move an existing in-worktree .sudocode
 * store to the shared store under the git common dir, so every worktree/tool
 * agrees on it automatically.
 *
 * ADDITIVE + REVERSIBLE: copies data into <common>/sudocode, builds its cache,
 * installs the backup hook, and seeds the backup ref. It does NOT untrack or
 * delete anything in the worktree — the old .sudocode/*.jsonl simply stop being
 * read (resolution now prefers the git-common store). Untracking the old JSONL
 * and removing the merge stack are the destructive follow-up (intentionally
 * deferred). Undo = delete <common>/sudocode.
 */

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { initDatabase } from "../db.js";
import { getGitCommonDir, gitCommonStoreDir } from "../store-resolution.js";
import { installBackupHook, runBackup } from "../backup.js";

interface MigrateCtx {
  db: Database.Database;
  outputDir: string;
  jsonOutput: boolean;
}

const COPY_FILES = ["specs.jsonl", "issues.jsonl", "config.json"];

export async function handleMigrate(ctx: MigrateCtx): Promise<void> {
  const cwd = process.cwd();
  const common = getGitCommonDir(cwd);
  const log = (...a: unknown[]) => {
    if (!ctx.jsonOutput) console.log(...a);
  };

  if (!common) {
    if (ctx.jsonOutput) console.log(JSON.stringify({ success: false, reason: "not-a-git-repo" }));
    else console.error(chalk.red("✗ Not inside a git repository — nothing to migrate"));
    process.exitCode = 1;
    return;
  }

  const target = gitCommonStoreDir(cwd)!;
  const legacy = ctx.outputDir;
  const alreadyThere = path.resolve(legacy) === path.resolve(target);

  if (!alreadyThere && fs.existsSync(path.join(target, "cache.db"))) {
    // Store already lives under .git but this invocation resolved a stray legacy
    // dir — just ensure the hook/backup and report.
    installBackupHook(cwd);
    runBackup({ storeDir: target, cwd });
    log(chalk.green("✓ Store already migrated"), chalk.cyan(target));
    if (ctx.jsonOutput) console.log(JSON.stringify({ success: true, target, migrated: false }));
    return;
  }

  if (alreadyThere) {
    installBackupHook(cwd);
    runBackup({ storeDir: target, cwd });
    log(chalk.green("✓ Store already at the shared location"), chalk.cyan(target));
    if (ctx.jsonOutput) console.log(JSON.stringify({ success: true, target, migrated: false }));
    return;
  }

  // Copy data into the shared store (non-destructive — legacy left intact).
  fs.mkdirSync(target, { recursive: true });
  const copied: string[] = [];
  for (const f of COPY_FILES) {
    const src = path.join(legacy, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(target, f));
      copied.push(f);
    }
  }

  // Prefer copying the live cache.db directly so EVERY table carries over —
  // including cache-only data that JSONL doesn't hold (executions, the event
  // audit log, prompt_templates). A JSONL rebuild would silently drop those.
  // Use SQLite's online backup so the copy is consistent even if a tool is mid-
  // write, and it folds in any WAL. Fall back to a JSONL rebuild only when there
  // is no legacy cache.db (fresh/partial store).
  const targetDb = path.join(target, "cache.db");
  const legacyDb = path.join(legacy, "cache.db");
  if (fs.existsSync(legacyDb)) {
    const Database = (await import("better-sqlite3")).default;
    const src = new Database(legacyDb, { readonly: true });
    try {
      await src.backup(targetDb);
    } finally {
      src.close();
    }
    // Open once to run any pending migrations idempotently (schema stays current).
    initDatabase({ path: targetDb }).close();
    copied.push("cache.db");
  } else {
    const db = initDatabase({ path: targetDb });
    try {
      const { importFromJSONL } = await import("../import.js");
      await importFromJSONL(db, { inputDir: target, resolveCollisions: true });
    } finally {
      db.close();
    }
  }

  installBackupHook(cwd);
  const commit = runBackup({ storeDir: target, cwd });

  if (ctx.jsonOutput) {
    console.log(JSON.stringify({ success: true, target, migrated: true, copied, backupCommit: commit }, null, 2));
    return;
  }
  console.log(chalk.green("✓ Migrated sudocode store to shared location"));
  console.log(chalk.gray(`  Store:  ${target}`));
  console.log(chalk.gray(`  Copied: ${copied.join(", ") || "(nothing)"}`));
  console.log(chalk.gray("  Shared across all worktrees; every tool now resolves here automatically."));
  console.log(chalk.gray("  Backup hook installed (pre-push → refs/heads/sudocode-store)."));
  console.log(
    chalk.yellow(
      "  Note: the old .sudocode/*.jsonl are left tracked but unused. Removing them\n" +
      "        (git rm) and retiring the merge driver is a separate, deliberate step."
    )
  );
}

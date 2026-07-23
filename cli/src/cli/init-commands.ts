/**
 * CLI handlers for init command
 */

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { initDatabase } from "../db.js";
import type Database from "better-sqlite3";
import { PROJECT_CONFIG_FILE, LOCAL_CONFIG_FILE, getProjectConfig } from "../config.js";
import { storeDirForInit } from "../store-resolution.js";
import { installBackupHook, restoreBackup, findRestorableBackupRef } from "../backup.js";
import type { StorageMode } from "@sudocode-ai/types";

/**
 * Build .gitignore content based on sourceOfTruth mode.
 *
 * In jsonl mode: specs/ and issues/ dirs are derived (gitignored)
 * In markdown mode: specs/ and issues/ dirs are authoritative (tracked)
 */
export function buildGitignore(sourceOfTruth: StorageMode): string {
  const lines = [
    "cache.db*",
    "worktrees/",
    "config.local.json",
    "merge-driver.log",
    "telemetry-buffer.jsonl",
    "telemetry-flush.json",
  ];

  if (sourceOfTruth === "jsonl") {
    // Markdown dirs are derived from JSONL — gitignore them
    lines.splice(1, 0, "issues/", "specs/");
  }
  // In markdown mode, specs/ and issues/ are the source of truth — track them

  return lines.join("\n");
}

export interface InitOptions {
  dir?: string;
  jsonOutput?: boolean;
}

/**
 * Check if sudocode is initialized in a directory
 */
export function isInitialized(dir: string): boolean {
  // Check for either project config OR local config (for backwards compatibility)
  const projectConfigPath = path.join(dir, PROJECT_CONFIG_FILE);
  const localConfigPath = path.join(dir, LOCAL_CONFIG_FILE);
  const dbPath = path.join(dir, "cache.db");
  const specsDir = path.join(dir, "specs");
  const issuesDir = path.join(dir, "issues");

  return (
    (fs.existsSync(projectConfigPath) || fs.existsSync(localConfigPath)) &&
    fs.existsSync(dbPath) &&
    fs.existsSync(specsDir) &&
    fs.existsSync(issuesDir)
  );
}

/**
 * Perform sudocode initialization
 */
export async function performInitialization(
  options: InitOptions = {}
): Promise<void> {
  const jsonOutput = options.jsonOutput || false;

  // With no explicit dir, resolve git-awarely: git repos get a shared store under
  // the common .git dir (every worktree/tool agrees on it, JSONL untracked by
  // construction); non-git dirs keep the legacy cwd/.sudocode layout. An explicit
  // dir (tests, `--dir`) is honored verbatim.
  let underGit = false;
  let linkedWorktree = false;
  let dir: string;
  if (options.dir) {
    dir = options.dir;
  } else {
    const loc = storeDirForInit();
    dir = loc.dir;
    underGit = loc.underGit;
    linkedWorktree = loc.linkedWorktree;
  }

  // Create directory structure
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "specs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "issues"), { recursive: true });

  // Track what was preserved
  const preserved: string[] = [];

  // Initialize database only if it doesn't exist
  const dbPath = path.join(dir, "cache.db");
  const dbExists = fs.existsSync(dbPath);
  let database: Database.Database;

  if (dbExists) {
    preserved.push("cache.db");
    // Open existing database
    database = initDatabase({ path: dbPath });
  } else {
    // Ensure the database directory exists before creating the database
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    database = initDatabase({ path: dbPath });
  }

  // Fresh shared store on a clone: the store lives under .git (not cloned), but
  // the data rides the sudocode-store backup ref (local, or origin/* after
  // clone). Restore it so `git clone` + `sudocode init` = data present, not an
  // empty store.
  let restoredFromBackup = false;
  if (!dbExists && underGit && findRestorableBackupRef(process.cwd())) {
    restoredFromBackup = await restoreBackup({
      storeDir: dir,
      cwd: process.cwd(),
      db: database,
    });
    if (restoredFromBackup && !jsonOutput) {
      console.log(chalk.blue("Restored store from backup ref (sudocode-store)"));
    }
  }

  // Create config.json (project config, git-tracked)
  // Only create if it doesn't exist to preserve existing settings
  const projectConfigPath = path.join(dir, PROJECT_CONFIG_FILE);
  if (!fs.existsSync(projectConfigPath)) {
    const projectConfig = {
      // sourceOfTruth defaults to "jsonl" when not specified
    };
    fs.writeFileSync(
      projectConfigPath,
      JSON.stringify(projectConfig, null, 2),
      "utf8"
    );
  }

  // Create config.local.json (local config, gitignored)
  // Only create if it doesn't exist to preserve existing settings
  const localConfigPath = path.join(dir, LOCAL_CONFIG_FILE);
  if (!fs.existsSync(localConfigPath)) {
    const localConfig = {
      worktree: {
        worktreeStoragePath: ".sudocode/worktrees",
        autoCreateBranches: true,
        autoDeleteBranches: false,
        enableSparseCheckout: false,
        branchPrefix: "sudocode",
        cleanupOrphanedWorktreesOnStartup: false,
      },
      editor: {
        editorType: "vs-code",
      },
    };
    fs.writeFileSync(
      localConfigPath,
      JSON.stringify(localConfig, null, 2),
      "utf8"
    );
  }

  let hasSpecsData = false;
  let hasIssuesData = false;
  // Create empty JSONL files only if they don't exist
  const specsPath = path.join(dir, "specs.jsonl");
  if (fs.existsSync(specsPath)) {
    preserved.push("specs.jsonl");
    const content = fs.readFileSync(specsPath, "utf8");
    hasSpecsData = content.trim().length > 0;
  } else {
    fs.writeFileSync(specsPath, "", "utf8");
  }

  const issuesPath = path.join(dir, "issues.jsonl");
  if (fs.existsSync(issuesPath)) {
    preserved.push("issues.jsonl");
    const content = fs.readFileSync(issuesPath, "utf8");
    hasIssuesData = content.trim().length > 0;
  } else {
    fs.writeFileSync(issuesPath, "", "utf8");
  }

  // Skip the local-JSONL import when we already restored from the backup ref
  // (restoreBackup imported into the db and wrote these same JSONL files).
  if ((hasSpecsData || hasIssuesData) && !restoredFromBackup) {
    try {
      if (!jsonOutput) {
        console.log(chalk.blue("Importing from existing JSONL files..."));
      }
      const { importFromJSONL } = await import("../import.js");
      const result = await importFromJSONL(database, {
        inputDir: dir,
        resolveCollisions: true,
      });

      // Report import results
      if (!jsonOutput) {
        if (result.specs.added > 0 || result.specs.updated > 0) {
          console.log(
            chalk.gray(
              `  Specs: ${result.specs.added} added, ${result.specs.updated} updated`
            )
          );
        }
        if (result.issues.added > 0 || result.issues.updated > 0) {
          console.log(
            chalk.gray(
              `  Issues: ${result.issues.added} added, ${result.issues.updated} updated`
            )
          );
        }
        if (result.collisions.length > 0) {
          console.log(
            chalk.yellow(`  Resolved ${result.collisions.length} ID collisions`)
          );
        }
      }
    } catch (importError) {
      // Log warning but continue with initialization
      if (!jsonOutput) {
        console.log(
          chalk.yellow(
            `  Warning: Failed to import JSONL data - ${importError instanceof Error ? importError.message : String(importError)}`
          )
        );
      }
    }
  }

  // Generate .gitignore based on sourceOfTruth config. Under the git common dir
  // (.git/sudocode) everything is already outside every branch's work tree, so
  // there is nothing for git to track and a .gitignore there is inert — skip it.
  if (!underGit) {
    const gitignorePath = path.join(dir, ".gitignore");
    const projectConfig = getProjectConfig(dir);
    const sourceOfTruth: StorageMode = projectConfig.sourceOfTruth || "jsonl";
    const gitignoreContent = buildGitignore(sourceOfTruth);
    fs.writeFileSync(gitignorePath, gitignoreContent, "utf8");
  }

  database.close();

  // Under the shared .git store, install the pre-push backup hook (the store is
  // untracked, so this is its only durable/off-machine path). Idempotent.
  if (underGit) {
    installBackupHook(process.cwd());
  }

  if (jsonOutput) {
    // Emit a machine-readable summary so callers (e.g. the MCP server) can parse
    // init's result over stdio instead of scraping human text.
    console.log(
      JSON.stringify(
        {
          success: true,
          storeDir: dir,
          dbPath,
          initialized: true,
          underGit,
          linkedWorktree,
          restoredFromBackup,
          preserved,
        },
        null,
        2
      )
    );
    return;
  }

  if (linkedWorktree) {
    console.log(
      chalk.green("✓ sudocode store (shared via .git) is"),
      chalk.cyan(dir)
    );
    console.log(
      chalk.gray("  This linked worktree shares the main checkout's store.")
    );
  } else {
    console.log(chalk.green("✓ Initialized sudocode in"), chalk.cyan(dir));
  }
  console.log(chalk.gray(`  Database: ${dbPath}`));
  if (underGit) {
    console.log(
      chalk.gray("  Shared across all worktrees; untracked (backed up via `sudocode backup`).")
    );
  }

  if (preserved.length > 0) {
    console.log(chalk.yellow(`  Preserved existing: ${preserved.join(", ")}`));
  }
}

/**
 * Handle init command
 */
export async function handleInit(options: InitOptions): Promise<void> {
  try {
    await performInitialization(options);
  } catch (error) {
    console.error(chalk.red("✗ Initialization failed"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

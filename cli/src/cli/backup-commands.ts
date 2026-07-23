/**
 * CLI handlers for `sudocode backup` (store backup to the orphan ref).
 */

import chalk from "chalk";
import type Database from "better-sqlite3";
import { runBackup, restoreBackup, BACKUP_BRANCH } from "../backup.js";

interface BackupCtx {
  db: Database.Database;
  outputDir: string;
  jsonOutput: boolean;
}

export async function handleBackup(
  ctx: BackupCtx,
  options: { restore?: boolean } = {}
): Promise<void> {
  const cwd = process.cwd();

  if (options.restore) {
    const ok = await restoreBackup({ storeDir: ctx.outputDir, cwd, db: ctx.db });
    if (ctx.jsonOutput) {
      console.log(JSON.stringify({ success: ok, restored: ok }, null, 2));
    } else if (ok) {
      console.log(chalk.green(`✓ Restored store from ${BACKUP_BRANCH}`));
    } else {
      console.log(chalk.yellow(`No ${BACKUP_BRANCH} backup ref found — nothing to restore`));
    }
    return;
  }

  const commit = runBackup({ storeDir: ctx.outputDir, cwd });
  if (ctx.jsonOutput) {
    console.log(JSON.stringify({ success: commit !== null, commit }, null, 2));
  } else if (commit) {
    console.log(chalk.green(`✓ Backed up store to ${BACKUP_BRANCH}`), chalk.gray(commit.slice(0, 10)));
  } else {
    console.log(chalk.yellow("Nothing to back up (no git repo or no store data)"));
  }
}

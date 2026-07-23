/**
 * Database initialization and connection management
 */

import Database from "better-sqlite3";
import * as schema from "@sudocode-ai/types/schema";
import { runMigrations } from "@sudocode-ai/types/migrations";

export interface DatabaseOptions {
  path: string;
  verbose?: boolean;
  /** busy_timeout in ms for cross-process writers sharing one cache.db (default: 5000) */
  timeout?: number;
}

/**
 * Initialize and configure the SQLite database
 */
export function initDatabase(options: DatabaseOptions): Database.Database {
  // WAL (set via schema.DB_CONFIG) lets readers and one writer coexist, but a
  // second writer still gets SQLITE_BUSY immediately. With a shared store under
  // .git/, many worktree/agent processes hit the same cache.db, so a busy_timeout
  // is required to make concurrent writers wait for the lock instead of throwing.
  const db = new Database(options.path, {
    verbose: options.verbose ? console.log : undefined,
    timeout: options.timeout ?? 5000,
  });

  // Apply database configuration
  db.exec(schema.DB_CONFIG);

  // Create all tables
  for (const table of schema.ALL_TABLES) {
    db.exec(table);
  }

  // Run any pending migrations BEFORE creating indexes
  // (migrations might alter table schemas that indexes depend on)
  runMigrations(db);

  // Create all indexes
  for (const indexes of schema.ALL_INDEXES) {
    db.exec(indexes);
  }

  // Create all views
  for (const view of schema.ALL_VIEWS) {
    db.exec(view);
  }

  return db;
}

/**
 * Get or create a database connection
 */
export function getDatabase(path: string): Database.Database {
  return initDatabase({ path });
}

/**
 * Create a new transaction
 */
export function withTransaction<T>(
  db: Database.Database,
  callback: (db: Database.Database) => T
): T {
  const savepoint = `sp_${Date.now()}`;

  try {
    db.exec(`SAVEPOINT ${savepoint}`);
    const result = callback(db);
    db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}`);
    throw error;
  }
}

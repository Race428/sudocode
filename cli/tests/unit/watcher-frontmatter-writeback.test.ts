/**
 * Test orphaned file handling and frontmatter preservation
 * (DB/JSONL is source of truth - markdown files without DB entries are orphaned)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase } from "../../src/db.js";
import { startWatcher } from "../../src/watcher.js";
import type Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("File Watcher - Orphaned Files and Frontmatter", () => {
  let db: Database.Database;
  let tempDir: string;
  let control: ReturnType<typeof startWatcher> | null = null;

  beforeEach(() => {
    // Create a fresh in-memory database for each test
    db = initDatabase({ path: ":memory:" });

    // Create temporary directory for files
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "sudocode-frontmatter-test-")
    );

    // Create directory structure
    fs.mkdirSync(path.join(tempDir, "specs"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "issues"), { recursive: true });

    // Create empty JSONL files
    fs.writeFileSync(path.join(tempDir, "specs.jsonl"), "", "utf8");
    fs.writeFileSync(path.join(tempDir, "issues.jsonl"), "", "utf8");

    // Create config.json
    const config = {
      version: "1.0.0",
      id_prefix: {
        spec: "SPEC",
        issue: "ISSUE",
      },
    };
    fs.writeFileSync(
      path.join(tempDir, "config.json"),
      JSON.stringify(config, null, 2)
    );
  });

  afterEach(async () => {
    // Stop watcher if it's running
    if (control) {
      await control.stop();
      control = null;
    }

    // Close database
    db.close();

    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should preserve orphaned spec file without frontmatter (never delete user files)", async () => {
    const logs: string[] = [];
    const errors: Error[] = [];

    // Create a spec file WITHOUT frontmatter (and no DB entry)
    // The watcher cannot map it to an entity - it must be left alone
    const specPath = path.join(tempDir, "specs", "new-spec-without-fm.md");
    const content = `# Test New Spec

This is a test spec without any frontmatter and no DB entry.
The watcher should leave it alone.
`;
    fs.writeFileSync(specPath, content, "utf8");

    // Verify file exists before watcher starts
    expect(fs.existsSync(specPath)).toBe(true);

    // Start watcher with ignoreInitial: false to detect existing files
    control = startWatcher({
      db,
      baseDir: tempDir,
      ignoreInitial: false,
      onLog: (msg) => logs.push(msg),
      onError: (err) => errors.push(err),
    });

    // Wait for watcher to process the file
    await new Promise((resolve) => setTimeout(resolve, 800));

    // File must NOT be deleted
    expect(fs.existsSync(specPath)).toBe(true);

    // Verify it was logged as ignored
    expect(
      logs.some((log) => log.includes("Ignoring") && log.includes("new-spec-without-fm"))
    ).toBe(true);

    // No errors should occur
    expect(errors.length).toBe(0);
  });

  it("should preserve orphaned spec file with invalid-format id (never delete user files)", async () => {
    const logs: string[] = [];
    const errors: Error[] = [];

    // Create a spec file WITH frontmatter but an id that doesn't match the
    // hash-id format (s-xxxx). It can't be imported, but must not be deleted.
    const specPath = path.join(tempDir, "specs", "existing-fm.md");
    const content = `---
id: SPEC-999
title: Orphaned Spec
priority: 1
created_at: '2025-01-01 00:00:00'
---

# Orphaned Spec

This spec has frontmatter but an invalid-format id and no DB entry.
`;
    fs.writeFileSync(specPath, content, "utf8");

    // Verify file exists before watcher starts
    expect(fs.existsSync(specPath)).toBe(true);

    // Start watcher
    control = startWatcher({
      db,
      baseDir: tempDir,
      ignoreInitial: false,
      onLog: (msg) => logs.push(msg),
      onError: (err) => errors.push(err),
    });

    // Wait for watcher to process
    await new Promise((resolve) => setTimeout(resolve, 800));

    // File must NOT be deleted
    expect(fs.existsSync(specPath)).toBe(true);

    // Verify it was logged as ignored
    expect(
      logs.some((log) => log.includes("Ignoring") && log.includes("existing-fm"))
    ).toBe(true);

    // No errors should occur
    expect(errors.length).toBe(0);
  });

  it("should import orphaned spec file with valid hash id instead of deleting it", async () => {
    const logs: string[] = [];
    const errors: Error[] = [];

    // Create a spec file with a valid hash-format id that the DB doesn't know
    // (e.g., hand-authored by an agent, or cache.db is stale). The watcher
    // should import it, preserving the declared id - never delete or re-mint.
    const specPath = path.join(tempDir, "specs", "hand-authored.md");
    const content = `---
id: s-zz99
title: Hand Authored Spec
priority: 1
created_at: '2025-01-01 00:00:00'
---

# Hand Authored Spec

Created directly as markdown by an agent.
`;
    fs.writeFileSync(specPath, content, "utf8");

    control = startWatcher({
      db,
      baseDir: tempDir,
      ignoreInitial: false,
      onLog: (msg) => logs.push(msg),
      onError: (err) => errors.push(err),
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    // File preserved and entity imported with its declared id
    expect(fs.existsSync(specPath)).toBe(true);
    const { getSpec } = await import("../../src/operations/specs.js");
    const imported = getSpec(db, "s-zz99");
    expect(imported).not.toBeNull();
    expect(imported?.title).toBe("Hand Authored Spec");

    expect(errors.length).toBe(0);
  });

  it("should preserve valid spec file with matching DB entry", async () => {
    const logs: string[] = [];
    const errors: Error[] = [];

    // First create the spec in the database (DB is source of truth)
    const { createSpec, getSpec } = await import("../../src/operations/specs.js");
    createSpec(db, {
      id: "s-valid",
      uuid: "test-uuid-valid",
      title: "Valid Spec",
      file_path: "specs/valid-spec.md",
      content: "# Valid Spec\n\nThis spec exists in both DB and markdown.",
      priority: 1,
    });

    // Create matching markdown file
    const specPath = path.join(tempDir, "specs", "valid-spec.md");
    const content = `---
id: s-valid
title: Valid Spec
priority: 1
---

# Valid Spec

This spec exists in both DB and markdown.
`;
    fs.writeFileSync(specPath, content, "utf8");

    // Verify file exists before watcher starts
    expect(fs.existsSync(specPath)).toBe(true);

    // Start watcher
    control = startWatcher({
      db,
      baseDir: tempDir,
      ignoreInitial: false,
      onLog: (msg) => logs.push(msg),
      onError: (err) => errors.push(err),
    });

    // Wait for watcher to process
    await new Promise((resolve) => setTimeout(resolve, 800));

    // File should NOT be deleted (it has a matching DB entry)
    expect(fs.existsSync(specPath)).toBe(true);

    // Verify spec still exists in database
    const spec = getSpec(db, "s-valid");
    expect(spec).not.toBeNull();
    expect(spec?.title).toBe("Valid Spec");

    // No errors should occur
    expect(errors.length).toBe(0);
  });
});

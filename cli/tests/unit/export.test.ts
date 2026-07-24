/**
 * Unit tests for export operations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initDatabase } from '../../src/db.js';
import { createSpec, updateSpec } from '../../src/operations/specs.js';
import { createIssue, updateIssue } from '../../src/operations/issues.js';
import { addRelationship } from '../../src/operations/relationships.js';
import { addTags } from '../../src/operations/tags.js';
import {
  specToJSONL,
  issueToJSONL,
  exportSpecsToJSONL,
  exportIssuesToJSONL,
  exportToJSONL,
  maybeAutoExport,
  ExportDebouncer,
  createDebouncedExport,
} from '../../src/export.js';
import { updateProjectConfig } from '../../src/config.js';
import { readJSONL } from '../../src/jsonl.js';
import type Database from 'better-sqlite3';
import type { SpecJSONL, IssueJSONL } from '../../src/types.js';

describe('Export Operations', () => {
  let db: Database.Database;
  let testDir: string;

  beforeEach(() => {
    db = initDatabase({ path: ':memory:' });

    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-'));
  });

  afterEach(() => {
    db.close();

    // Clean up temporary test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('maybeAutoExport', () => {
    it('exports by default (no config)', async () => {
      createIssue(db, { id: 'i-ax', title: 'Auto on', content: '' });
      await maybeAutoExport(db, testDir);
      const issues = await readJSONL(path.join(testDir, 'issues.jsonl'));
      expect(issues.some((i: any) => i.id === 'i-ax')).toBe(true);
    });

    it('skips export when autoExport is false', async () => {
      updateProjectConfig(testDir, { autoExport: false });
      createIssue(db, { id: 'i-skip', title: 'Decoupled', content: '' });
      await maybeAutoExport(db, testDir);
      expect(fs.existsSync(path.join(testDir, 'issues.jsonl'))).toBe(false);
    });

    it('exports again once autoExport is re-enabled', async () => {
      updateProjectConfig(testDir, { autoExport: false });
      createIssue(db, { id: 'i-on', title: 'Back on', content: '' });
      await maybeAutoExport(db, testDir);
      expect(fs.existsSync(path.join(testDir, 'issues.jsonl'))).toBe(false);

      updateProjectConfig(testDir, { autoExport: true });
      await maybeAutoExport(db, testDir);
      const issues = await readJSONL(path.join(testDir, 'issues.jsonl'));
      expect(issues.some((i: any) => i.id === 'i-on')).toBe(true);
    });
  });

  describe('specToJSONL', () => {
    it('should convert spec with relationships and tags to JSONL format', () => {
      // Create specs
      const spec1 = createSpec(db, {
        id: 'spec-001',
        title: 'Auth System',
        file_path: '.sudocode/specs/auth.md',
        content: '# Auth',
      });

      const spec2 = createSpec(db, {
        id: 'spec-002',
        title: 'Database',
        file_path: '.sudocode/specs/db.md',
      });

      // Add relationship
      addRelationship(db, {
        from_id: 'spec-001',
        from_type: 'spec',
        to_id: 'spec-002',
        to_type: 'spec',
        relationship_type: 'related',
      });

      // Add tags
      addTags(db, 'spec-001', 'spec', ['backend', 'security']);

      // Convert to JSONL
      const jsonl = specToJSONL(db, spec1);

      expect(jsonl.id).toBe('spec-001');
      expect(jsonl.title).toBe('Auth System');
      expect(jsonl.relationships).toHaveLength(1);
      expect(jsonl.relationships[0]).toEqual({
        from: 'spec-001',
        from_type: 'spec',
        to: 'spec-002',
        to_type: 'spec',
        type: 'related',
      });
      expect(jsonl.tags).toHaveLength(2);
      expect(jsonl.tags).toContain('backend');
      expect(jsonl.tags).toContain('security');
    });

    it('should handle spec with no relationships or tags', () => {
      const spec = createSpec(db, {
        id: 'spec-001',
        title: 'Simple Spec',
        file_path: 'simple.md',
      });

      const jsonl = specToJSONL(db, spec);

      expect(jsonl.relationships).toHaveLength(0);
      expect(jsonl.tags).toHaveLength(0);
    });
  });

  describe('issueToJSONL', () => {
    it('should convert issue with relationships and tags to JSONL format', () => {
      // Create issues
      const issue1 = createIssue(db, {
        id: 'issue-001',
        title: 'Implement OAuth',
      });

      const issue2 = createIssue(db, {
        id: 'issue-002',
        title: 'Setup database',
      });

      // Add relationship
      addRelationship(db, {
        from_id: 'issue-001',
        from_type: 'issue',
        to_id: 'issue-002',
        to_type: 'issue',
        relationship_type: 'blocks',
      });

      // Add tags
      addTags(db, 'issue-001', 'issue', ['auth', 'backend']);

      // Convert to JSONL
      const jsonl = issueToJSONL(db, issue1);

      expect(jsonl.id).toBe('issue-001');
      expect(jsonl.title).toBe('Implement OAuth');
      expect(jsonl.relationships).toHaveLength(1);
      expect(jsonl.relationships[0]).toEqual({
        from: 'issue-001',
        from_type: 'issue',
        to: 'issue-002',
        to_type: 'issue',
        type: 'blocks',
      });
      expect(jsonl.tags).toEqual(['auth', 'backend']);
    });
  });

  describe('exportSpecsToJSONL', () => {
    beforeEach(() => {
      // Create test data
      createSpec(db, {
        id: 'spec-001',
        title: 'Spec 1',
        file_path: 'spec1.md',
      });
      createSpec(db, {
        id: 'spec-002',
        title: 'Spec 2',
        file_path: 'spec2.md',
      });
      addTags(db, 'spec-001', 'spec', ['tag1']);
    });

    it('should export all specs including archived', () => {
      // Archive one spec
      updateSpec(db, 'spec-001', { archived: true });

      const specs = exportSpecsToJSONL(db);

      // Should include both archived and non-archived specs
      expect(specs).toHaveLength(2);

      const ids = specs.map(s => s.id);
      expect(ids).toContain('spec-001');
      expect(ids).toContain('spec-002');

      const spec1 = specs.find(s => s.id === 'spec-001');
      expect(spec1?.tags).toContain('tag1');
      expect(spec1?.archived).toBe(1);
    });

    it('should support incremental export with since parameter', async () => {
      // Set beforeUpdate to a time clearly in the past
      const beforeUpdate = new Date(Date.now() - 1000);

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 50));

      const spec3 = createSpec(db, {
        id: 'spec-003',
        title: 'New Spec',
        file_path: 'spec3.md',
      });

      // Wait a bit more
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Export only specs updated since beforeUpdate
      const specs = exportSpecsToJSONL(db, { since: beforeUpdate });

      // All specs should be included since they were all created after beforeUpdate
      expect(specs.length).toBeGreaterThanOrEqual(1);
      expect(specs.some(s => s.id === 'spec-003')).toBe(true);
    });
  });

  describe('exportIssuesToJSONL', () => {
    beforeEach(() => {
      createIssue(db, {
        id: 'issue-001',
        title: 'Issue 1',
      });
      createIssue(db, {
        id: 'issue-002',
        title: 'Issue 2',
      });
      addTags(db, 'issue-001', 'issue', ['bug']);
    });

    it('should export all issues including archived', () => {
      // Archive one issue
      updateIssue(db, 'issue-001', { archived: true });

      const issues = exportIssuesToJSONL(db);

      // Should include both archived and non-archived issues
      expect(issues).toHaveLength(2);

      const issue1 = issues.find(i => i.id === 'issue-001');
      expect(issue1?.tags).toContain('bug');
      expect(issue1?.archived).toBe(1);
    });
  });

  describe('exportToJSONL', () => {
    beforeEach(() => {
      // Create test data
      createSpec(db, {
        id: 'spec-001',
        title: 'Test Spec',
        file_path: 'test.md',
      });
      createIssue(db, {
        id: 'issue-001',
        title: 'Test Issue',
      });
    });

    it('should export both specs and issues to JSONL files', async () => {
      const result = await exportToJSONL(db, { outputDir: testDir });

      expect(result.specsCount).toBe(1);
      expect(result.issuesCount).toBe(1);

      // Verify files exist
      const specsPath = path.join(testDir, 'specs.jsonl');
      const issuesPath = path.join(testDir, 'issues.jsonl');

      expect(fs.existsSync(specsPath)).toBe(true);
      expect(fs.existsSync(issuesPath)).toBe(true);

      // Read and verify content
      const specs = await readJSONL<SpecJSONL>(specsPath);
      const issues = await readJSONL<IssueJSONL>(issuesPath);

      expect(specs).toHaveLength(1);
      expect(specs[0].id).toBe('spec-001');
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe('issue-001');
    });

    it('should use custom file paths', async () => {
      await exportToJSONL(db, {
        outputDir: testDir,
        specsFile: 'custom-specs.jsonl',
        issuesFile: 'custom-issues.jsonl',
      });

      const specsPath = path.join(testDir, 'custom-specs.jsonl');
      const issuesPath = path.join(testDir, 'custom-issues.jsonl');

      expect(fs.existsSync(specsPath)).toBe(true);
      expect(fs.existsSync(issuesPath)).toBe(true);
    });
  });

  describe('ExportDebouncer', () => {
    it('should debounce multiple export triggers', async () => {
      createSpec(db, {
        id: 'spec-001',
        title: 'Test',
        file_path: 'test.md',
      });

      const debouncer = new ExportDebouncer(db, 100, { outputDir: testDir });

      // Trigger multiple times
      debouncer.trigger();
      debouncer.trigger();
      debouncer.trigger();

      expect(debouncer.isPending()).toBe(true);

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(debouncer.isPending()).toBe(false);

      // Verify export happened once
      const specsPath = path.join(testDir, 'specs.jsonl');
      expect(fs.existsSync(specsPath)).toBe(true);
    });

    it('should cancel pending export', () => {
      const debouncer = new ExportDebouncer(db, 1000, { outputDir: testDir });

      debouncer.trigger();
      expect(debouncer.isPending()).toBe(true);

      debouncer.cancel();
      expect(debouncer.isPending()).toBe(false);
    });

    it('should flush pending export immediately', async () => {
      createSpec(db, {
        id: 'spec-001',
        title: 'Test',
        file_path: 'test.md',
      });

      const debouncer = new ExportDebouncer(db, 5000, { outputDir: testDir });

      debouncer.trigger();
      expect(debouncer.isPending()).toBe(true);

      // Flush immediately (don't wait 5 seconds)
      await debouncer.flush();

      expect(debouncer.isPending()).toBe(false);

      const specsPath = path.join(testDir, 'specs.jsonl');
      expect(fs.existsSync(specsPath)).toBe(true);
    });

    it('should handle execute when not pending', async () => {
      const debouncer = new ExportDebouncer(db, 100, { outputDir: testDir });

      // Execute without trigger
      await debouncer.execute();

      // Should not throw error
      expect(debouncer.isPending()).toBe(false);
    });
  });

  describe('createDebouncedExport', () => {
    it('should create a debouncer instance', () => {
      const debouncer = createDebouncedExport(db, 1000, { outputDir: testDir });

      expect(debouncer).toBeInstanceOf(ExportDebouncer);
      expect(debouncer.isPending()).toBe(false);
    });
  });

  describe('Deterministic Array Sorting', () => {
    it('should sort relationships by to_id, to_type, then type', () => {
      // Create entities
      const spec1 = createSpec(db, {
        id: 'spec-001',
        title: 'Spec 1',
        file_path: 'spec1.md',
      });
      createSpec(db, {
        id: 'spec-002',
        title: 'Spec 2',
        file_path: 'spec2.md',
      });
      createSpec(db, {
        id: 'spec-003',
        title: 'Spec 3',
        file_path: 'spec3.md',
      });
      createIssue(db, {
        id: 'issue-001',
        title: 'Issue 1',
      });

      // Add relationships in non-sorted order
      addRelationship(db, {
        from_id: 'spec-001',
        from_type: 'spec',
        to_id: 'spec-003',
        to_type: 'spec',
        relationship_type: 'related',
      });
      addRelationship(db, {
        from_id: 'spec-001',
        from_type: 'spec',
        to_id: 'issue-001',
        to_type: 'issue',
        relationship_type: 'references',
      });
      addRelationship(db, {
        from_id: 'spec-001',
        from_type: 'spec',
        to_id: 'spec-002',
        to_type: 'spec',
        relationship_type: 'blocks',
      });
      addRelationship(db, {
        from_id: 'spec-001',
        from_type: 'spec',
        to_id: 'spec-002',
        to_type: 'spec',
        relationship_type: 'related',
      });

      // Export
      const jsonl = specToJSONL(db, spec1);

      // Verify sorted order: first by to_id, then to_type, then type
      expect(jsonl.relationships).toHaveLength(4);
      // issue-001 comes before spec-002 and spec-003 alphabetically
      expect(jsonl.relationships[0].to).toBe('issue-001');
      // spec-002 comes next, with 'blocks' before 'related'
      expect(jsonl.relationships[1].to).toBe('spec-002');
      expect(jsonl.relationships[1].type).toBe('blocks');
      expect(jsonl.relationships[2].to).toBe('spec-002');
      expect(jsonl.relationships[2].type).toBe('related');
      // spec-003 comes last
      expect(jsonl.relationships[3].to).toBe('spec-003');
    });

    it('should sort tags alphabetically', () => {
      const spec = createSpec(db, {
        id: 'spec-001',
        title: 'Spec 1',
        file_path: 'spec1.md',
      });

      // Add tags in non-alphabetical order
      addTags(db, 'spec-001', 'spec', ['zebra', 'alpha', 'monkey', 'beta']);

      const jsonl = specToJSONL(db, spec);

      // Verify alphabetical order
      expect(jsonl.tags).toEqual(['alpha', 'beta', 'monkey', 'zebra']);
    });

    it('should produce identical output regardless of insertion order', () => {
      // Create entities
      const issue = createIssue(db, {
        id: 'issue-001',
        title: 'Issue 1',
      });
      createIssue(db, {
        id: 'issue-002',
        title: 'Issue 2',
      });
      createIssue(db, {
        id: 'issue-003',
        title: 'Issue 3',
      });

      // Add relationships in one order
      addRelationship(db, {
        from_id: 'issue-001',
        from_type: 'issue',
        to_id: 'issue-003',
        to_type: 'issue',
        relationship_type: 'related',
      });
      addRelationship(db, {
        from_id: 'issue-001',
        from_type: 'issue',
        to_id: 'issue-002',
        to_type: 'issue',
        relationship_type: 'blocks',
      });

      // Add tags in non-alphabetical order
      addTags(db, 'issue-001', 'issue', ['c-tag', 'a-tag', 'b-tag']);

      // Export multiple times
      const jsonl1 = issueToJSONL(db, issue);
      const jsonl2 = issueToJSONL(db, issue);

      // Should produce identical output
      expect(JSON.stringify(jsonl1.relationships)).toBe(JSON.stringify(jsonl2.relationships));
      expect(JSON.stringify(jsonl1.tags)).toBe(JSON.stringify(jsonl2.tags));

      // Verify consistent ordering
      expect(jsonl1.relationships[0].to).toBe('issue-002'); // Sorted alphabetically
      expect(jsonl1.relationships[1].to).toBe('issue-003');
      expect(jsonl1.tags).toEqual(['a-tag', 'b-tag', 'c-tag']);
    });
  });
});

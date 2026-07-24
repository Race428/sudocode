/**
 * Unit tests for issue management tools
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as issueTools from '../../src/tools/issues.js';

describe('Issue Tools', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      exec: vi.fn(),
    };
  });

  describe('ready', () => {
    it('should call exec with ready and status commands', async () => {
      mockClient.exec
        .mockResolvedValueOnce({ issues: [] })  // ready result
        .mockResolvedValueOnce({ specs: { total: 5 }, issues: { total: 10 } });  // status result

      const result = await issueTools.ready(mockClient);

      expect(mockClient.exec).toHaveBeenCalledWith(['ready']);
      expect(mockClient.exec).toHaveBeenCalledWith(['status']);
      expect(result).toEqual({
        ready: { issues: [] },
        status: { specs: { total: 5 }, issues: { total: 10 } },
      });
    });

    it('should redact content field from issues', async () => {
      mockClient.exec
        .mockResolvedValueOnce({
          issues: [
            { id: 'sg-1', title: 'Test Issue', content: 'Long content...', priority: 2 },
            { id: 'sg-2', title: 'Another Issue', content: 'More content...', priority: 1 },
          ]
        })
        .mockResolvedValueOnce({ specs: { total: 5 }, issues: { total: 10 } });

      const result = await issueTools.ready(mockClient);

      // Verify content field is removed
      expect(result.ready.issues[0]).not.toHaveProperty('content');
      expect(result.ready.issues[1]).not.toHaveProperty('content');
      // Verify other fields are preserved
      expect(result.ready.issues[0]).toEqual({ id: 'sg-1', title: 'Test Issue', priority: 2 });
      expect(result.ready.issues[1]).toEqual({ id: 'sg-2', title: 'Another Issue', priority: 1 });
    });
  });

  describe('listIssues', () => {
    it('should call exec with list command and default archived filter', async () => {
      mockClient.exec.mockResolvedValue([]);

      await issueTools.listIssues(mockClient);

      expect(mockClient.exec).toHaveBeenCalledWith([
        'issue', 'list',
        '--limit', '50',
        '--archived', 'false',
      ]);
    });

    it('should include filter parameters', async () => {
      mockClient.exec.mockResolvedValue([]);

      await issueTools.listIssues(mockClient, {
        status: 'open',
        priority: 1,
        limit: 20,
      });

      expect(mockClient.exec).toHaveBeenCalledWith([
        'issue', 'list',
        '--status', 'open',
        '--priority', '1',
        '--limit', '20',
        '--archived', 'false',
      ]);
    });

    it('should include archived filter parameter when explicitly set to false', async () => {
      mockClient.exec.mockResolvedValue([]);

      await issueTools.listIssues(mockClient, {
        archived: false,
      });

      expect(mockClient.exec).toHaveBeenCalledWith([
        'issue', 'list',
        '--limit', '50',
        '--archived', 'false',
      ]);
    });

    it('should include archived filter parameter when explicitly set to true', async () => {
      mockClient.exec.mockResolvedValue([]);

      await issueTools.listIssues(mockClient, {
        archived: true,
      });

      expect(mockClient.exec).toHaveBeenCalledWith([
        'issue', 'list',
        '--limit', '50',
        '--archived', 'true',
      ]);
    });

    it('should include search parameter', async () => {
      mockClient.exec.mockResolvedValue([]);

      await issueTools.listIssues(mockClient, {
        search: 'authentication',
      });

      expect(mockClient.exec).toHaveBeenCalledWith([
        'issue', 'list',
        '--grep', 'authentication',
        '--limit', '50',
        '--archived', 'false',
      ]);
    });

    it('paginates: adds --offset from cursor and returns next_cursor on a full page', async () => {
      // A full page (length === limit) implies more may follow.
      const page = Array.from({ length: 2 }, (_, i) => ({ id: `i-${i}`, title: `T${i}` }));
      mockClient.exec.mockResolvedValue(page);

      const result = await issueTools.listIssues(mockClient, { limit: 2, cursor: '4' });

      expect(mockClient.exec).toHaveBeenCalledWith([
        'issue', 'list',
        '--limit', '2',
        '--offset', '4',
        '--archived', 'false',
      ]);
      expect(result.next_cursor).toBe('6');
    });

    it('returns null next_cursor on the last (partial) page', async () => {
      mockClient.exec.mockResolvedValue([{ id: 'i-0', title: 'T' }]);
      const result = await issueTools.listIssues(mockClient, { limit: 50 });
      expect(result.next_cursor).toBeNull();
    });

    it('should redact content field from issues', async () => {
      mockClient.exec.mockResolvedValue([
        { id: 'sg-1', title: 'Test Issue', content: 'Long content...', priority: 2 },
        { id: 'sg-2', title: 'Another Issue', content: 'More content...', priority: 1 },
      ]);

      const result = await issueTools.listIssues(mockClient);

      // Verify content field is removed
      expect(result.issues[0]).not.toHaveProperty('content');
      expect(result.issues[1]).not.toHaveProperty('content');
      // Verify other fields are preserved
      expect(result.issues[0]).toEqual({ id: 'sg-1', title: 'Test Issue', priority: 2 });
      expect(result.issues[1]).toEqual({ id: 'sg-2', title: 'Another Issue', priority: 1 });
    });

    it('should include the new filters (assignee, parent, tags)', async () => {
      mockClient.exec.mockResolvedValue([]);

      await issueTools.listIssues(mockClient, {
        assignee: 'agent-A',
        parent: 'i-epic',
        tags: ['urgent', 'security'],
      });

      expect(mockClient.exec).toHaveBeenCalledWith([
        'issue', 'list',
        '--assignee', 'agent-A',
        '--parent', 'i-epic',
        '--tag', 'urgent,security',
        '--limit', '50',
        '--archived', 'false',
      ]);
    });
  });

  describe('showIssues (batch)', () => {
    it('calls exec once with all ids', async () => {
      mockClient.exec.mockResolvedValue([]);
      await issueTools.showIssues(mockClient, { ids: ['i-1', 'i-2', 'i-3'] });
      expect(mockClient.exec).toHaveBeenCalledWith(['issue', 'show', 'i-1', 'i-2', 'i-3']);
    });

    it('throws when no ids given', async () => {
      await expect(issueTools.showIssues(mockClient, { ids: [] })).rejects.toThrow();
    });
  });

  describe('showIssue', () => {
    it('should call exec with show command and issue ID', async () => {
      mockClient.exec.mockResolvedValue({});

      await issueTools.showIssue(mockClient, { issue_id: 'sg-1' });

      expect(mockClient.exec).toHaveBeenCalledWith(['issue', 'show', 'sg-1']);
    });
  });

  describe('upsertIssue', () => {
    describe('create mode (no issue_id)', () => {
      it('should call exec with create command', async () => {
        mockClient.exec.mockResolvedValue({});

        await issueTools.upsertIssue(mockClient, { title: 'Test Issue' });

        expect(mockClient.exec).toHaveBeenCalledWith(['issue', 'create', 'Test Issue']);
      });

      it('should include all optional parameters', async () => {
        mockClient.exec.mockResolvedValue({});

        await issueTools.upsertIssue(mockClient, {
          title: 'Test Issue',
          description: 'Test description',
          priority: 1,
          parent: 'sg-epic-1',
          tags: ['urgent', 'security'],
        });

        expect(mockClient.exec).toHaveBeenCalledWith([
          'issue', 'create', 'Test Issue',
          '--description', 'Test description',
          '--priority', '1',
          '--parent', 'sg-epic-1',
          '--tags', 'urgent,security',
        ]);
      });

      it('should throw error if title is missing', async () => {
        await expect(issueTools.upsertIssue(mockClient, {})).rejects.toThrow(
          'title is required when creating a new issue'
        );
      });
    });

    describe('update mode (issue_id provided)', () => {
      it('should call exec with update command', async () => {
        mockClient.exec.mockResolvedValue({});

        await issueTools.upsertIssue(mockClient, {
          issue_id: 'sg-1',
          status: 'in_progress',
        });

        expect(mockClient.exec).toHaveBeenCalledWith([
          'issue', 'update', 'sg-1',
          '--status', 'in_progress',
        ]);
      });

      it('should include multiple update fields', async () => {
        mockClient.exec.mockResolvedValue({});

        await issueTools.upsertIssue(mockClient, {
          issue_id: 'sg-1',
          status: 'in_progress',
          priority: 0,
          title: 'Updated Title',
        });

        expect(mockClient.exec).toHaveBeenCalledWith([
          'issue', 'update', 'sg-1',
          '--status', 'in_progress',
          '--priority', '0',
          '--title', 'Updated Title',
        ]);
      });

      it('should support closing issues via status', async () => {
        mockClient.exec.mockResolvedValue({});

        await issueTools.upsertIssue(mockClient, {
          issue_id: 'sg-1',
          status: 'closed',
        });

        expect(mockClient.exec).toHaveBeenCalledWith([
          'issue', 'update', 'sg-1',
          '--status', 'closed',
        ]);
      });

      it('should support archiving issues', async () => {
        mockClient.exec.mockResolvedValue({});

        await issueTools.upsertIssue(mockClient, {
          issue_id: 'sg-1',
          archived: true,
        });

        expect(mockClient.exec).toHaveBeenCalledWith([
          'issue', 'update', 'sg-1',
          '--archived', 'true',
        ]);
      });

      it('should support unarchiving issues', async () => {
        mockClient.exec.mockResolvedValue({});

        await issueTools.upsertIssue(mockClient, {
          issue_id: 'sg-1',
          archived: false,
        });

        expect(mockClient.exec).toHaveBeenCalledWith([
          'issue', 'update', 'sg-1',
          '--archived', 'false',
        ]);
      });
    });
  });
});

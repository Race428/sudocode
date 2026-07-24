/**
 * MCP tools for issue management
 */

import { execSync } from "node:child_process";
import { SudocodeClient } from "../client.js";
import { Issue, IssueStatus } from "../types.js";

/**
 * Lease-holder id for claim_issue when the caller omits `agent`.
 * $SUDOCODE_AGENT, else the current git branch (the intended worktree/branch
 * holder), else a constant. ponytail: no per-session identity exists yet.
 */
function defaultAgentId(): string {
  if (process.env.SUDOCODE_AGENT) return process.env.SUDOCODE_AGENT;
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch && branch !== "HEAD") return branch;
  } catch {
    // not a git repo / git unavailable — fall through
  }
  return "mcp-agent";
}

// Tool parameter types
export interface ReadyParams {}

export interface ListIssuesParams {
  status?: IssueStatus;
  priority?: number;
  assignee?: string;
  parent?: string;
  tags?: string[];
  limit?: number;
  cursor?: string; // opaque pagination token (an offset)
  search?: string;
  archived?: boolean;
}

export interface ShowIssueParams {
  id?: string;
  issue_id?: string; // alias for id
}

export interface UpsertIssueParams {
  id?: string; // If provided, update in place; otherwise create
  issue_id?: string; // alias for id
  title?: string; // Required for create, optional for update
  content?: string;
  description?: string; // alias for content
  priority?: number;
  parent?: string;
  tags?: string[];
  status?: IssueStatus;
  archived?: boolean;
  // TODO: Reintroduce assignee later on when first-class agents are supported.
}

export interface DeleteIssueParams {
  id: string | string[];
  hard?: boolean;
}

// Tool implementations

/**
 * Find issues ready to work on (no blockers) and get project status
 */
export async function ready(
  client: SudocodeClient,
  params: ReadyParams = {}
): Promise<any> {
  const readyResult = await client.exec(["ready"]);
  const statusResult = await client.exec(["status"]);

  // Redact content field from issues to keep response shorter
  if (readyResult.issues && Array.isArray(readyResult.issues)) {
    readyResult.issues = readyResult.issues.map((issue: any) => {
      const { content, ...rest } = issue;
      return rest;
    });
  }

  return {
    ready: readyResult,
    status: statusResult,
  };
}

/**
 * List all issues with optional filters
 */
export async function listIssues(
  client: SudocodeClient,
  params: ListIssuesParams = {}
): Promise<any> {
  const args = ["issue", "list"];

  if (params.status) {
    args.push("--status", params.status);
  }
  if (params.priority !== undefined) {
    args.push("--priority", params.priority.toString());
  }
  if (params.assignee) {
    args.push("--assignee", params.assignee);
  }
  if (params.parent) {
    args.push("--parent", params.parent);
  }
  if (params.tags && params.tags.length > 0) {
    args.push("--tag", params.tags.join(","));
  }
  if (params.search) {
    args.push("--grep", params.search);
  }
  const limit = params.limit ?? 50;
  args.push("--limit", limit.toString());
  const offset = params.cursor ? parseInt(params.cursor, 10) || 0 : 0;
  if (offset > 0) {
    args.push("--offset", offset.toString());
  }
  // Default to excluding archived unless explicitly specified
  const archived = params.archived !== undefined ? params.archived : false;
  args.push("--archived", archived.toString());

  const issues = await client.exec(args);
  const list = Array.isArray(issues) ? issues : [];

  // Redact content to keep the response short.
  const redacted = list.map((issue: any) => {
    const { content, ...rest } = issue;
    return rest;
  });

  // A full page implies there may be more — hand back the next offset as an
  // opaque cursor. Fewer than `limit` rows means we reached the end.
  const nextCursor = redacted.length === limit ? String(offset + limit) : null;
  return { issues: redacted, next_cursor: nextCursor };
}

/**
 * Batch read: fetch several issues (with relationships/feedback) in one call
 * instead of N show_issue round-trips. Returns an array; missing ids appear as
 * { id, error }.
 */
export async function showIssues(
  client: SudocodeClient,
  params: { ids?: string[]; id?: string | string[] }
): Promise<any> {
  const raw = params.ids ?? params.id;
  const ids = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (ids.length === 0) {
    throw new Error("show_issues requires 'ids' (an array of issue ids).");
  }
  return client.exec(["issue", "show", ...ids]);
}

export interface ClaimIssueParams {
  id?: string;
  issue_id?: string; // alias for id
  agent?: string;
}

/**
 * Atomically claim an issue for an agent. Returns { claimed, issue, held_by }.
 * In --json mode (always set by client.exec) the CLI exits 0 even on a lost
 * claim, so the structured result comes back cleanly without special-casing.
 */
export async function claimIssue(
  client: SudocodeClient,
  params: ClaimIssueParams
): Promise<any> {
  const id = params.id ?? params.issue_id;
  if (!id) {
    throw new Error("claim_issue requires 'id' (the issue to claim).");
  }
  const agent = params.agent ?? defaultAgentId();
  const result = await client.exec(["issue", "claim", id, "--agent", agent]);

  // Surface the lease so callers know who holds it and when it frees up. On a
  // lost claim, lease_expires_at is when the current holder's lease dies (retry
  // after that); on a won claim, it's your own heartbeat deadline.
  // ponytail: 60 mirrors the CLI's CLAIM_LEASE_MINUTES; single source would
  // require importing across the package boundary — revisit if the lease is
  // ever made configurable.
  const LEASE_MINUTES = 60;
  const claimedAt: string | undefined = result?.issue?.claimed_at ?? undefined;
  const leaseExpiresAt = leaseExpiry(claimedAt, LEASE_MINUTES);
  return {
    ...result,
    agent,
    lease_minutes: LEASE_MINUTES,
    ...(leaseExpiresAt ? { lease_expires_at: leaseExpiresAt } : {}),
  };
}

/** SQLite stamps 'YYYY-MM-DD HH:MM:SS' in UTC; add the lease and return ISO. */
function leaseExpiry(
  claimedAt: string | undefined,
  minutes: number
): string | undefined {
  if (!claimedAt) return undefined;
  const ms = Date.parse(claimedAt.replace(" ", "T") + "Z");
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms + minutes * 60_000).toISOString();
}

/**
 * Reconcile this session's local query cache with the shared, git-tracked store
 * (imports the JSONL), then returns ready work. Call at session start and after
 * a `git pull` so concurrent agents' committed specs/issues become visible.
 */
export async function sync(
  client: SudocodeClient,
  _params: Record<string, never> = {}
): Promise<any> {
  await client.exec(["import"]);
  const readyView = await ready(client);
  return { synced: true, ...readyView };
}

/**
 * Show detailed issue information including relationships and feedback
 */
export async function showIssue(
  client: SudocodeClient,
  params: ShowIssueParams
): Promise<any> {
  const id = params.id ?? params.issue_id;
  if (!id) {
    throw new Error("show_issue requires 'id'.");
  }
  return client.exec(["issue", "show", id]);
}

/**
 * Upsert an issue: update in place when `id` is given, else create.
 * Always returns the full issue (via show) so the caller can verify the write
 * landed — this is what would have caught the dropped-content/forked-id bugs.
 */
export async function upsertIssue(
  client: SudocodeClient,
  params: UpsertIssueParams
): Promise<any> {
  const id = params.id ?? params.issue_id;
  const content = params.content ?? params.description;
  let writeResult: any;
  let resolvedId: string | undefined = id;

  if (id) {
    // Update mode
    const args = ["issue", "update", id];

    if (params.status) {
      args.push("--status", params.status);
    }
    if (params.priority !== undefined) {
      args.push("--priority", params.priority.toString());
    }
    if (params.title) {
      args.push("--title", params.title);
    }
    if (content !== undefined) {
      args.push("--description", content);
    }
    if (params.parent) {
      args.push("--parent", params.parent);
    }
    if (params.archived !== undefined) {
      args.push("--archived", params.archived.toString());
    }
    if (params.tags !== undefined) {
      args.push("--tags", params.tags.join(","));
    }

    writeResult = await client.exec(args);
  } else {
    // Create mode
    if (!params.title) {
      throw new Error("title is required when creating a new issue");
    }

    const args = ["issue", "create", params.title];

    if (content !== undefined) {
      args.push("--description", content);
    }
    if (params.priority !== undefined) {
      args.push("--priority", params.priority.toString());
    }
    if (params.parent) {
      args.push("--parent", params.parent);
    }
    if (params.tags && params.tags.length > 0) {
      args.push("--tags", params.tags.join(","));
    }

    writeResult = await client.exec(args);
    resolvedId = writeResult?.id;
  }

  if (resolvedId) {
    const full = await showIssue(client, { id: resolvedId });
    const warnings = writeResult?.reference_warnings;
    return warnings ? { ...full, reference_warnings: warnings } : full;
  }
  return writeResult;
}

/**
 * Delete one or more issues. hard=false (default) soft-deletes (closes);
 * hard=true permanently removes from the store.
 */
export async function deleteIssue(
  client: SudocodeClient,
  params: DeleteIssueParams
): Promise<any> {
  const ids = Array.isArray(params.id) ? params.id : [params.id];
  if (ids.length === 0 || ids.some((i) => !i)) {
    throw new Error("delete_issue requires 'id' (a string or array of ids).");
  }
  const args = ["issue", "delete", ...ids];
  if (params.hard) {
    args.push("--hard");
  }
  return client.exec(args);
}

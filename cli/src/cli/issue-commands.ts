/**
 * CLI handlers for issue commands
 */

import path from "path";
import fs from "fs";
import chalk from "chalk";
import type Database from "better-sqlite3";
import { generateIssueId } from "../id-generator.js";
import {
  createIssue,
  getIssue,
  listIssues,
  updateIssue,
  closeIssue,
  claimIssue,
} from "../operations/issues.js";
import { insertEvent } from "../operations/events.js";
import {
  getOutgoingRelationships,
  getIncomingRelationships,
} from "../operations/relationships.js";
import { getTags, setTags } from "../operations/tags.js";
import { materializeContentReferences } from "../operations/references.js";
import { listFeedback } from "../operations/feedback.js";
import { maybeAutoExport } from "../export.js";
import { syncJSONLToMarkdown } from "../sync.js";
import { generateUniqueFilename, findExistingEntityFile, syncFileWithRename } from "../filename-generator.js";
import {
  isValidIssueStatus,
  getValidIssueStatuses,
} from "../validation.js";
import { trackCommand } from "../telemetry.js";

export interface CommandContext {
  db: Database.Database;
  outputDir: string;
  jsonOutput: boolean;
}

export interface IssueCreateOptions {
  priority: string;
  description?: string;
  assignee?: string;
  parent?: string;
  tags?: string;
}

export async function handleIssueCreate(
  ctx: CommandContext,
  title: string,
  options: IssueCreateOptions
): Promise<void> {
  const startTime = Date.now();
  try {
    // Generate issue ID and UUID
    const { id: issueId, uuid: issueUUID } = generateIssueId(ctx.db, ctx.outputDir);

    const issue = createIssue(ctx.db, {
      id: issueId,
      uuid: issueUUID,
      title,
      content: options.description || "",
      status: "open",
      priority: parseInt(options.priority),
      assignee: options.assignee || undefined,
      parent_id: options.parent || undefined,
    });

    if (options.tags) {
      const tags = options.tags.split(",").map((t) => t.trim());
      setTags(ctx.db, issueId, "issue", tags);
    }

    // Materialize [[id]] references in the description as relationships
    const refResult = materializeContentReferences(
      ctx.db,
      issueId,
      "issue",
      issue.content
    );

    await maybeAutoExport(ctx.db, ctx.outputDir);

    // Also update the markdown file to keep it in sync
    const issuesDir = path.join(ctx.outputDir, "issues");
    fs.mkdirSync(issuesDir, { recursive: true });

    // Generate filename using unified scheme: {id}_{title_slug}.md
    const fileName = generateUniqueFilename(title, issueId);
    const mdPath = path.join(issuesDir, fileName);
    await syncJSONLToMarkdown(ctx.db, issueId, 'issue', mdPath);

    if (ctx.jsonOutput) {
      console.log(
        JSON.stringify(
          {
            id: issueId,
            title,
            status: "open",
            ...(refResult.warnings.length > 0
              ? { reference_warnings: refResult.warnings }
              : {}),
          },
          null,
          2
        )
      );
    } else {
      console.log(chalk.green("✓ Created issue"), chalk.cyan(issueId));
      console.log(chalk.gray(`  Title: ${title}`));
      console.log(chalk.gray(`  File: issues/${fileName}`));
      if (options.assignee) {
        console.log(chalk.gray(`  Assignee: ${options.assignee}`));
      }
      for (const warning of refResult.warnings) {
        console.log(chalk.yellow(`  ⚠ ${warning}`));
      }
    }
    await trackCommand(ctx.outputDir, "issue_create", { title }, true, Date.now() - startTime);
  } catch (error) {
    await trackCommand(ctx.outputDir, "issue_create", { title }, false, Date.now() - startTime);
    console.error(chalk.red("✗ Failed to create issue"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export interface IssueListOptions {
  status?: string;
  assignee?: string;
  priority?: string;
  parent?: string;
  tag?: string;
  grep?: string;
  archived?: string;
  limit: string;
  offset?: string;
}

export async function handleIssueList(
  ctx: CommandContext,
  options: IssueListOptions
): Promise<void> {
  const startTime = Date.now();
  try {
    // Validate status if provided
    if (options.status && !isValidIssueStatus(options.status)) {
      console.error(
        chalk.red(`✗ Invalid status filter: ${options.status}`)
      );
      console.error(
        chalk.gray(`Valid statuses: ${getValidIssueStatuses().join(", ")}`)
      );
      process.exit(1);
    }

    // Use search if grep is provided, otherwise use list with filters
    // One unified query path handles filters + text search + pagination.
    const tags = options.tag
      ? options.tag.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;
    const issues = listIssues(ctx.db, {
      status: options.status as any,
      assignee: options.assignee,
      priority: options.priority ? parseInt(options.priority) : undefined,
      parent_id: options.parent,
      tags,
      search: options.grep,
      archived: options.archived !== undefined ? options.archived === "true" : false, // Default to excluding archived
      limit: parseInt(options.limit),
      offset: options.offset ? parseInt(options.offset) : undefined,
    });

    if (ctx.jsonOutput) {
      console.log(JSON.stringify(issues, null, 2));
    } else {
      if (issues.length === 0) {
        console.log(chalk.gray("No issues found"));
        return;
      }

      console.log(chalk.bold(`\nFound ${issues.length} issue(s):\n`));

      for (const issue of issues) {
        const statusColor =
          issue.status === "closed"
            ? chalk.green
            : issue.status === "in_progress"
              ? chalk.yellow
              : issue.status === "blocked"
                ? chalk.red
                : chalk.gray;

        const assigneeStr = issue.assignee
          ? chalk.gray(`@${issue.assignee}`)
          : "";
        console.log(
          chalk.cyan(issue.id),
          statusColor(`[${issue.status}]`),
          issue.title,
          assigneeStr
        );
        console.log(chalk.gray(`  Priority: ${issue.priority}`));
      }
      console.log();
    }
    await trackCommand(ctx.outputDir, "issue_list", {}, true, Date.now() - startTime);
  } catch (error) {
    await trackCommand(ctx.outputDir, "issue_list", {}, false, Date.now() - startTime);
    console.error(chalk.red("✗ Failed to list issues"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export async function handleIssueShow(
  ctx: CommandContext,
  id: string
): Promise<void> {
  const startTime = Date.now();
  try {
    const issue = getIssue(ctx.db, id);
    if (!issue) {
      console.error(chalk.red(`✗ Issue not found: ${id}`));
      process.exit(1);
    }

    const outgoing = getOutgoingRelationships(ctx.db, id, "issue");
    const incoming = getIncomingRelationships(ctx.db, id, "issue");
    const tags = getTags(ctx.db, id, "issue");
    const feedback = listFeedback(ctx.db, { from_id: id });
    const feedbackReceived = listFeedback(ctx.db, { to_id: id });

    if (ctx.jsonOutput) {
      console.log(
        JSON.stringify(
          { ...issue, relationships: { outgoing, incoming }, tags, feedback, feedback_received: feedbackReceived },
          null,
          2
        )
      );
    } else {
      console.log();
      console.log(chalk.bold.cyan(issue.id), chalk.bold(issue.title));
      console.log(chalk.gray("─".repeat(60)));
      console.log(chalk.gray("Status:"), issue.status);
      console.log(chalk.gray("Priority:"), issue.priority);
      if (issue.assignee) {
        console.log(chalk.gray("Assignee:"), issue.assignee);
      }
      if (issue.parent_id) {
        console.log(chalk.gray("Parent:"), issue.parent_id);
      }
      console.log(chalk.gray("Created:"), issue.created_at);
      console.log(chalk.gray("Updated:"), issue.updated_at);
      if (issue.closed_at) {
        console.log(chalk.gray("Closed:"), issue.closed_at);
      }

      if (tags.length > 0) {
        console.log(chalk.gray("Tags:"), tags.join(", "));
      }

      if (issue.content) {
        console.log();
        console.log(chalk.bold("Content:"));
        console.log(issue.content);
      }

      if (issue.content) {
        console.log();
        console.log(chalk.bold("Content:"));
        console.log(issue.content);
      }

      if (outgoing.length > 0) {
        console.log();
        console.log(chalk.bold("Outgoing Relationships:"));
        for (const rel of outgoing) {
          console.log(
            `  ${chalk.yellow(rel.relationship_type)} → ${chalk.cyan(
              rel.to_id
            )} (${rel.to_type})`
          );
        }
      }

      if (incoming.length > 0) {
        console.log();
        console.log(chalk.bold("Incoming Relationships:"));
        for (const rel of incoming) {
          console.log(
            `  ${chalk.cyan(rel.from_id)} (${rel.from_type}) → ${chalk.yellow(
              rel.relationship_type
            )}`
          );
        }
      }

      for (const [heading, list] of [
        ["Feedback Provided:", feedback],
        ["Feedback Received:", feedbackReceived],
      ] as const) {
        if (list.length === 0) continue;
        console.log();
        console.log(chalk.bold(heading));
        for (const fb of list) {
          // anchor is null for unanchored feedback (no --line/--text)
          const anchor =
            typeof fb.anchor === "string" ? JSON.parse(fb.anchor) : fb.anchor;
          const statusColor = fb.dismissed ? chalk.gray : chalk.white;
          const anchorStatusColor =
            anchor?.anchor_status === "valid"
              ? chalk.green
              : anchor?.anchor_status === "relocated"
                ? chalk.yellow
                : chalk.red;

          console.log(
            `  ${chalk.cyan(fb.id)} ${fb.from_id ? chalk.cyan(fb.from_id) : chalk.gray(fb.agent || "anonymous")} → ${chalk.cyan(fb.to_id)}`,
            statusColor(`[${fb.dismissed ? "dismissed" : "active"}]`),
            anchor ? anchorStatusColor(`[${anchor.anchor_status}]`) : chalk.gray("[unanchored]")
          );
          console.log(
            chalk.gray(
              `    Type: ${fb.feedback_type}${
                anchor
                  ? ` | ${anchor.section_heading || "No section"} (line ${anchor.line_number})`
                  : ""
              }`
            )
          );
          const contentPreview =
            fb.content.substring(0, 60) + (fb.content.length > 60 ? "..." : "");
          console.log(chalk.gray(`    ${contentPreview}`));
        }
      }

      console.log();
    }
    await trackCommand(ctx.outputDir, "issue_show", { id }, true, Date.now() - startTime);
  } catch (error) {
    await trackCommand(ctx.outputDir, "issue_show", { id }, false, Date.now() - startTime);
    console.error(chalk.red("✗ Failed to show issue"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/** Assemble the full detail object for one issue (or null if absent). */
function gatherIssueDetail(ctx: CommandContext, id: string) {
  const issue = getIssue(ctx.db, id);
  if (!issue) return null;
  const outgoing = getOutgoingRelationships(ctx.db, id, "issue");
  const incoming = getIncomingRelationships(ctx.db, id, "issue");
  const tags = getTags(ctx.db, id, "issue");
  const feedback = listFeedback(ctx.db, { from_id: id });
  const feedbackReceived = listFeedback(ctx.db, { to_id: id });
  return {
    ...issue,
    relationships: { outgoing, incoming },
    tags,
    feedback,
    feedback_received: feedbackReceived,
  };
}

/**
 * Batch show: with one id, defers to handleIssueShow (unchanged single-object
 * output). With many, emits a JSON array so an agent can fetch a spec's
 * children in one call instead of N. Missing ids appear as {id, error}.
 */
export async function handleIssueShowMany(
  ctx: CommandContext,
  ids: string[]
): Promise<void> {
  if (ids.length <= 1) {
    await handleIssueShow(ctx, ids[0]);
    return;
  }
  if (ctx.jsonOutput) {
    const details = ids.map(
      (id) => gatherIssueDetail(ctx, id) ?? { id, error: "not found" }
    );
    console.log(JSON.stringify(details, null, 2));
  } else {
    for (const id of ids) await handleIssueShow(ctx, id);
  }
}

export interface IssueUpdateOptions {
  status?: string;
  priority?: string;
  assignee?: string;
  title?: string;
  description?: string;
  parent?: string;
  archived?: string;
  tags?: string;
}

export async function handleIssueUpdate(
  ctx: CommandContext,
  id: string,
  options: IssueUpdateOptions
): Promise<void> {
  const startTime = Date.now();
  try {
    // Validate status if provided
    if (options.status && !isValidIssueStatus(options.status)) {
      console.error(
        chalk.red(`✗ Invalid status: ${options.status}`)
      );
      console.error(
        chalk.gray(`Valid statuses: ${getValidIssueStatuses().join(", ")}`)
      );
      process.exit(1);
    }

    const updates: any = {};
    if (options.status) updates.status = options.status;
    if (options.priority) updates.priority = parseInt(options.priority);
    if (options.assignee) updates.assignee = options.assignee;
    if (options.title) updates.title = options.title;
    if (options.description) updates.content = options.description;
    if (options.parent) updates.parent_id = options.parent;
    if (options.archived !== undefined) {
      updates.archived = options.archived === 'true';
    }

    let issue;
    try {
      issue = updateIssue(ctx.db, id, updates);
    } catch (error) {
      // Stale cache: the issue may exist in JSONL (e.g., created by another
      // agent/worktree) but not yet in this cache.db. Re-import and retry once.
      if (
        error instanceof Error &&
        error.message.includes(`Issue not found: ${id}`)
      ) {
        const { importFromJSONL } = await import("../import.js");
        await importFromJSONL(ctx.db, { inputDir: ctx.outputDir });
        issue = updateIssue(ctx.db, id, updates);
      } else {
        throw error;
      }
    }

    if (options.tags !== undefined) {
      const tags = options.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      setTags(ctx.db, id, "issue", tags);
    }

    // Materialize [[id]] references in updated description as relationships
    const refResult =
      updates.content !== undefined
        ? materializeContentReferences(ctx.db, id, "issue", issue.content)
        : { linked: [], warnings: [] };

    await maybeAutoExport(ctx.db, ctx.outputDir);

    // Also update the markdown file to keep it in sync
    const issuesDir = path.join(ctx.outputDir, "issues");
    fs.mkdirSync(issuesDir, { recursive: true });

    // Find existing file, rename if title changed, or generate new filename
    const mdPath = syncFileWithRename(id, issuesDir, issue.title);
    await syncJSONLToMarkdown(ctx.db, id, 'issue', mdPath);

    if (ctx.jsonOutput) {
      console.log(
        JSON.stringify(
          refResult.warnings.length > 0
            ? { ...issue, reference_warnings: refResult.warnings }
            : issue,
          null,
          2
        )
      );
    } else {
      console.log(chalk.green("✓ Updated issue"), chalk.cyan(id));
      Object.keys(updates).forEach((key) => {
        console.log(chalk.gray(`  ${key}: ${updates[key]}`));
      });
      for (const warning of refResult.warnings) {
        console.log(chalk.yellow(`  ⚠ ${warning}`));
      }
    }
    await trackCommand(ctx.outputDir, "issue_update", { id, status: options.status, archived: options.archived === 'true' }, true, Date.now() - startTime);
  } catch (error) {
    await trackCommand(ctx.outputDir, "issue_update", { id, status: options.status, archived: options.archived === 'true' }, false, Date.now() - startTime);
    console.error(chalk.red("✗ Failed to update issue"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export interface IssueClaimOptions {
  agent?: string;
}

/**
 * Atomically claim an issue for an agent. Exits non-zero if the task is already
 * held by a live lease, so fan-out scripts (N agents each calling claim) can
 * detect a lost race without any coordination.
 */
export async function handleIssueClaim(
  ctx: CommandContext,
  id: string,
  options: IssueClaimOptions
): Promise<void> {
  const startTime = Date.now();
  const agent =
    options.agent ||
    process.env.SUDOCODE_AGENT ||
    process.env.USER ||
    "agent";
  try {
    let result;
    try {
      result = claimIssue(ctx.db, id, agent);
    } catch (error) {
      // Stale cache: issue may exist in JSONL but not yet in this cache.db
      // (e.g. created by another agent/worktree). Re-import and retry once.
      if (
        error instanceof Error &&
        error.message.includes(`Issue not found: ${id}`)
      ) {
        const { importFromJSONL } = await import("../import.js");
        await importFromJSONL(ctx.db, { inputDir: ctx.outputDir });
        result = claimIssue(ctx.db, id, agent);
      } else {
        throw error;
      }
    }

    if (result.claimed) {
      await maybeAutoExport(ctx.db, ctx.outputDir);
      const issuesDir = path.join(ctx.outputDir, "issues");
      fs.mkdirSync(issuesDir, { recursive: true });
      const mdPath = syncFileWithRename(id, issuesDir, result.issue.title);
      await syncJSONLToMarkdown(ctx.db, id, "issue", mdPath);
    }

    if (ctx.jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.claimed) {
      console.log(chalk.green("✓ Claimed issue"), chalk.cyan(id), chalk.gray(`by ${agent}`));
    } else {
      console.error(
        chalk.yellow("✗ Already claimed"),
        chalk.cyan(id),
        chalk.gray(`held by ${result.held_by || "another agent"}`)
      );
    }
    await trackCommand(ctx.outputDir, "issue_claim", { id }, true, Date.now() - startTime);
    // Non-zero exit on a lost claim is for shell fan-out scripts. In --json mode
    // callers (e.g. the MCP server) parse the result instead, so exit 0 there.
    if (!result.claimed && !ctx.jsonOutput) {
      process.exit(1);
    }
  } catch (error) {
    await trackCommand(ctx.outputDir, "issue_claim", { id }, false, Date.now() - startTime);
    console.error(chalk.red("✗ Failed to claim issue"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export interface IssueCloseOptions {
  reason?: string;
  evidence?: string;
}

export async function handleIssueClose(
  ctx: CommandContext,
  ids: string[],
  options: IssueCloseOptions
): Promise<void> {
  const startTime = Date.now();
  try {
    const results = [];
    for (const id of ids) {
      try {
        closeIssue(ctx.db, id);
        // Record explicit closing evidence (commit SHA / PR / file path) if
        // given. Auto-capture of a linked execution's commit happens inside
        // closeIssue → recordCloseEvidence.
        if (options.evidence) {
          const isSha = /^[0-9a-f]{7,40}$/i.test(options.evidence);
          const closed = getIssue(ctx.db, id);
          insertEvent(ctx.db, {
            entity_id: id,
            entity_uuid: closed?.uuid || id,
            entity_type: "issue",
            event_type: "status_changed",
            actor: process.env.SUDOCODE_AGENT || process.env.USER || "sudocode",
            new_value: "closed",
            comment: options.evidence,
            git_commit_sha: isSha ? options.evidence : null,
            source: "close",
          });
        }
        results.push({ id, success: true });
        if (!ctx.jsonOutput) {
          console.log(chalk.green("✓ Closed issue"), chalk.cyan(id));
        }
      } catch (error) {
        results.push({
          id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!ctx.jsonOutput) {
          console.error(
            chalk.red("✗ Failed to close"),
            chalk.cyan(id),
            ":",
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }

    await maybeAutoExport(ctx.db, ctx.outputDir);

    // Also update the markdown files to keep them in sync
    const issuesDir = path.join(ctx.outputDir, "issues");
    fs.mkdirSync(issuesDir, { recursive: true });
    for (const result of results) {
      if (result.success) {
        // Find existing file, rename if title changed, or generate new filename
        const issue = getIssue(ctx.db, result.id);
        const mdPath = syncFileWithRename(result.id, issuesDir, issue?.title || result.id);
        await syncJSONLToMarkdown(ctx.db, result.id, 'issue', mdPath);
      }
    }

    if (ctx.jsonOutput) {
      console.log(JSON.stringify(results, null, 2));
    }
    await trackCommand(ctx.outputDir, "issue_close", { id: ids.join(",") }, true, Date.now() - startTime);
  } catch (error) {
    await trackCommand(ctx.outputDir, "issue_close", { id: ids.join(",") }, false, Date.now() - startTime);
    console.error(chalk.red("✗ Failed to close issues"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export interface IssueDeleteOptions {
  hard?: boolean;
}

export async function handleIssueDelete(
  ctx: CommandContext,
  ids: string[],
  options: IssueDeleteOptions
): Promise<void> {
  try {
    const results = [];

    for (const id of ids) {
      try {
        const issue = getIssue(ctx.db, id);
        if (!issue) {
          results.push({ id, success: false, error: "Issue not found" });
          if (!ctx.jsonOutput) {
            console.error(chalk.red("✗ Issue not found:"), chalk.cyan(id));
          }
          continue;
        }

        if (options.hard) {
          // Hard delete - permanently remove from database
          const { deleteIssue } = await import("../operations/issues.js");
          const deleted = deleteIssue(ctx.db, id);
          if (deleted) {
            // Remove the markdown file too, so the watcher doesn't
            // re-import the entity from the leftover file
            const mdFile = findExistingEntityFile(
              id,
              path.join(ctx.outputDir, "issues")
            );
            if (mdFile) {
              try {
                fs.unlinkSync(mdFile);
              } catch {
                // File already gone or locked - not fatal
              }
            }
            results.push({ id, success: true, action: "hard_delete" });
            if (!ctx.jsonOutput) {
              console.log(
                chalk.green("✓ Permanently deleted issue"),
                chalk.cyan(id)
              );
            }
          } else {
            results.push({ id, success: false, error: "Delete failed" });
            if (!ctx.jsonOutput) {
              console.error(
                chalk.red("✗ Failed to delete issue"),
                chalk.cyan(id)
              );
            }
          }
        } else {
          // Soft delete - close the issue
          closeIssue(ctx.db, id);
          results.push({
            id,
            success: true,
            action: "soft_delete",
            status: "closed",
          });
          if (!ctx.jsonOutput) {
            console.log(chalk.green("✓ Closed issue"), chalk.cyan(id));
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ id, success: false, error: message });
        if (!ctx.jsonOutput) {
          console.error(
            chalk.red("✗ Failed to process"),
            chalk.cyan(id),
            ":",
            message
          );
        }
      }
    }

    // Export to JSONL after all deletions
    await maybeAutoExport(ctx.db, ctx.outputDir);

    if (ctx.jsonOutput) {
      console.log(JSON.stringify(results, null, 2));
    }
  } catch (error) {
    console.error(chalk.red("✗ Failed to delete issues"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

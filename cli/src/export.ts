/**
 * Export SQLite data to JSONL files
 */

import type Database from "better-sqlite3";
import type {
  Spec,
  Issue,
  SpecJSONL,
  IssueJSONL,
  RelationshipJSONL,
  FeedbackJSONL,
  ExternalLink,
} from "./types.js";
import { listSpecs } from "./operations/specs.js";
import { listIssues } from "./operations/issues.js";
import { getOutgoingRelationships } from "./operations/relationships.js";
import { getTags } from "./operations/tags.js";
import { listFeedback } from "./operations/feedback.js";
import { writeJSONL, readJSONLSync } from "./jsonl.js";
import { withExportLock } from "./file-lock.js";

export interface ExportOptions {
  /**
   * Output directory for JSONL files
   */
  outputDir?: string;
  /**
   * Only export entities that have been updated since this timestamp
   */
  since?: Date;
  /**
   * Custom file names
   */
  specsFile?: string;
  issuesFile?: string;
}

/**
 * Sort relationships for deterministic JSONL output
 * Sorts by: to_id, then to_type, then relationship type
 */
function sortRelationships(rels: RelationshipJSONL[]): RelationshipJSONL[] {
  return [...rels].sort((a, b) => {
    if (a.to !== b.to) return a.to.localeCompare(b.to);
    if (a.to_type !== b.to_type) return a.to_type.localeCompare(b.to_type);
    return a.type.localeCompare(b.type);
  });
}

/**
 * Sort tags alphabetically for deterministic JSONL output
 */
function sortTags(tags: string[]): string[] {
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/**
 * Sort feedback for deterministic JSONL output
 * Sorts by: id (stable identifier)
 */
function sortFeedback(feedback: FeedbackJSONL[]): FeedbackJSONL[] {
  return [...feedback].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Feedback is stored on the issue that provided it. Anonymous feedback (no from_id)
 * has no such home, so it is stored on the entity it targets instead — otherwise it
 * never reaches JSONL and is lost the next time the cache is rebuilt.
 */
function feedbackForEntity(
  db: Database.Database,
  entityId: string,
  includeProvided: boolean
): FeedbackJSONL[] {
  const provided = includeProvided ? listFeedback(db, { from_id: entityId }) : [];
  const anonymous = listFeedback(db, { to_id: entityId }).filter((fb) => !fb.from_id);

  return sortFeedback(
    [...provided, ...anonymous].map((feedback) => ({
      id: feedback.id,
      from_id: feedback.from_id,
      to_id: feedback.to_id,
      feedback_type: feedback.feedback_type,
      content: feedback.content,
      agent: feedback.agent,
      anchor:
        feedback.anchor && typeof feedback.anchor === "string"
          ? JSON.parse(feedback.anchor)
          : feedback.anchor,
      dismissed: feedback.dismissed,
      created_at: feedback.created_at,
      updated_at: feedback.updated_at,
    }))
  );
}

/**
 * Sort external links for deterministic JSONL output
 * Sorts by: provider, then external_id
 */
function sortExternalLinks(links: ExternalLink[] | undefined): ExternalLink[] | undefined {
  if (!links || links.length === 0) return links;
  return [...links].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.external_id.localeCompare(b.external_id);
  });
}

/**
 * Convert a Spec to SpecJSONL format with embedded relationships and tags
 * @param existingExternalLinks - Optional map of spec ID to external links (preserved from existing JSONL)
 */
export function specToJSONL(
  db: Database.Database,
  spec: Spec,
  existingExternalLinks?: Map<string, ExternalLink[]>
): SpecJSONL {
  // Get outgoing relationships
  const relationships = getOutgoingRelationships(db, spec.id, "spec");

  // Convert to JSONL format
  const relationshipsJSONL: RelationshipJSONL[] = relationships.map((rel) => ({
    from: rel.from_id,
    from_type: rel.from_type,
    to: rel.to_id,
    to_type: rel.to_type,
    type: rel.relationship_type,
  }));

  // Get tags
  const tags = getTags(db, spec.id, "spec");

  // Get external_links - prefer from spec if present, otherwise from existing JSONL
  const externalLinks = spec.external_links ?? existingExternalLinks?.get(spec.id);

  const feedback = feedbackForEntity(db, spec.id, false);

  return {
    ...spec,
    // Sort arrays for deterministic output (reduces JSONL churn)
    relationships: sortRelationships(relationshipsJSONL),
    tags: sortTags(tags),
    feedback: feedback.length > 0 ? feedback : undefined,
    external_links: sortExternalLinks(externalLinks),
  };
}

/**
 * Convert an Issue to IssueJSONL format with embedded relationships and tags
 * @param existingExternalLinks - Optional map of issue ID to external links (preserved from existing JSONL)
 */
export function issueToJSONL(
  db: Database.Database,
  issue: Issue,
  existingExternalLinks?: Map<string, ExternalLink[]>
): IssueJSONL {
  // Get outgoing relationships
  const relationships = getOutgoingRelationships(db, issue.id, "issue");

  // Convert to JSONL format
  const relationshipsJSONL: RelationshipJSONL[] = relationships.map((rel) => ({
    from: rel.from_id,
    from_type: rel.from_type,
    to: rel.to_id,
    to_type: rel.to_type,
    type: rel.relationship_type,
  }));

  // Get tags
  const tags = getTags(db, issue.id, "issue");

  // Feedback provided by this issue, plus anonymous feedback targeting it
  const sortedFeedback = feedbackForEntity(db, issue.id, true);

  // Get external_links - prefer from issue if present, otherwise from existing JSONL
  const externalLinks = issue.external_links ?? existingExternalLinks?.get(issue.id);

  return {
    ...issue,
    relationships: sortRelationships(relationshipsJSONL),
    tags: sortTags(tags),
    feedback: sortedFeedback.length > 0 ? sortedFeedback : undefined,
    external_links: sortExternalLinks(externalLinks),
  };
}

/**
 * Export all specs to JSONL format
 * @param existingExternalLinks - Optional map of spec ID to external links (for preserving from existing JSONL)
 */
export function exportSpecsToJSONL(
  db: Database.Database,
  options: ExportOptions = {},
  existingExternalLinks?: Map<string, ExternalLink[]>
): SpecJSONL[] {
  const { since } = options;

  // Get all specs (including archived)
  const specs = listSpecs(db);

  // Filter by timestamp if requested
  const filtered = since
    ? specs.filter((spec) => new Date(spec.updated_at) > since)
    : specs;

  // Convert to JSONL format with relationships, tags, and external_links
  return filtered.map((spec) => specToJSONL(db, spec, existingExternalLinks));
}

/**
 * Export all issues to JSONL format
 * @param existingExternalLinks - Optional map of issue ID to external links (for preserving from existing JSONL)
 */
export function exportIssuesToJSONL(
  db: Database.Database,
  options: ExportOptions = {},
  existingExternalLinks?: Map<string, ExternalLink[]>
): IssueJSONL[] {
  const { since } = options;

  // Get all issues (including archived)
  const issues = listIssues(db);

  // Filter by timestamp if requested
  const filtered = since
    ? issues.filter((issue) => new Date(issue.updated_at) > since)
    : issues;

  // Convert to JSONL format with relationships, tags, and external_links
  return filtered.map((issue) => issueToJSONL(db, issue, existingExternalLinks));
}

/**
 * Read existing external_links from a JSONL file
 * Returns a map of entity ID to external_links array
 */
function readExistingExternalLinks<T extends { id: string; external_links?: ExternalLink[] }>(
  filePath: string
): Map<string, ExternalLink[]> {
  const map = new Map<string, ExternalLink[]>();
  const entities = readJSONLSync<T>(filePath, { skipErrors: true });
  for (const entity of entities) {
    if (entity.external_links && entity.external_links.length > 0) {
      map.set(entity.id, entity.external_links);
    }
  }
  return map;
}

/**
 * Export both specs and issues to JSONL files
 * Preserves external_links from existing JSONL files
 */
export async function exportToJSONL(
  db: Database.Database,
  options: ExportOptions = {}
): Promise<{ specsCount: number; issuesCount: number }> {
  const {
    outputDir = ".sudocode",
    specsFile = "specs.jsonl",
    issuesFile = "issues.jsonl",
  } = options;

  const specsPath = `${outputDir}/${specsFile}`;
  const issuesPath = `${outputDir}/${issuesFile}`;

  // Hold a cross-process lock across the whole snapshot-then-overwrite so a
  // concurrent process can't clobber our rows (or vice versa). The snapshot
  // reads (listSpecs/listIssues) MUST be inside the lock too, not just the
  // writes — otherwise the read can go stale before the write lands.
  return withExportLock(outputDir, async () => {
    // Read existing external_links from JSONL files (to preserve them since SQLite doesn't store them)
    const existingSpecLinks = readExistingExternalLinks<SpecJSONL>(specsPath);
    const existingIssueLinks = readExistingExternalLinks<IssueJSONL>(issuesPath);

    // Export specs with preserved external_links
    const specs = exportSpecsToJSONL(db, options, existingSpecLinks);
    await writeJSONL(specsPath, specs);

    // Export issues with preserved external_links
    const issues = exportIssuesToJSONL(db, options, existingIssueLinks);
    await writeJSONL(issuesPath, issues);

    return {
      specsCount: specs.length,
      issuesCount: issues.length,
    };
  });
}

/**
 * Export only when the project's `autoExport` config is enabled (the default).
 * Entity write handlers call this instead of `exportToJSONL` directly, so a
 * decoupled store (autoExport:false) keeps SQLite as the live truth and leaves
 * JSONL to explicit `sudocode export` / the pre-commit hook.
 */
export async function maybeAutoExport(
  db: Database.Database,
  outputDir: string
): Promise<void> {
  // Imported lazily to avoid a config<->export import cycle at module load.
  const { isAutoExportEnabled } = await import("./config.js");
  if (!isAutoExportEnabled(outputDir)) return;
  await exportToJSONL(db, { outputDir });
}

/**
 * `git add` the store's JSONL files (best-effort). Used by `export --stage` so
 * the pre-commit hook can refresh + stage the artifact in one call without
 * needing to know the store path itself. Never throws — staging is advisory.
 */
export function stageJSONL(
  outputDir: string,
  specsFile = "specs.jsonl",
  issuesFile = "issues.jsonl"
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require("child_process") as typeof import("child_process");
    execFileSync(
      "git",
      ["add", "--", `${outputDir}/${specsFile}`, `${outputDir}/${issuesFile}`],
      { stdio: "ignore" }
    );
  } catch {
    // Not a git repo, git missing, or files untracked-by-choice — advisory only.
  }
}

/**
 * Debouncer for export operations
 */
export class ExportDebouncer {
  private timeoutId: NodeJS.Timeout | null = null;
  private pending: boolean = false;

  constructor(
    private db: Database.Database,
    private delayMs: number = 5000,
    private options: ExportOptions = {}
  ) {}

  /**
   * Trigger an export (will be debounced)
   */
  trigger(): void {
    this.pending = true;

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }

    this.timeoutId = setTimeout(() => {
      this.execute();
    }, this.delayMs);
  }

  /**
   * Execute the export immediately
   */
  async execute(): Promise<void> {
    if (!this.pending) {
      return;
    }

    this.pending = false;
    this.timeoutId = null;

    try {
      await exportToJSONL(this.db, this.options);
    } catch (error) {
      console.error("Export failed:", error);
      throw error;
    }
  }

  /**
   * Cancel any pending export
   */
  cancel(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.pending = false;
  }

  /**
   * Check if an export is pending
   */
  isPending(): boolean {
    return this.pending;
  }

  /**
   * Wait for any pending export to complete
   */
  async flush(): Promise<void> {
    if (this.pending) {
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        this.timeoutId = null;
      }
      await this.execute();
    }
  }
}

/**
 * Create a debounced export function
 */
export function createDebouncedExport(
  db: Database.Database,
  delayMs: number = 5000,
  options: ExportOptions = {}
): ExportDebouncer {
  return new ExportDebouncer(db, delayMs, options);
}

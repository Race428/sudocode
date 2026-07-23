/**
 * MCP tools for spec management
 */

import { SudocodeClient } from "../client.js";
import { Spec } from "../types.js";

// Tool parameter types
export interface ListSpecsParams {
  limit?: number;
  search?: string;
  archived?: boolean;
}

export interface ShowSpecParams {
  id?: string;
  spec_id?: string; // alias for id
}

export interface UpsertSpecParams {
  id?: string; // If provided, update in place; otherwise create
  spec_id?: string; // alias for id
  title?: string; // Required for create, optional for update
  priority?: number;
  content?: string;
  description?: string; // alias for content
  parent?: string;
  tags?: string[];
  archived?: boolean;
}

export interface DeleteSpecParams {
  id: string | string[];
}

// Tool implementations

/**
 * List all specs with optional filters
 */
export async function listSpecs(
  client: SudocodeClient,
  params: ListSpecsParams = {}
): Promise<Spec[]> {
  const args = ["spec", "list"];

  if (params.limit !== undefined) {
    args.push("--limit", params.limit.toString());
  }
  if (params.search) {
    args.push("--grep", params.search);
  }
  // Default to excluding archived unless explicitly specified
  const archived = params.archived !== undefined ? params.archived : false;
  args.push("--archived", archived.toString());

  const specs = await client.exec(args);

  // Redact content field from specs to keep response shorter
  if (Array.isArray(specs)) {
    return specs.map((spec: any) => {
      const { content, ...rest } = spec;
      return rest;
    });
  }

  return specs;
}

/**
 * Show detailed spec information including feedback
 */
export async function showSpec(
  client: SudocodeClient,
  params: ShowSpecParams
): Promise<any> {
  const id = params.id ?? params.spec_id;
  if (!id) {
    throw new Error("show_spec requires 'id'.");
  }
  return client.exec(["spec", "show", id]);
}

/**
 * Upsert a spec: update in place when `id` is given, else create.
 * Always returns the full spec (via show) so the caller can verify the write.
 */
export async function upsertSpec(
  client: SudocodeClient,
  params: UpsertSpecParams
): Promise<any> {
  const id = params.id ?? params.spec_id;
  const content = params.content ?? params.description;
  let writeResult: any;
  let resolvedId: string | undefined = id;

  if (id) {
    // Update mode
    const args = ["spec", "update", id];

    if (params.title) {
      args.push("--title", params.title);
    }
    if (params.priority !== undefined) {
      args.push("--priority", params.priority.toString());
    }
    if (content !== undefined) {
      args.push("--description", content);
    }
    if (params.parent !== undefined) {
      args.push("--parent", params.parent || "");
    }
    if (params.tags !== undefined) {
      args.push("--tags", params.tags.join(","));
    }
    if (params.archived !== undefined) {
      args.push("--archived", params.archived.toString());
    }

    writeResult = await client.exec(args);
  } else {
    // Create mode
    if (!params.title) {
      throw new Error("title is required when creating a new spec");
    }

    const args = ["spec", "create", params.title];

    if (params.priority !== undefined) {
      args.push("--priority", params.priority.toString());
    }
    if (content !== undefined) {
      args.push("--description", content);
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
    const full = await showSpec(client, { id: resolvedId });
    const warnings = writeResult?.reference_warnings;
    return warnings ? { ...full, reference_warnings: warnings } : full;
  }
  return writeResult;
}

/**
 * Permanently delete one or more specs. Specs have no closed/soft state; to
 * soft-remove instead, archive via upsert_spec (archived=true).
 */
export async function deleteSpec(
  client: SudocodeClient,
  params: DeleteSpecParams
): Promise<any> {
  const ids = Array.isArray(params.id) ? params.id : [params.id];
  if (ids.length === 0 || ids.some((i) => !i)) {
    throw new Error("delete_spec requires 'id' (a string or array of ids).");
  }
  return client.exec(["spec", "delete", ...ids]);
}

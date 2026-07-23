/**
 * MCP tools for feedback management
 */

import { SudocodeClient } from "../client.js";
import { Feedback, FeedbackType } from "../types.js";

// Tool parameter types
export interface AddFeedbackParams {
  /** Target ID receiving the feedback (spec or issue) — canonical */
  id?: string;
  to_id?: string; // alias for id
  entity_id?: string; // alias for id
  /** Issue ID that's providing the feedback (optional for anonymous feedback) */
  issue_id?: string;
  content: string;
  type?: FeedbackType;
  line?: number;
  text?: string;
  agent?: string;
}

/**
 * Add anchored feedback to a spec or issue
 * Entity type is inferred from the ID prefix (s- for specs, i- for issues)
 */
export async function addFeedback(
  client: SudocodeClient,
  params: AddFeedbackParams
): Promise<Feedback> {
  // Build CLI args: feedback add <target-id> [issue-id]
  const targetId = params.id ?? params.to_id ?? params.entity_id;
  if (!targetId) {
    throw new Error(
      "add_feedback requires 'id' (the spec/issue receiving the feedback)."
    );
  }
  const args = ["feedback", "add", targetId];

  if (params.issue_id) {
    args.push(params.issue_id);
  }

  args.push("--content", params.content);

  if (params.type) {
    args.push("--type", params.type);
  }
  if (params.line !== undefined) {
    args.push("--line", params.line.toString());
  }
  if (params.text) {
    args.push("--text", params.text);
  }
  // if (params.agent) {
  //   args.push("--agent", params.agent);
  // }

  return client.exec(args);
}

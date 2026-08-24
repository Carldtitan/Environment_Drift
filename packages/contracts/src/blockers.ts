import type { BlockerCode } from "./states.js";
import type { Blocker } from "./types.js";

/**
 * Every stop reason IWOMC shows a human is built here, so a blocker always has
 * a code, a factual message, and one concrete next action (R3.1, R13.5).
 */
export function blocker(
  code: BlockerCode,
  message: string,
  nextAction: string,
  detail?: Record<string, unknown>,
): Blocker {
  return detail ? { code, message, nextAction, detail } : { code, message, nextAction };
}

export class BlockedError extends Error {
  readonly blocker: Blocker;
  constructor(value: Blocker) {
    super(value.message);
    this.name = "BlockedError";
    this.blocker = value;
  }
}

export function blocked(
  code: BlockerCode,
  message: string,
  nextAction: string,
  detail?: Record<string, unknown>,
): never {
  throw new BlockedError(blocker(code, message, nextAction, detail));
}

/** Short human label used by the CLI and the console for each blocker code. */
export const BLOCKER_LABELS: Readonly<Record<BlockerCode, string>> = {
  no_project_binding: "This checkout is not bound to an IWOMC project",
  remote_mismatch: "Different Git remote",
  subdirectory_mismatch: "Different project subdirectory",
  no_contract_for_revision: "No contract for this revision",
  contract_not_approved: "Contract not approved",
  signature_invalid: "Contract signature invalid",
  signature_missing: "Contract is unsigned",
  device_revoked: "Device revoked",
  workspace_forbidden: "Not permitted in this workspace",
  platform_mismatch: "Contract does not target this platform",
  unsupported_ecosystem: "Ecosystem not natively supported",
  recipe_not_reviewed: "Recipe awaiting review",
  missing_secret: "Missing secret",
  missing_runtime: "Missing runtime",
  missing_system_tool: "Missing system tool",
  insufficient_disk_space: "Not enough disk space",
  approval_required: "Approval required",
  policy_denied: "Blocked by workspace policy",
  budget_exhausted: "Verification budget exhausted",
  step_failed: "Materialization step failed",
  proof_failed: "Proof command failed",
  proof_timeout: "Proof command timed out",
  proof_not_configured: "No proof command configured",
  interrupted: "Run interrupted",
  request_expired: "Request expired",
  invalid_input: "That input could not be read",
  integration_unavailable: "Integration unavailable",
  worktree_dirty: "Worktree has uncommitted changes",
  internal_error: "Internal error",
};

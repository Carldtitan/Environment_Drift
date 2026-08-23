/**
 * The single shared state vocabulary for IWOMC Rescue (requirement R1.3 / task 1.3).
 *
 * Every surface - CLI, MCP, control plane, console, and tests - imports these
 * names. There are deliberately no `success`, `ok`, or `green` aliases: a state
 * that is not in one of these unions cannot be displayed.
 */

/** Lifecycle of an environment contract. */
export const CONTRACT_STATES = [
  "candidate",
  "approved",
  "locally_checked",
  "clean_verified",
  "rejected",
  "unsupported",
  "inconclusive",
  "superseded",
  "revoked",
] as const;
export type ContractState = (typeof CONTRACT_STATES)[number];

/** Terminal + transitional states of a single rescue run. */
export const RESCUE_RUN_STATES = [
  "requested",
  "preflight",
  "materializing",
  "proving",
  "working",
  "failed",
  "blocked",
  "unsupported",
  "inconclusive",
  "cancelled",
] as const;
export type RescueRunState = (typeof RESCUE_RUN_STATES)[number];

/** The five results a rescue may report to a human or an agent. */
export const RESCUE_TERMINAL_STATES = [
  "working",
  "blocked",
  "failed",
  "unsupported",
  "inconclusive",
] as const;
export type RescueTerminalState = (typeof RESCUE_TERMINAL_STATES)[number];

export const RESCUE_CANCELLED = "cancelled" as const;

/** Lifecycle of a clean/local verification attempt. */
export const VERIFICATION_STATES = [
  "queued",
  "provisioning",
  "preparing_source",
  "materializing",
  "proving",
  "passed",
  "failed",
  "cancelled",
  "cleanup_failed",
] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

/** Device enrollment lifecycle. */
export const DEVICE_STATES = ["unpaired", "enrolled", "active", "revoked"] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];

/** How much of an ecosystem IWOMC can actually do, truthfully. */
export const SUPPORT_LEVELS = ["native", "recipe", "observe_only"] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

/** Where a single piece of evidence came from. */
export const EVIDENCE_SOURCES = ["observed", "declared", "derived", "unavailable"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/** Workspace roles, most privileged first. */
export const WORKSPACE_ROLES = [
  "owner",
  "maintainer",
  "developer",
  "reviewer",
  "observer",
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * Truthful integration status. `connected` is only ever produced by a
 * successful live health/authentication operation, never by the presence of an
 * environment variable.
 */
export const INTEGRATION_STATUSES = [
  "connected",
  "disconnected",
  "not_configured",
  "misconfigured",
  "permission_denied",
  "unavailable",
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

/** The badge a verification result is allowed to carry. */
export const VERIFICATION_ASSURANCES = [
  "clean_verified",
  "locally_checked",
  "unverified",
] as const;
export type VerificationAssurance = (typeof VERIFICATION_ASSURANCES)[number];

/** The runtime mode the local Companion is operating in. */
export const RUNTIME_MODES = ["local_only", "team"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

/**
 * Classified reasons a rescue stopped without proving the project works.
 * Every blocker shown to a user maps to exactly one of these.
 */
export const BLOCKER_CODES = [
  "no_project_binding",
  "remote_mismatch",
  "subdirectory_mismatch",
  "no_contract_for_revision",
  "contract_not_approved",
  "signature_invalid",
  "signature_missing",
  "device_revoked",
  "workspace_forbidden",
  "platform_mismatch",
  "unsupported_ecosystem",
  "recipe_not_reviewed",
  "missing_secret",
  "missing_runtime",
  "missing_system_tool",
  "insufficient_disk_space",
  "approval_required",
  "policy_denied",
  "budget_exhausted",
  "step_failed",
  "proof_failed",
  "proof_timeout",
  "proof_not_configured",
  "interrupted",
  "request_expired",
  "integration_unavailable",
  "worktree_dirty",
  "internal_error",
] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

/**
 * Verification is evidence; approval is authorization. They are separate axes,
 * so a candidate may be checked before anyone approves it, and an approved
 * contract may later be checked. What a contract may *not* do is claim a
 * verification it did not earn, or move backwards out of a terminal state.
 */
const CONTRACT_TRANSITIONS: Readonly<Record<ContractState, readonly ContractState[]>> = {
  candidate: ["approved", "locally_checked", "clean_verified", "rejected", "unsupported", "inconclusive"],
  approved: ["locally_checked", "clean_verified", "rejected", "revoked", "superseded"],
  locally_checked: ["approved", "clean_verified", "superseded", "revoked", "inconclusive"],
  clean_verified: ["approved", "superseded", "revoked"],
  rejected: [],
  unsupported: ["candidate"],
  inconclusive: ["candidate", "rejected"],
  superseded: [],
  revoked: [],
};

const RESCUE_TRANSITIONS: Readonly<Record<RescueRunState, readonly RescueRunState[]>> = {
  requested: ["preflight", "blocked", "unsupported", "cancelled"],
  preflight: ["materializing", "blocked", "unsupported", "inconclusive", "cancelled"],
  materializing: ["proving", "failed", "blocked", "inconclusive", "cancelled"],
  proving: ["working", "failed", "inconclusive", "cancelled"],
  working: [],
  failed: [],
  blocked: [],
  unsupported: [],
  inconclusive: [],
  cancelled: [],
};

const VERIFICATION_TRANSITIONS: Readonly<
  Record<VerificationState, readonly VerificationState[]>
> = {
  queued: ["provisioning", "cancelled", "failed"],
  provisioning: ["preparing_source", "failed", "cancelled"],
  preparing_source: ["materializing", "failed", "cancelled"],
  materializing: ["proving", "failed", "cancelled"],
  proving: ["passed", "failed", "cancelled"],
  passed: ["cleanup_failed"],
  failed: ["cleanup_failed"],
  cancelled: ["cleanup_failed"],
  cleanup_failed: [],
};

const DEVICE_TRANSITIONS: Readonly<Record<DeviceState, readonly DeviceState[]>> = {
  unpaired: ["enrolled"],
  enrolled: ["active", "revoked"],
  active: ["revoked"],
  revoked: [],
};

export function canTransitionContract(from: ContractState, to: ContractState): boolean {
  return CONTRACT_TRANSITIONS[from].includes(to);
}

export function canTransitionRescueRun(from: RescueRunState, to: RescueRunState): boolean {
  return RESCUE_TRANSITIONS[from].includes(to);
}

export function canTransitionVerification(
  from: VerificationState,
  to: VerificationState,
): boolean {
  return VERIFICATION_TRANSITIONS[from].includes(to);
}

export function canTransitionDevice(from: DeviceState, to: DeviceState): boolean {
  return DEVICE_TRANSITIONS[from].includes(to);
}

export function isRescueTerminal(state: RescueRunState): state is RescueTerminalState {
  return (RESCUE_TERMINAL_STATES as readonly string[]).includes(state);
}

/** Contracts that may be applied by `rescue` without a fresh human decision. */
export function isAutomaticallyRescuable(
  state: ContractState,
  support: SupportLevel,
  recipeReviewed: boolean,
): boolean {
  if (state !== "approved" && state !== "locally_checked" && state !== "clean_verified") {
    return false;
  }
  if (support === "observe_only") return false;
  if (support === "recipe") return recipeReviewed;
  return true;
}

/** The assurance badge a contract state is allowed to display. */
export function assuranceForContractState(state: ContractState): VerificationAssurance {
  if (state === "clean_verified") return "clean_verified";
  if (state === "locally_checked") return "locally_checked";
  return "unverified";
}

const ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = {
  owner: 5,
  maintainer: 4,
  developer: 3,
  reviewer: 2,
  observer: 1,
};

export function roleAtLeast(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

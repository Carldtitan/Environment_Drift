import type {
  BlockerCode,
  ContractState,
  DeviceState,
  EvidenceSource,
  RescueRunState,
  RescueTerminalState,
  SupportLevel,
  VerificationAssurance,
  VerificationState,
  WorkspaceRole,
} from "./states.js";
import type { Signature } from "./crypto.js";

export type { Signature } from "./crypto.js";

export type TargetOs = "linux" | "macos" | "windows";
export type TargetArch = "x64" | "arm64" | "ia32" | "arm" | "ppc64" | "s390x" | "riscv64";

export interface PlatformTarget {
  readonly os: TargetOs;
  readonly arch: TargetArch;
}

export interface FileDigest {
  /** Repository-relative POSIX path. */
  readonly path: string;
  /** `sha256:<hex>` of the file bytes. */
  readonly digest: string;
  readonly bytes: number;
}

/** The immutable identity of a checkout at one moment. */
export interface SourceReference {
  /** Full 40-character Git object id of HEAD. */
  readonly commit: string;
  /** `sha256:<hex>` of the normalized canonical remote URL. */
  readonly canonicalRemoteDigest: string;
  /** Repository-relative POSIX path of the project root ("." for the repo root). */
  readonly subdirectory: string;
  readonly declaredFileDigests: readonly FileDigest[];
  /** True when the worktree had uncommitted changes at capture time. */
  readonly worktreeDirty: boolean;
  readonly branch?: string;
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

export interface RuntimeRequirement {
  /** Stable runtime id, e.g. "node", "python", "go", "rustc", "java". */
  readonly runtime: string;
  /** Range expression interpreted by the owning adapter. */
  readonly versionSpec: string;
  /** Exact version observed on the capturing machine, when known. */
  readonly observedVersion?: string;
  readonly source: EvidenceSource;
}

export type PackageScope = "direct" | "transitive" | "tool";

export interface PackageRequirement {
  readonly ecosystem: string;
  readonly manager: string;
  readonly name: string;
  readonly versionSpec: string;
  readonly scope: PackageScope;
  readonly source: EvidenceSource;
  /** Receipt evidence ids that justify this requirement. */
  readonly evidenceRefs: readonly string[];
  /** True when the repository already declares it; false means observed-only. */
  readonly declared: boolean;
}

export interface SystemToolRequirement {
  readonly name: string;
  /** Argv used to probe presence. Never installs anything. */
  readonly probeArgv: readonly string[];
  readonly versionSpec?: string;
  readonly source: EvidenceSource;
  /** Free-text hint shown to a human when the tool is missing. */
  readonly installHint?: string;
}

/**
 * Secret requirements carry a NAME and an optional external reference only.
 * A value in this structure is a schema violation (R5.4, R12).
 */
export interface SecretRequirement {
  readonly name: string;
  readonly scope: "environment" | "file";
  readonly required: boolean;
  /** Opaque reference into an external vault, e.g. "op://vault/item/field". */
  readonly reference?: string;
  /** How a human can tell whether the value they have is the right one. */
  readonly validationHint?: string;
  readonly source: EvidenceSource;
}

// ---------------------------------------------------------------------------
// Materialization steps
// ---------------------------------------------------------------------------

export interface StepBase {
  readonly id: string;
  readonly adapterId: string;
  /** Project-relative POSIX directory the step operates in. */
  readonly workDir: string;
  /** Stable across recompilations of equivalent steps; drives idempotency. */
  readonly idempotencyKey: string;
  readonly description: string;
}

export interface EnsureRuntimeStep extends StepBase {
  readonly kind: "ensure_runtime";
  readonly runtime: string;
  readonly versionSpec: string;
  /**
   * `probe` only checks and blocks when absent.
   * `project_local` may install into the project-local managed directory.
   */
  readonly strategy: "probe" | "project_local";
  readonly probeArgv: readonly string[];
}

export interface EnsureSystemToolStep extends StepBase {
  readonly kind: "ensure_system_tool";
  readonly tool: string;
  readonly probeArgv: readonly string[];
  readonly versionSpec?: string;
  readonly installHint?: string;
}

export interface CreateVirtualEnvironmentStep extends StepBase {
  readonly kind: "create_virtual_environment";
  readonly manager: string;
  /** Project-relative POSIX path of the environment directory. */
  readonly path: string;
  readonly runtimeSpec: string;
}

export interface InstallProjectDependenciesStep extends StepBase {
  readonly kind: "install_project_dependencies";
  readonly manager: string;
  /** Project-relative lockfile/manifest the install is pinned to. */
  readonly lockfile?: string;
  readonly manifest: string;
  /** Refuse to update the lockfile during rescue. */
  readonly frozen: boolean;
  readonly timeoutMs: number;
}

export interface ApplyPackageOverlayStep extends StepBase {
  readonly kind: "apply_package_overlay";
  readonly manager: string;
  /**
   * Packages the evidence proves were used but the repository does not declare.
   * Installed into project-local state only; never written to a tracked file.
   */
  readonly packages: readonly {
    readonly name: string;
    readonly versionSpec: string;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly timeoutMs: number;
}

export interface WriteProjectLocalFileStep extends StepBase {
  readonly kind: "write_project_local_file";
  /** Must resolve inside the project-local managed directory. */
  readonly path: string;
  /** Inline, non-secret content. Digest is checked before writing. */
  readonly content: string;
  readonly contentDigest: string;
}

export interface RunReviewedRecipeStep extends StepBase {
  readonly kind: "run_reviewed_recipe";
  /** Argv form only; there is no shell string in a contract. */
  readonly argv: readonly string[];
  readonly commandDigest: string;
  readonly envAllowlist: readonly string[];
  readonly timeoutMs: number;
  readonly expectedExitCodes: readonly number[];
  readonly review: RecipeReview;
}

export interface RecipeReview {
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  /** Digest of the exact argv the reviewer approved. */
  readonly approvedCommandDigest: string;
}

export type MaterializationStep =
  | EnsureRuntimeStep
  | EnsureSystemToolStep
  | CreateVirtualEnvironmentStep
  | InstallProjectDependenciesStep
  | ApplyPackageOverlayStep
  | WriteProjectLocalFileStep
  | RunReviewedRecipeStep;

export type MaterializationStepKind = MaterializationStep["kind"];

export const MATERIALIZATION_STEP_KINDS = [
  "ensure_runtime",
  "ensure_system_tool",
  "create_virtual_environment",
  "install_project_dependencies",
  "apply_package_overlay",
  "write_project_local_file",
  "run_reviewed_recipe",
] as const satisfies readonly MaterializationStepKind[];

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------

export interface ProofCommand {
  readonly id: string;
  /** Argv form only. IWOMC never runs an unscoped shell string. */
  readonly argv: readonly string[];
  /** Project-relative POSIX directory. */
  readonly workDir: string;
  readonly timeoutMs: number;
  readonly expectedExitCodes: readonly number[];
  /** Environment variable names the proof is permitted to read. */
  readonly envAllowlist: readonly string[];
  readonly description: string;
  readonly maxOutputBytes: number;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

// ---------------------------------------------------------------------------
// Environment contract
// ---------------------------------------------------------------------------

export interface ContractPolicy {
  /** Rescue may create project-local managed state. */
  readonly allowProjectLocalState: boolean;
  /** Recipes must carry a review before they may execute. */
  readonly requireRecipeReview: boolean;
  /** Rescue must ask a human before mutating anything. */
  readonly requireHumanApproval: boolean;
  /** Source may be uploaded to a clean verifier. */
  readonly allowSourceUpload: boolean;
}

export interface EnvironmentContractV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  /** `sha256:<hex>` over the contract minus `digest` and `signature`. */
  readonly digest: string;
  /** Null in local-only mode: a local contract has no workspace. */
  readonly workspaceId: string | null;
  readonly projectId: string;
  readonly source: SourceReference;
  readonly targets: readonly PlatformTarget[];
  readonly support: SupportLevel;
  readonly requirements: {
    readonly runtimes: readonly RuntimeRequirement[];
    readonly packages: readonly PackageRequirement[];
    readonly systemTools: readonly SystemToolRequirement[];
    readonly secrets: readonly SecretRequirement[];
  };
  readonly steps: readonly MaterializationStep[];
  readonly proof: ProofCommand;
  readonly evidence: readonly { readonly receiptId: string; readonly digest: string }[];
  readonly policy: ContractPolicy;
  readonly state: ContractState;
  /** Adapters that contributed a fragment, for the capability matrix. */
  readonly adapters: readonly string[];
  readonly issuedAt: string;
  readonly authoredBy: {
    readonly deviceId: string;
    readonly identity: string;
  };
  readonly approval?: {
    readonly approvedBy: string;
    readonly approvedAt: string;
    readonly note?: string;
  };
  /**
   * Device-signed for a local-only contract, service-signed for a shareable
   * team baseline. A missing signature is never rescuable.
   */
  readonly signature?: Signature;
}

// ---------------------------------------------------------------------------
// Receipt and evidence
// ---------------------------------------------------------------------------

export interface EvidenceItem {
  readonly id: string;
  readonly source: EvidenceSource;
  readonly confidence: "high" | "medium" | "low";
  readonly adapterId: string;
  readonly kind: string;
  readonly summary: string;
  readonly detail?: Record<string, unknown>;
  readonly observedAt?: string;
}

export interface CoverageGap {
  readonly area: string;
  readonly reason: string;
  /** What IWOMC would need in order to close the gap. */
  readonly remediation?: string;
}

export interface RuntimeFingerprint {
  readonly runtime: string;
  readonly version: string;
  readonly path?: string;
  readonly source: EvidenceSource;
}

export interface InventorySnapshot {
  readonly adapterId: string;
  readonly manager: string;
  readonly takenAt: string;
  readonly entryCount: number;
  /** Digest of the full entry list, which is stored locally, not uploaded. */
  readonly digest: string;
  readonly entries: readonly { readonly name: string; readonly version: string }[];
}

// ---------------------------------------------------------------------------
// The package event log
// ---------------------------------------------------------------------------

/**
 * What happened to one package.
 *
 * A snapshot cannot express `downgraded`, and a downgrade is often the fix a
 * teammate needs to reproduce. That is the reason this log exists.
 */
export type PackageEventKind = "installed" | "upgraded" | "downgraded" | "removed";

/**
 * How IWOMC came to know about an event, in descending order of precision.
 *
 * `watched`  - a filesystem change fired and an inventory diff confirmed it.
 * `swept`    - a periodic inventory diff found it; the change happened somewhere
 *              inside the observation window.
 * `imported` - reconstructed from a receipt captured before watching began.
 */
export type PackageEventSource = "watched" | "swept" | "imported";

/**
 * The process IWOMC believes caused an event.
 *
 * Correlation is by time window, working directory, and process ancestry. It is
 * evidence, not proof, so it carries its own confidence and is never required
 * for the event itself to be trusted.
 */
export interface ObservedCause {
  readonly argv: readonly string[];
  readonly pid: number;
  readonly startedAt?: string;
  readonly confidence: "high" | "medium" | "low";
  readonly agentSession?: {
    readonly provider: string;
    readonly sessionRef: string;
  };
}

export interface PackageEventV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  /** Monotonic per project, so a replay is deterministic. */
  readonly seq: number;

  /** When IWOMC recorded the event. */
  readonly at: string;
  /**
   * The window the change actually happened in. A watched event has a narrow
   * window; a swept event's window is the whole sweep interval. Never claim
   * more precision than the observation method provides.
   */
  readonly window: { readonly from: string; readonly to: string };

  readonly ecosystem: string;
  readonly manager: string;
  readonly adapterId: string;
  readonly name: string;
  /** Previous version; null when the package was newly installed. */
  readonly fromVersion: string | null;
  /** New version; null when the package was removed. */
  readonly toVersion: string | null;
  readonly kind: PackageEventKind;

  /**
   * HEAD at the moment of observation. This, not the timestamp, is the primary
   * key for "what did this machine look like at their commit" - a clock can be
   * wrong or skewed between machines, a revision cannot.
   */
  readonly commit: string | null;
  readonly branch: string | null;
  readonly worktreeDirty: boolean;

  readonly source: PackageEventSource;
  readonly cause?: ObservedCause;
}

/**
 * A full inventory written into the log periodically.
 *
 * Replaying every event since the beginning of a project would get slower
 * forever. A baseline is the fold up to one point, so a point-in-time query
 * only has to replay events after the most recent one.
 */
export interface InventoryBaselineV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly seq: number;
  readonly at: string;
  readonly commit: string | null;
  readonly entries: readonly {
    readonly ecosystem: string;
    readonly manager: string;
    readonly adapterId: string;
    readonly name: string;
    readonly version: string;
  }[];
  readonly digest: string;
}

/** The reconstructed state of a project's packages at one point. */
export interface PointInTimeState {
  /** The instant, revision, or event sequence the fold was taken at. */
  readonly at: string;
  readonly commit: string | null;
  readonly packages: readonly {
    readonly ecosystem: string;
    readonly manager: string;
    readonly adapterId: string;
    readonly name: string;
    readonly version: string;
    /** When this exact version arrived, if the log knows. */
    readonly since?: string;
  }[];
  /** Events replayed after the baseline to produce this state. */
  readonly replayedEvents: number;
  /**
   * What this fold cannot account for: time before watching began, gaps while
   * the watcher was not running, or ecosystems with no inventory strategy.
   */
  readonly coverage: readonly CoverageGap[];
}

export interface ProofAttempt {
  readonly proofId: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly assurance: VerificationAssurance;
  readonly startedAt: string;
}

export interface RedactionReport {
  readonly findingCount: number;
  readonly categories: readonly string[];
  readonly knownSecretNames: readonly string[];
}

export interface EnvironmentReceiptV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly digest: string;
  readonly workspaceId: string | null;
  readonly projectId: string;
  readonly deviceId: string;
  readonly capturedAt: string;
  readonly source: SourceReference;
  readonly host: {
    readonly os: TargetOs;
    readonly arch: TargetArch;
    readonly osRelease?: string;
  };
  readonly runtimes: readonly RuntimeFingerprint[];
  readonly evidence: readonly EvidenceItem[];
  readonly inventories: readonly InventorySnapshot[];
  readonly coverage: readonly CoverageGap[];
  readonly redaction: RedactionReport;
  readonly agentSession?: {
    readonly provider: string;
    readonly sessionRef: string;
  };
  readonly proofAttempt?: ProofAttempt;
  readonly signature?: Signature;
}

// ---------------------------------------------------------------------------
// Rescue
// ---------------------------------------------------------------------------

export type DeviceJobAction = "capture" | "verify" | "rescue" | "promote";

/**
 * A job the hosted console asks a device to perform. It carries identifiers
 * only: the browser never sends a local filesystem path (R10.4).
 */
export interface RescueRequestV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly deviceId: string;
  readonly action: DeviceJobAction;
  readonly contractId?: string;
  readonly requestedBy: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly signature?: Signature;
}

export type RescueEventKind =
  | "run_started"
  | "state_changed"
  | "preflight_check"
  | "step_started"
  | "step_output"
  | "step_finished"
  | "proof_started"
  | "proof_output"
  | "proof_finished"
  | "blocked"
  | "memory_status"
  | "run_finished";

export interface RescueEvent {
  readonly runId: string;
  readonly seq: number;
  readonly at: string;
  readonly kind: RescueEventKind;
  readonly state?: RescueRunState;
  readonly stepId?: string;
  readonly stream?: "stdout" | "stderr";
  readonly message: string;
  readonly exitCode?: number;
  readonly blocker?: Blocker;
}

export interface Blocker {
  readonly code: BlockerCode;
  readonly message: string;
  /** The exact next action a human can take. */
  readonly nextAction: string;
  readonly detail?: Record<string, unknown>;
}

export interface RescueOutcomeV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly workspaceId: string | null;
  readonly projectId: string;
  readonly deviceId: string;
  readonly contractId: string;
  readonly contractDigest: string;
  readonly commit: string;
  readonly state: RescueTerminalState;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly stepsApplied: readonly string[];
  readonly proof?: ProofAttempt;
  readonly blocker?: Blocker;
  /** Digest of the append-only local operation journal for this run. */
  readonly journalDigest: string;
  readonly assurance: VerificationAssurance;
  readonly signature?: Signature;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type VerifierId = "modal" | "local_fresh_directory";

export interface VerificationCost {
  readonly currency: "USD";
  readonly amount: number;
  readonly basis: string;
}

export interface VerificationAttestationV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly contractId: string;
  readonly contractDigest: string;
  readonly verifier: VerifierId;
  readonly state: VerificationState;
  readonly assurance: VerificationAssurance;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly runtimeFingerprint: readonly RuntimeFingerprint[];
  readonly platform: PlatformTarget;
  readonly stepExitCodes: readonly { readonly stepId: string; readonly exitCode: number }[];
  readonly proofExitCode: number | null;
  readonly proofTimedOut: boolean;
  /** Digest of the bounded redacted log persisted alongside this attestation. */
  readonly logDigest: string;
  readonly cleanup: "terminated" | "cleanup_failed" | "not_required";
  readonly cost?: VerificationCost;
  readonly failureReason?: string;
  readonly signature?: Signature;
}

// ---------------------------------------------------------------------------
// Workspace, identity, audit
// ---------------------------------------------------------------------------

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface Person {
  /** `github:<numeric id>` in team mode, `local:<uuid>` in local-only mode. */
  readonly id: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
}

export interface Membership {
  readonly workspaceId: string;
  readonly personId: string;
  readonly role: WorkspaceRole;
  readonly joinedAt: string;
}

export interface Project {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly canonicalRemoteDigest: string;
  readonly subdirectory: string;
  readonly createdAt: string;
  readonly defaultProofId?: string;
}

export interface Device {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly personId: string;
  readonly displayName: string;
  /** base64url raw Ed25519 public key. Private keys never leave the device. */
  readonly publicKey: string;
  readonly state: DeviceState;
  readonly enrolledAt: string;
  readonly lastSeenAt?: string;
  readonly revokedAt?: string;
  readonly platform: PlatformTarget;
}

export interface Invitation {
  readonly id: string;
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
  /** Only the hash is stored; the raw token is shown once at creation. */
  readonly tokenHash: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedAt?: string;
  readonly acceptedBy?: string;
  readonly revokedAt?: string;
}

export interface AuditEvent {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly subject: string;
  readonly detail: Record<string, unknown>;
  /** Chain digest linking to the previous audit event in the workspace. */
  readonly previousDigest: string | null;
  readonly digest: string;
}

// ---------------------------------------------------------------------------
// Drift and promotion
// ---------------------------------------------------------------------------

export interface DriftFinding {
  readonly id: string;
  readonly projectId: string;
  readonly commit: string;
  readonly adapterId: string;
  readonly kind:
    | "undeclared_package"
    | "runtime_pin_missing"
    | "missing_declaration_file"
    | "declared_not_installed"
    /** Installed here at a version the repository would not install. */
    | "version_mismatch";
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly affectedDeclaration: string;
  readonly proposedRepair: ProposedRepair | null;
  readonly detectedAt: string;
}

export interface ProposedRepair {
  readonly id: string;
  readonly description: string;
  readonly files: readonly ProposedFileChange[];
  readonly requiresReview: true;
}

export interface ProposedFileChange {
  /** Repository-relative POSIX path of a tracked file. */
  readonly path: string;
  readonly before: string | null;
  readonly after: string;
  readonly unifiedDiff: string;
}

// ---------------------------------------------------------------------------
// Support / capability reporting
// ---------------------------------------------------------------------------

export interface AdapterCapabilityRow {
  readonly adapterId: string;
  readonly ecosystem: string;
  readonly manager: string;
  readonly support: SupportLevel;
  readonly detects: boolean;
  readonly readsDeclaredState: boolean;
  readonly inventories: boolean;
  readonly compiles: boolean;
  readonly materializes: boolean;
  readonly verifies: boolean;
  /** True only when the adapter has a passing conformance test. */
  readonly conformanceTested: boolean;
}

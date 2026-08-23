import type { Redactor } from "@iwomc/contracts";
import type {
  EnvironmentContractV1,
  IntegrationStatus,
  PlatformTarget,
  ProofCommand,
  RescueOutcomeV1,
  RescueRequestV1,
  VerificationAttestationV1,
  EnvironmentReceiptV1,
} from "@iwomc/contracts";

/**
 * Ports the Companion depends on. Each has exactly one production
 * implementation and, in tests only, a double. A double may never produce a
 * `connected` status in the running application (R9.6).
 */

// ---------------------------------------------------------------------------
// Durable memory (Claude-Mem)
// ---------------------------------------------------------------------------

export type MemoryEventType =
  | "capture"
  | "drift"
  | "verification"
  | "rescue"
  | "promotion";

/**
 * The only shape IWOMC writes to memory. It carries a project pseudonym, a
 * revision, an event type, non-secret facts, an outcome, and references back
 * to IWOMC's own records - nothing else (R9.3).
 */
export interface LifecycleObservation {
  readonly event: MemoryEventType;
  readonly outcome: string;
  /** Stable pseudonym derived from the project id, not its name or path. */
  readonly projectPseudonym: string;
  readonly revision: string;
  readonly facts: Readonly<Record<string, string | number | boolean>>;
  /** IWOMC record ids the observation refers to. */
  readonly references: Readonly<Record<string, string>>;
  readonly at: string;
}

export interface MemoryHit {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly createdAt: string | null;
  readonly source: "claude-mem";
}

export interface MemoryStatus {
  readonly status: IntegrationStatus;
  /** Shown verbatim in the CLI and console. */
  readonly detail: string;
  readonly endpoint: string | null;
}

export interface MemoryPort {
  readonly id: "claude-mem";
  status(): Promise<MemoryStatus>;
  /**
   * Returns `recorded: false` with a reason when memory is unavailable.
   *
   * `redactor` is the project-aware one when the caller has it: it knows the
   * literal values in that project's environment files, which no shape-based
   * rule could recognise. Without it the default redactor still applies.
   */
  record(
    observation: LifecycleObservation,
    redactor?: Redactor,
  ): Promise<{ recorded: boolean; reason?: string }>;
  /** Explanatory history only. Never used as environment truth (R9.4). */
  search(input: {
    projectPseudonym: string;
    query: string;
    limit: number;
  }): Promise<{ hits: MemoryHit[]; status: MemoryStatus }>;
}

// ---------------------------------------------------------------------------
// Clean verification
// ---------------------------------------------------------------------------

export interface VerificationRequest {
  readonly contract: EnvironmentContractV1;
  readonly proof: ProofCommand;
  /** Absolute path of a checkout at the contract's exact revision. */
  readonly sourceDir: string;
  readonly platform: PlatformTarget;
  readonly onEvent?: (event: { at: string; phase: string; message: string }) => void;
  readonly signal?: AbortSignal;
}

export interface VerificationOutput {
  readonly attestation: VerificationAttestationV1;
  readonly log: string;
}

export interface VerifierAvailability {
  readonly available: boolean;
  readonly status: IntegrationStatus;
  readonly detail: string;
  /** Remaining budget for verifiers that cost money. */
  readonly remainingBudgetUsd?: number;
}

/**
 * Whether this verifier may be used for one particular contract. A verifier can
 * be perfectly available and still not applicable - for example when a project
 * has not approved sending its source to a remote verifier. That is a skip with
 * a stated reason, not a failed verification.
 */
export interface VerifierApplicability {
  readonly applicable: boolean;
  readonly reason: string;
}

export interface VerifierPort {
  readonly id: "modal" | "local_fresh_directory";
  readonly label: string;
  availability(): Promise<VerifierAvailability>;
  applicability(contract: EnvironmentContractV1): Promise<VerifierApplicability>;
  verify(request: VerificationRequest): Promise<VerificationOutput>;
}

// ---------------------------------------------------------------------------
// Team control plane
// ---------------------------------------------------------------------------

export interface DeviceCredentials {
  readonly deviceId: string;
  readonly token: string;
}

export interface ControlPlanePort {
  readonly baseUrl: string;
  health(): Promise<{ status: IntegrationStatus; detail: string }>;
  enrollDevice(input: {
    invitationToken: string;
    publicKey: string;
    displayName: string;
    platform: PlatformTarget;
  }): Promise<{
    deviceId: string;
    deviceToken: string;
    workspaceId: string;
    personId: string;
    role: string;
  }>;
  registerProjectBinding(input: {
    credentials: DeviceCredentials;
    projectId: string | null;
    projectName: string;
    canonicalRemoteDigest: string;
    subdirectory: string;
  }): Promise<{ projectId: string }>;
  publishReceipt(input: {
    credentials: DeviceCredentials;
    receipt: EnvironmentReceiptV1;
  }): Promise<{ accepted: boolean }>;
  publishContract(input: {
    credentials: DeviceCredentials;
    contract: EnvironmentContractV1;
  }): Promise<{ contract: EnvironmentContractV1 }>;
  fetchContract(input: {
    credentials: DeviceCredentials;
    projectId: string;
    commit: string;
  }): Promise<{ exact: EnvironmentContractV1 | null; nearest: EnvironmentContractV1 | null }>;
  publishRescueOutcome(input: {
    credentials: DeviceCredentials;
    outcome: RescueOutcomeV1;
  }): Promise<{ accepted: boolean }>;
  pollJobs(input: { credentials: DeviceCredentials }): Promise<RescueRequestV1[]>;
  reportJobProgress(input: {
    credentials: DeviceCredentials;
    jobId: string;
    state: string;
    message: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Source access (GitHub)
// ---------------------------------------------------------------------------

export interface SourceAccessPort {
  readonly id: "github";
  status(): Promise<{ status: IntegrationStatus; detail: string }>;
  /** Device-flow sign-in. Returns the verification URI for the user. */
  beginDeviceLogin(): Promise<{ userCode: string; verificationUri: string; deviceCode: string; intervalSeconds: number }>;
  completeDeviceLogin(deviceCode: string): Promise<{ personId: string; login: string }>;
  /** Materialize the exact revision into `targetDir` for clean verification. */
  fetchSourceAtRevision(input: {
    canonicalRemoteDigest: string;
    commit: string;
    targetDir: string;
  }): Promise<{ ok: boolean; detail: string }>;
}

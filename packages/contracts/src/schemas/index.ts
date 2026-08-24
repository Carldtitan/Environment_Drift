/**
 * Canonical IWOMC JSON Schema documents.
 *
 * These are the single source of truth for every record that crosses a trust
 * boundary. The TypeScript interfaces in `../types.ts` are checked against
 * these documents by `schema-parity.test.ts`, so a field cannot drift in one
 * place without failing the build.
 */
import {
  CONTRACT_STATES,
  EVIDENCE_SOURCES,
  RESCUE_RUN_STATES,
  RESCUE_TERMINAL_STATES,
  SUPPORT_LEVELS,
  VERIFICATION_ASSURANCES,
  VERIFICATION_STATES,
  BLOCKER_CODES,
  WORKSPACE_ROLES,
} from "../states.js";
import type { JsonSchema } from "../json-schema.js";
import { MATERIALIZATION_STEP_KINDS } from "../types.js";

const DIGEST: JsonSchema = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" };
const ID: JsonSchema = { type: "string", minLength: 1, maxLength: 128 };
const TIMESTAMP: JsonSchema = { type: "string", format: "date-time" };
const COMMIT: JsonSchema = { type: "string", pattern: "^[0-9a-f]{40}$" };
const POSIX_PATH: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  // No absolute paths, no drive letters, no parent traversal, no backslashes.
  pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$",
};
const RELATIVE_DIR: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  pattern: "^(?:\\.|(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+)$",
};
const ENV_NAME: JsonSchema = { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$", maxLength: 128 };

const SIGNATURE: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["algorithm", "publicKey", "value", "signer", "keyId", "signedAt"],
  properties: {
    algorithm: { const: "ed25519" },
    publicKey: { type: "string", minLength: 40, maxLength: 64 },
    value: { type: "string", minLength: 80, maxLength: 100 },
    signer: { enum: ["device", "service"] },
    keyId: { type: "string", pattern: "^[0-9a-f]{32}$" },
    signedAt: TIMESTAMP,
  },
};

const PLATFORM_TARGET: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["os", "arch"],
  properties: {
    os: { enum: ["linux", "macos", "windows"] },
    arch: { enum: ["x64", "arm64", "ia32", "arm", "ppc64", "s390x", "riscv64"] },
  },
};

const FILE_DIGEST: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "digest", "bytes"],
  properties: { path: POSIX_PATH, digest: DIGEST, bytes: { type: "integer", minimum: 0 } },
};

const SOURCE_REFERENCE: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["commit", "canonicalRemoteDigest", "subdirectory", "declaredFileDigests", "worktreeDirty"],
  properties: {
    commit: COMMIT,
    canonicalRemoteDigest: DIGEST,
    subdirectory: RELATIVE_DIR,
    declaredFileDigests: { type: "array", items: FILE_DIGEST, maxItems: 512 },
    worktreeDirty: { type: "boolean" },
    branch: { type: "string", maxLength: 255 },
  },
};

const EVIDENCE_SOURCE: JsonSchema = { enum: [...EVIDENCE_SOURCES] };

const STEP_BASE_PROPERTIES: Record<string, JsonSchema> = {
  id: ID,
  adapterId: ID,
  workDir: RELATIVE_DIR,
  idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
  description: { type: "string", minLength: 1, maxLength: 512 },
};

const STEP_BASE_REQUIRED = ["id", "kind", "adapterId", "workDir", "idempotencyKey", "description"];

function step(kind: string, extra: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: [...STEP_BASE_REQUIRED, ...required],
    properties: { ...STEP_BASE_PROPERTIES, kind: { const: kind }, ...extra },
  };
}

const TIMEOUT_MS: JsonSchema = {
  type: "integer",
  minimum: 1000,
  maximum: 3_600_000,
};

export const MATERIALIZATION_STEP_SCHEMA: JsonSchema = {
  $id: "https://iwomc.dev/schemas/materialization-step-v1.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "MaterializationStep",
  description:
    "A typed, bounded operation a rescue may perform. There is no unscoped shell command variant.",
  oneOf: [
    step(
      "ensure_runtime",
      {
        runtime: { type: "string", minLength: 1, maxLength: 64 },
        versionSpec: { type: "string", minLength: 1, maxLength: 128 },
        strategy: { enum: ["probe", "project_local"] },
        probeArgv: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 },
      },
      ["runtime", "versionSpec", "strategy", "probeArgv"],
    ),
    step(
      "ensure_system_tool",
      {
        tool: { type: "string", minLength: 1, maxLength: 64 },
        probeArgv: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 },
        versionSpec: { type: "string", maxLength: 128 },
        installHint: { type: "string", maxLength: 512 },
      },
      ["tool", "probeArgv"],
    ),
    step(
      "create_virtual_environment",
      {
        manager: { type: "string", minLength: 1, maxLength: 64 },
        path: POSIX_PATH,
        runtimeSpec: { type: "string", minLength: 1, maxLength: 128 },
      },
      ["manager", "path", "runtimeSpec"],
    ),
    step(
      "install_project_dependencies",
      {
        manager: { type: "string", minLength: 1, maxLength: 64 },
        lockfile: POSIX_PATH,
        manifest: POSIX_PATH,
        frozen: { type: "boolean" },
        timeoutMs: TIMEOUT_MS,
      },
      ["manager", "manifest", "frozen", "timeoutMs"],
    ),
    step(
      "apply_package_overlay",
      {
        manager: { type: "string", minLength: 1, maxLength: 64 },
        packages: {
          type: "array",
          minItems: 1,
          maxItems: 256,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "versionSpec", "evidenceRefs"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 214 },
              versionSpec: { type: "string", minLength: 1, maxLength: 128 },
              evidenceRefs: { type: "array", items: ID, minItems: 1, maxItems: 32 },
            },
          },
        },
        timeoutMs: TIMEOUT_MS,
      },
      ["manager", "packages", "timeoutMs"],
    ),
    step(
      "write_project_local_file",
      {
        // Enforced again at execution time: must be inside the managed dir.
        path: POSIX_PATH,
        content: { type: "string", maxLength: 65536 },
        contentDigest: DIGEST,
      },
      ["path", "content", "contentDigest"],
    ),
    step(
      "run_reviewed_recipe",
      {
        argv: { type: "array", items: { type: "string", maxLength: 4096 }, minItems: 1, maxItems: 64 },
        commandDigest: DIGEST,
        envAllowlist: { type: "array", items: ENV_NAME, maxItems: 64 },
        timeoutMs: TIMEOUT_MS,
        expectedExitCodes: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 255 },
          minItems: 1,
          maxItems: 16,
        },
        review: {
          type: "object",
          additionalProperties: false,
          required: ["reviewedBy", "reviewedAt", "approvedCommandDigest"],
          properties: {
            reviewedBy: ID,
            reviewedAt: TIMESTAMP,
            approvedCommandDigest: DIGEST,
          },
        },
      },
      ["argv", "commandDigest", "envAllowlist", "timeoutMs", "expectedExitCodes", "review"],
    ),
  ],
};

export const PROOF_COMMAND_SCHEMA: JsonSchema = {
  $id: "https://iwomc.dev/schemas/proof-command-v1.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ProofCommand",
  description: "The approved command that decides whether the project actually works.",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "argv",
    "workDir",
    "timeoutMs",
    "expectedExitCodes",
    "envAllowlist",
    "description",
    "maxOutputBytes",
  ],
  properties: {
    id: ID,
    argv: { type: "array", items: { type: "string", maxLength: 4096 }, minItems: 1, maxItems: 64 },
    workDir: RELATIVE_DIR,
    timeoutMs: TIMEOUT_MS,
    expectedExitCodes: {
      type: "array",
      items: { type: "integer", minimum: 0, maximum: 255 },
      minItems: 1,
      maxItems: 16,
    },
    envAllowlist: { type: "array", items: ENV_NAME, maxItems: 128 },
    description: { type: "string", minLength: 1, maxLength: 512 },
    maxOutputBytes: { type: "integer", minimum: 1024, maximum: 8_388_608 },
    approvedBy: ID,
    approvedAt: TIMESTAMP,
  },
};

const SECRET_REQUIREMENT: JsonSchema = {
  type: "object",
  // additionalProperties:false is the schema-level guarantee that no `value`,
  // `secret`, or `token` field can ever ride along inside a contract.
  additionalProperties: false,
  required: ["name", "scope", "required", "source"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 128 },
    scope: { enum: ["environment", "file"] },
    required: { type: "boolean" },
    reference: { type: "string", maxLength: 512 },
    validationHint: { type: "string", maxLength: 512 },
    source: EVIDENCE_SOURCE,
  },
};

export const ENVIRONMENT_CONTRACT_SCHEMA: JsonSchema = {
  $id: "https://iwomc.dev/schemas/environment-contract-v1.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "EnvironmentContractV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "id",
    "digest",
    "workspaceId",
    "projectId",
    "source",
    "targets",
    "support",
    "requirements",
    "steps",
    "proof",
    "evidence",
    "policy",
    "state",
    "adapters",
    "issuedAt",
    "authoredBy",
  ],
  properties: {
    schemaVersion: { const: 1 },
    id: ID,
    digest: DIGEST,
    workspaceId: { type: ["string", "null"], maxLength: 128 },
    projectId: ID,
    source: SOURCE_REFERENCE,
    targets: { type: "array", items: PLATFORM_TARGET, minItems: 1, maxItems: 16 },
    support: { enum: [...SUPPORT_LEVELS] },
    requirements: {
      type: "object",
      additionalProperties: false,
      required: ["runtimes", "packages", "systemTools", "secrets"],
      properties: {
        runtimes: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["runtime", "versionSpec", "source"],
            properties: {
              runtime: { type: "string", minLength: 1, maxLength: 64 },
              versionSpec: { type: "string", minLength: 1, maxLength: 128 },
              observedVersion: { type: "string", maxLength: 128 },
              source: EVIDENCE_SOURCE,
            },
          },
        },
        packages: {
          type: "array",
          maxItems: 4096,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "ecosystem",
              "manager",
              "name",
              "versionSpec",
              "scope",
              "source",
              "evidenceRefs",
              "declared",
            ],
            properties: {
              ecosystem: { type: "string", minLength: 1, maxLength: 64 },
              manager: { type: "string", minLength: 1, maxLength: 64 },
              name: { type: "string", minLength: 1, maxLength: 214 },
              versionSpec: { type: "string", minLength: 1, maxLength: 128 },
              scope: { enum: ["direct", "transitive", "tool"] },
              source: EVIDENCE_SOURCE,
              evidenceRefs: { type: "array", items: ID, maxItems: 64 },
              declared: { type: "boolean" },
            },
          },
        },
        systemTools: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "probeArgv", "source"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 64 },
              probeArgv: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 },
              versionSpec: { type: "string", maxLength: 128 },
              source: EVIDENCE_SOURCE,
              installHint: { type: "string", maxLength: 512 },
            },
          },
        },
        secrets: { type: "array", items: SECRET_REQUIREMENT, maxItems: 256 },
      },
    },
    steps: { type: "array", items: MATERIALIZATION_STEP_SCHEMA, maxItems: 256 },
    proof: PROOF_COMMAND_SCHEMA,
    evidence: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["receiptId", "digest"],
        properties: { receiptId: ID, digest: DIGEST },
      },
    },
    policy: {
      type: "object",
      additionalProperties: false,
      required: [
        "allowProjectLocalState",
        "requireRecipeReview",
        "requireHumanApproval",
        "allowSourceUpload",
      ],
      properties: {
        allowProjectLocalState: { type: "boolean" },
        requireRecipeReview: { type: "boolean" },
        requireHumanApproval: { type: "boolean" },
        allowSourceUpload: { type: "boolean" },
      },
    },
    state: { enum: [...CONTRACT_STATES] },
    adapters: { type: "array", items: ID, maxItems: 64 },
    issuedAt: TIMESTAMP,
    authoredBy: {
      type: "object",
      additionalProperties: false,
      required: ["deviceId", "identity"],
      properties: { deviceId: ID, identity: ID },
    },
    approval: {
      type: "object",
      additionalProperties: false,
      required: ["approvedBy", "approvedAt"],
      properties: { approvedBy: ID, approvedAt: TIMESTAMP, note: { type: "string", maxLength: 1024 } },
    },
    signature: SIGNATURE,
  },
};

export const RECEIPT_SCHEMA: JsonSchema = {
  $id: "https://iwomc.dev/schemas/environment-receipt-v1.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "EnvironmentReceiptV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "id",
    "digest",
    "workspaceId",
    "projectId",
    "deviceId",
    "capturedAt",
    "source",
    "host",
    "runtimes",
    "evidence",
    "inventories",
    "coverage",
    "redaction",
  ],
  properties: {
    schemaVersion: { const: 1 },
    id: ID,
    digest: DIGEST,
    workspaceId: { type: ["string", "null"], maxLength: 128 },
    projectId: ID,
    deviceId: ID,
    capturedAt: TIMESTAMP,
    source: SOURCE_REFERENCE,
    host: {
      type: "object",
      additionalProperties: false,
      required: ["os", "arch"],
      properties: {
        os: { enum: ["linux", "macos", "windows"] },
        arch: { enum: ["x64", "arm64", "ia32", "arm", "ppc64", "s390x", "riscv64"] },
        osRelease: { type: "string", maxLength: 255 },
      },
    },
    runtimes: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["runtime", "version", "source"],
        properties: {
          runtime: { type: "string", minLength: 1, maxLength: 64 },
          version: { type: "string", minLength: 1, maxLength: 128 },
          path: { type: "string", maxLength: 1024 },
          source: EVIDENCE_SOURCE,
        },
      },
    },
    evidence: {
      type: "array",
      maxItems: 4096,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "source", "confidence", "adapterId", "kind", "summary"],
        properties: {
          id: ID,
          source: EVIDENCE_SOURCE,
          confidence: { enum: ["high", "medium", "low"] },
          adapterId: ID,
          kind: { type: "string", minLength: 1, maxLength: 64 },
          summary: { type: "string", minLength: 1, maxLength: 1024 },
          detail: { type: "object" },
          observedAt: TIMESTAMP,
        },
      },
    },
    inventories: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["adapterId", "manager", "takenAt", "entryCount", "digest", "entries"],
        properties: {
          adapterId: ID,
          manager: { type: "string", minLength: 1, maxLength: 64 },
          takenAt: TIMESTAMP,
          entryCount: { type: "integer", minimum: 0 },
          digest: DIGEST,
          entries: {
            type: "array",
            maxItems: 8192,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "version"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 214 },
                version: { type: "string", maxLength: 128 },
              },
            },
          },
        },
      },
    },
    coverage: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["area", "reason"],
        properties: {
          area: { type: "string", minLength: 1, maxLength: 128 },
          reason: { type: "string", minLength: 1, maxLength: 1024 },
          remediation: { type: "string", maxLength: 1024 },
        },
      },
    },
    redaction: {
      type: "object",
      additionalProperties: false,
      required: ["findingCount", "categories", "knownSecretNames"],
      properties: {
        findingCount: { type: "integer", minimum: 0 },
        categories: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 32 },
        knownSecretNames: { type: "array", items: { type: "string", maxLength: 128 }, maxItems: 512 },
      },
    },
    agentSession: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "sessionRef"],
      properties: {
        provider: { type: "string", minLength: 1, maxLength: 64 },
        sessionRef: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
    proofAttempt: { $ref: "#/$defs/proofAttempt" },
    signature: SIGNATURE,
  },
  $defs: {
    proofAttempt: {
      type: "object",
      additionalProperties: false,
      required: ["proofId", "exitCode", "durationMs", "timedOut", "assurance", "startedAt"],
      properties: {
        proofId: ID,
        exitCode: { type: ["integer", "null"] },
        durationMs: { type: "integer", minimum: 0 },
        timedOut: { type: "boolean" },
        assurance: { enum: [...VERIFICATION_ASSURANCES] },
        startedAt: TIMESTAMP,
      },
    },
  },
};

const BLOCKER: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "nextAction"],
  properties: {
    code: { enum: [...BLOCKER_CODES] },
    message: { type: "string", minLength: 1, maxLength: 2048 },
    nextAction: { type: "string", minLength: 1, maxLength: 1024 },
    detail: { type: "object" },
  },
};

export const RESCUE_REQUEST_SCHEMA: JsonSchema = {
  $id: "https://iwomc.dev/schemas/rescue-request-v1.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "RescueRequestV1",
  description:
    "A signed, expiring job addressed to one device. It carries identifiers only - never a local filesystem path.",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "id",
    "workspaceId",
    "projectId",
    "deviceId",
    "action",
    "requestedBy",
    "issuedAt",
    "expiresAt",
    "idempotencyKey",
  ],
  properties: {
    schemaVersion: { const: 1 },
    id: ID,
    workspaceId: ID,
    projectId: ID,
    deviceId: ID,
    action: { enum: ["capture", "verify", "rescue", "promote"] },
    contractId: ID,
    requestedBy: ID,
    issuedAt: TIMESTAMP,
    expiresAt: TIMESTAMP,
    idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
    signature: SIGNATURE,
  },
};

export const RESCUE_EVENT_SCHEMA: JsonSchema = {
  $id: "https://iwomc.dev/schemas/rescue-event-v1.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "RescueEvent",
  type: "object",
  additionalProperties: false,
  required: ["runId", "seq", "at", "kind", "message"],
  properties: {
    runId: ID,
    seq: { type: "integer", minimum: 0 },
    at: TIMESTAMP,
    kind: {
      enum: [
        "run_started",
        "state_changed",
        "preflight_check",
        "step_started",
        "step_output",
        "step_finished",
        "proof_started",
        "proof_output",
        "proof_finished",
        "blocked",
        "memory_status",
        "run_finished",
      ],
    },
    state: { enum: [...RESCUE_RUN_STATES] },
    stepId: ID,
    stream: { enum: ["stdout", "stderr"] },
    message: { type: "string", maxLength: 16384 },
    exitCode: { type: "integer" },
    blocker: BLOCKER,
  },
};

export const RESCUE_OUTCOME_SCHEMA: JsonSchema = {
  $id: "https://iwomc.dev/schemas/rescue-outcome-v1.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "RescueOutcomeV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "runId",
    "workspaceId",
    "projectId",
    "deviceId",
    "contractId",
    "contractDigest",
    "commit",
    "state",
    "startedAt",
    "endedAt",
    "stepsApplied",
    "journalDigest",
    "assurance",
  ],
  properties: {
    schemaVersion: { const: 1 },
    runId: ID,
    workspaceId: { type: ["string", "null"], maxLength: 128 },
    projectId: ID,
    deviceId: ID,
    contractId: ID,
    contractDigest: DIGEST,
    commit: COMMIT,
    state: { enum: [...RESCUE_TERMINAL_STATES] },
    startedAt: TIMESTAMP,
    endedAt: TIMESTAMP,
    stepsApplied: { type: "array", items: ID, maxItems: 256 },
    proof: { $ref: "#/$defs/proofAttempt" },
    blocker: BLOCKER,
    journalDigest: DIGEST,
    assurance: { enum: [...VERIFICATION_ASSURANCES] },
    signature: SIGNATURE,
  },
  $defs: {
    proofAttempt: RECEIPT_SCHEMA.$defs?.["proofAttempt"] as JsonSchema,
  },
};

export const VERIFICATION_ATTESTATION_SCHEMA: JsonSchema = {
  $id: "https://iwomc.dev/schemas/verification-attestation-v1.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "VerificationAttestationV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "id",
    "contractId",
    "contractDigest",
    "verifier",
    "state",
    "assurance",
    "startedAt",
    "endedAt",
    "runtimeFingerprint",
    "platform",
    "stepExitCodes",
    "proofExitCode",
    "proofTimedOut",
    "logDigest",
    "cleanup",
  ],
  properties: {
    schemaVersion: { const: 1 },
    id: ID,
    contractId: ID,
    contractDigest: DIGEST,
    verifier: { enum: ["modal", "local_fresh_directory"] },
    state: { enum: [...VERIFICATION_STATES] },
    assurance: { enum: [...VERIFICATION_ASSURANCES] },
    startedAt: TIMESTAMP,
    endedAt: TIMESTAMP,
    runtimeFingerprint: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["runtime", "version", "source"],
        properties: {
          runtime: { type: "string", maxLength: 64 },
          version: { type: "string", maxLength: 128 },
          path: { type: "string", maxLength: 1024 },
          source: EVIDENCE_SOURCE,
        },
      },
    },
    platform: PLATFORM_TARGET,
    stepExitCodes: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stepId", "exitCode"],
        properties: { stepId: ID, exitCode: { type: "integer" } },
      },
    },
    proofExitCode: { type: ["integer", "null"] },
    proofTimedOut: { type: "boolean" },
    logDigest: DIGEST,
    cleanup: { enum: ["terminated", "cleanup_failed", "not_required"] },
    cost: {
      type: "object",
      additionalProperties: false,
      required: ["currency", "amount", "basis"],
      properties: {
        currency: { const: "USD" },
        amount: { type: "number", minimum: 0 },
        basis: { type: "string", maxLength: 256 },
      },
    },
    failureReason: { type: "string", maxLength: 2048 },
    signature: SIGNATURE,
  },
};

export const PACKAGE_EVENT_SCHEMA: JsonSchema = {
  $id: "https://iwomc.dev/schemas/package-event-v1.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "PackageEventV1",
  description:
    "One observed change to a project-local package, bound to both a time window and the revision that was checked out.",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "id",
    "projectId",
    "seq",
    "at",
    "window",
    "ecosystem",
    "manager",
    "adapterId",
    "name",
    "fromVersion",
    "toVersion",
    "kind",
    "commit",
    "branch",
    "worktreeDirty",
    "source",
  ],
  properties: {
    schemaVersion: { const: 1 },
    id: ID,
    projectId: ID,
    seq: { type: "integer", minimum: 0 },
    at: TIMESTAMP,
    window: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to"],
      properties: { from: TIMESTAMP, to: TIMESTAMP },
    },
    ecosystem: { type: "string", minLength: 1, maxLength: 64 },
    manager: { type: "string", minLength: 1, maxLength: 64 },
    adapterId: ID,
    name: { type: "string", minLength: 1, maxLength: 214 },
    fromVersion: { type: ["string", "null"], maxLength: 128 },
    toVersion: { type: ["string", "null"], maxLength: 128 },
    kind: { enum: ["installed", "upgraded", "downgraded", "removed"] },
    commit: { type: ["string", "null"], pattern: "^[0-9a-f]{40}$" },
    branch: { type: ["string", "null"], maxLength: 255 },
    worktreeDirty: { type: "boolean" },
    source: { enum: ["watched", "swept", "imported"] },
    cause: {
      type: "object",
      additionalProperties: false,
      required: ["argv", "pid", "confidence"],
      properties: {
        argv: { type: "array", items: { type: "string", maxLength: 4096 }, minItems: 1, maxItems: 64 },
        pid: { type: "integer", minimum: 0 },
        startedAt: TIMESTAMP,
        confidence: { enum: ["high", "medium", "low"] },
        agentSession: {
          type: "object",
          additionalProperties: false,
          required: ["provider", "sessionRef"],
          properties: {
            provider: { type: "string", minLength: 1, maxLength: 64 },
            sessionRef: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
      },
    },
  },
};

export const INVENTORY_BASELINE_SCHEMA: JsonSchema = {
  $id: "https://iwomc.dev/schemas/inventory-baseline-v1.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "InventoryBaselineV1",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "projectId", "seq", "at", "commit", "entries", "digest"],
  properties: {
    schemaVersion: { const: 1 },
    id: ID,
    projectId: ID,
    // The very first baseline sits at -1: it is the state before any event
    // was recorded, which is exactly what a fold needs as its starting point.
    seq: { type: "integer", minimum: -1 },
    at: TIMESTAMP,
    commit: { type: ["string", "null"], pattern: "^[0-9a-f]{40}$" },
    digest: DIGEST,
    entries: {
      type: "array",
      maxItems: 20_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ecosystem", "manager", "adapterId", "name", "version"],
        properties: {
          ecosystem: { type: "string", minLength: 1, maxLength: 64 },
          manager: { type: "string", minLength: 1, maxLength: 64 },
          adapterId: { type: "string", minLength: 1, maxLength: 64 },
          name: { type: "string", minLength: 1, maxLength: 214 },
          version: { type: "string", maxLength: 128 },
        },
      },
    },
  },
};

export const WORKSPACE_ROLE_SCHEMA: JsonSchema = {
  $id: "https://iwomc.dev/schemas/workspace-role.json",
  title: "WorkspaceRole",
  enum: [...WORKSPACE_ROLES],
};

/** Every schema document IWOMC publishes, keyed by short name. */
export const SCHEMAS = {
  "environment-contract-v1": ENVIRONMENT_CONTRACT_SCHEMA,
  "environment-receipt-v1": RECEIPT_SCHEMA,
  "materialization-step-v1": MATERIALIZATION_STEP_SCHEMA,
  "proof-command-v1": PROOF_COMMAND_SCHEMA,
  "rescue-request-v1": RESCUE_REQUEST_SCHEMA,
  "rescue-event-v1": RESCUE_EVENT_SCHEMA,
  "rescue-outcome-v1": RESCUE_OUTCOME_SCHEMA,
  "verification-attestation-v1": VERIFICATION_ATTESTATION_SCHEMA,
  "package-event-v1": PACKAGE_EVENT_SCHEMA,
  "inventory-baseline-v1": INVENTORY_BASELINE_SCHEMA,
  "workspace-role": WORKSPACE_ROLE_SCHEMA,
} as const satisfies Record<string, JsonSchema>;

export type SchemaName = keyof typeof SCHEMAS;

/** Kinds the step schema accepts, for cross-checking against the TS union. */
export const SCHEMA_STEP_KINDS: readonly string[] = (MATERIALIZATION_STEP_SCHEMA.oneOf ?? []).map(
  (variant) => (variant.properties?.["kind"] as JsonSchema | undefined)?.const as string,
);

export { MATERIALIZATION_STEP_KINDS };

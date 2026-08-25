import { randomUUID } from "node:crypto";
import { mkdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import {
  BlockedError,
  ContractIntegrityError,
  blocker,
  digestOf,
  isAutomaticallyRescuable,
  signPayload,
  verifyContractIntegrity,
  type Blocker,
  type EnvironmentContractV1,
  type ProofAttempt,
  type RescueEvent,
  type RescueOutcomeV1,
  type RescueRunState,
  type RescueTerminalState,
  type VerificationAssurance,
} from "@iwomc/contracts";
import type { AdapterRegistry, MaterializationContext } from "@iwomc/adapters";
import { probe } from "./exec.js";
import { assessPortability, describePortability } from "./portability.js";
import { buildProjectRedactor } from "./capture.js";
import { materialize } from "./materialize.js";
import { runProof } from "./proof.js";
import { MANAGED_DIR, managedDirFor } from "./paths.js";
import { digestDeclaredFiles, type ProjectContext } from "./project.js";
import type { CompanionStore } from "./store.js";
import type { DeviceIdentity } from "./identity.js";
import type { MemoryHit, MemoryPort } from "./ports.js";

/**
 * The rescue loop (design 4.3).
 *
 * Order matters and is not negotiable: bind, resolve an exact contract, verify
 * its signature, preflight, materialize project-local state only, then run the
 * proof command. `working` is produced by the proof step and nowhere else.
 */

export interface RescueInput {
  readonly project: ProjectContext;
  readonly device: DeviceIdentity;
  readonly registry: AdapterRegistry;
  readonly store: CompanionStore;
  readonly contract: EnvironmentContractV1;
  readonly contractOrigin: "local" | "team";
  /**
   * True when the person named this contract by id rather than letting IWOMC
   * choose one. That is the gesture `remote_mismatch` tells them to make, and
   * it is the only thing that permits applying a contract captured against a
   * different Git remote - and then only at the identical commit.
   */
  readonly contractNamedExplicitly?: boolean;
  readonly memory?: MemoryPort;
  readonly approved: boolean;
  readonly onEvent?: (event: RescueEvent) => void;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
  /** Minimum free bytes required before any install runs. */
  readonly minimumFreeBytes?: number;
}

export interface RescueResult {
  readonly runId: string;
  readonly state: RescueTerminalState;
  readonly outcome: RescueOutcomeV1;
  readonly events: readonly RescueEvent[];
  readonly blocker: Blocker | null;
  readonly proof: ProofAttempt | null;
  readonly explanations: readonly MemoryHit[];
  readonly memoryDetail: string;
}

const DEFAULT_MIN_FREE_BYTES = 512 * 1024 * 1024;

export async function rescue(input: RescueInput): Promise<RescueResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const runId = randomUUID();
  const startedAt = now();
  const events: RescueEvent[] = [];
  let seq = 0;
  let state: RescueRunState = "requested";

  const emit = (event: Omit<RescueEvent, "runId" | "seq" | "at">): void => {
    const full: RescueEvent = { runId, seq: seq++, at: now(), ...event };
    events.push(full);
    input.store.appendEvent(full);
    input.onEvent?.(full);
  };
  const setState = (next: RescueRunState, message: string): void => {
    state = next;
    input.store.updateRunState(runId, next);
    emit({ kind: "state_changed", state: next, message });
  };

  input.store.createRun({
    id: runId,
    projectId: input.project.binding.projectId,
    contractId: input.contract.id,
    commit: input.project.git.commit,
    checkoutPath: input.project.projectDir,
    state,
    startedAt,
  });
  emit({
    kind: "run_started",
    state: "requested",
    message: `Rescuing ${input.project.binding.projectName} at ${input.project.git.commit.slice(0, 12)} with contract ${input.contract.digest.slice(7, 19)}.`,
  });

  const assurance: VerificationAssurance =
    input.contract.state === "clean_verified"
      ? "clean_verified"
      : input.contract.state === "locally_checked"
        ? "locally_checked"
        : "unverified";

  const journalEntries: {
    stepId: string;
    idempotencyKey: string;
    phase: "started" | "succeeded" | "failed" | "skipped";
    detail: Record<string, unknown>;
  }[] = [];
  let journalSeq = 0;
  const journal = (entry: {
    stepId: string;
    idempotencyKey: string;
    phase: "started" | "succeeded" | "failed" | "skipped";
    detail: Record<string, unknown>;
  }): void => {
    journalEntries.push(entry);
    input.store.appendJournal({ runId, seq: journalSeq++, at: now(), ...entry });
  };

  // Explanatory history. Never authoritative; only shown next to the facts.
  let explanations: MemoryHit[] = [];
  let memoryDetail = "Memory integration not configured.";
  if (input.memory) {
    const found = await input.memory.search({
      projectPseudonym: projectPseudonym(input.project.binding.projectId),
      query: `environment rescue ${input.project.binding.projectName}`,
      limit: 5,
    });
    explanations = found.hits;
    memoryDetail = found.status.detail;
    emit({
      kind: "memory_status",
      message:
        found.status.status === "connected"
          ? `Memory connected: ${found.hits.length} prior observation(s) available as explanation.`
          : `Memory disconnected: ${found.status.detail} Rescue continues without it.`,
    });
  }

  const finish = async (
    terminal: RescueTerminalState,
    stepsApplied: readonly string[],
    proofAttempt: ProofAttempt | null,
    failure: Blocker | null,
  ): Promise<RescueResult> => {
    const endedAt = now();
    const journalDigest = digestOf(journalEntries);
    const outcomeBody = {
      schemaVersion: 1 as const,
      runId,
      workspaceId: input.project.binding.workspaceId,
      projectId: input.project.binding.projectId,
      deviceId: input.device.id,
      contractId: input.contract.id,
      contractDigest: input.contract.digest,
      commit: input.project.git.commit,
      state: terminal,
      startedAt,
      endedAt,
      stepsApplied: [...stepsApplied],
      ...(proofAttempt ? { proof: proofAttempt } : {}),
      ...(failure ? { blocker: failure } : {}),
      journalDigest,
      assurance: terminal === "working" ? assurance : ("unverified" as VerificationAssurance),
    };
    const outcome: RescueOutcomeV1 = {
      ...outcomeBody,
      signature: signPayload(outcomeBody, input.device.keyPair, "device", endedAt),
    };
    input.store.finishRun(runId, outcome);
    state = terminal;
    emit({
      kind: "run_finished",
      state: terminal,
      message: terminalMessage(terminal, failure),
      ...(failure ? { blocker: failure } : {}),
    });

    input.store.appendAudit({
      id: randomUUID(),
      workspaceId: input.project.binding.workspaceId,
      at: endedAt,
      actor: input.device.personId,
      action: "rescue.completed",
      subject: `run:${runId}`,
      detail: {
        state: terminal,
        contractDigest: input.contract.digest,
        commit: input.project.git.commit,
        proofExitCode: proofAttempt?.exitCode ?? null,
      },
    });

    if (input.memory) {
      await input.memory.record({
        event: "rescue",
        outcome: terminal,
        projectPseudonym: projectPseudonym(input.project.binding.projectId),
        revision: input.project.git.commit,
        facts: {
          support: input.contract.support,
          steps_applied: stepsApplied.length,
          proof_exit_code: proofAttempt?.exitCode ?? -1,
          assurance: outcome.assurance,
          blocker: failure?.code ?? "none",
          secret_values_present: false,
        },
        references: { run_id: runId, contract_digest: input.contract.digest },
        at: endedAt,
      }, await buildProjectRedactor(input.project.projectDir));
    }

    return {
      runId,
      state: terminal,
      outcome,
      events,
      blocker: failure,
      proof: proofAttempt,
      explanations,
      memoryDetail,
    };
  };

  // -- Preflight ----------------------------------------------------------
  setState("preflight", "Checking this checkout against the contract before changing anything.");

  try {
    const preflightBlocker = await preflight(input, emit);
    if (preflightBlocker) {
      const terminal: RescueTerminalState =
        preflightBlocker.code === "unsupported_ecosystem" || preflightBlocker.code === "recipe_not_reviewed"
          ? "unsupported"
          : "blocked";
      setState(terminal, preflightBlocker.message);
      return await finish(terminal, [], null, preflightBlocker);
    }
  } catch (error) {
    const failure =
      error instanceof BlockedError
        ? error.blocker
        : blocker(
            "internal_error",
            `Preflight failed: ${(error as Error).message}`,
            "Run `iwomc doctor` and try again.",
          );
    setState("blocked", failure.message);
    return await finish("blocked", [], null, failure);
  }

  // -- Materialize --------------------------------------------------------
  setState("materializing", "Preparing project-local environment state.");

  const managedDir = managedDirFor(input.project.projectDir);
  await mkdir(managedDir, { recursive: true });

  const trackedPaths = await readTrackedPaths(input.project.projectDir);
  const digestOptions = {
    commit: input.project.git.commit,
    dirtyPaths: new Set(input.project.git.dirtyPaths),
    subdirectory: input.project.binding.subdirectory,
  };
  const declaredBefore = await digestDeclaredFiles(
    input.project.projectDir,
    input.contract.source.declaredFileDigests.map((entry) => entry.path),
    digestOptions,
  );

  const materializationContext: MaterializationContext = {
    projectDir: input.project.projectDir,
    files: input.project.files,
    platform: input.project.platform,
    probe: (argv, options) =>
      probe(argv, {
        cwd: options?.cwd ?? input.project.projectDir,
        timeoutMs: options?.timeoutMs ?? 30_000,
        ...(options?.env ? { env: options.env } : {}),
      }),
    managedDir: MANAGED_DIR,
    availableSecretNames: presentSecretNames(input.contract),
  };

  const materialized = await materialize({
    contract: input.contract,
    registry: input.registry,
    context: materializationContext,
    completedKeys: input.store.completedIdempotencyKeys(
      input.project.binding.projectId,
      input.contract.id,
      input.project.projectDir,
    ),
    emit,
    journal,
    trackedPaths,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const stepsApplied = materialized.outcomes
    .filter((outcome) => outcome.status === "succeeded")
    .map((outcome) => outcome.stepId);

  // Rescue must never modify a tracked file (R6.4).
  const declaredAfter = await digestDeclaredFiles(
    input.project.projectDir,
    input.contract.source.declaredFileDigests.map((entry) => entry.path),
    digestOptions,
  );
  const modified = declaredBefore.filter((before) => {
    const after = declaredAfter.find((entry) => entry.path === before.path);
    return after !== undefined && after.digest !== before.digest;
  });
  if (modified.length > 0) {
    const failure = blocker(
      "policy_denied",
      `Materialization modified tracked file(s): ${modified.map((entry) => entry.path).join(", ")}. Rescue must not change declared state.`,
      "Restore those files with `git checkout --` and report this contract; run `iwomc promote` to propose a reviewed repository change instead.",
    );
    setState("failed", failure.message);
    return await finish("failed", stepsApplied, null, failure);
  }

  if (materialized.blocker) {
    const failure = materialized.blocker;
    const terminal: RescueTerminalState =
      failure.code === "missing_runtime" ||
      failure.code === "missing_system_tool" ||
      failure.code === "missing_secret"
        ? "blocked"
        : failure.code === "recipe_not_reviewed"
          ? "unsupported"
          : "failed";
    setState(terminal, failure.message);
    return await finish(terminal, stepsApplied, null, failure);
  }

  // Adapter-level checks: what the ecosystem itself considers satisfied.
  for (const adapterId of input.contract.adapters) {
    const adapter = input.registry.byId(adapterId);
    if (!adapter) continue;
    const verification = await adapter.verifyAfterMaterialize(materializationContext);
    for (const check of verification.checks) {
      emit({
        kind: "preflight_check",
        message: `${adapterId}: ${check.name} - ${check.passed ? "ok" : "not satisfied"} (${check.detail})`,
      });
    }
  }

  // -- Prove --------------------------------------------------------------
  setState("proving", "Running the project's proof command.");

  const proofResult = await runProof({
    proof: input.contract.proof,
    projectDir: input.project.projectDir,
    assurance,
    emit,
    env: projectLocalPathEnv(input.project.projectDir, input.project.platform.os),
    ...(input.signal ? { signal: input.signal } : {}),
    now,
  });

  if (!proofResult.passed) {
    const failure =
      proofResult.blocker ??
      blocker("proof_failed", "The proof command did not pass.", "Read the proof output above.");
    const terminal: RescueTerminalState = failure.code === "proof_timeout" ? "inconclusive" : "failed";
    setState(terminal, failure.message);
    return await finish(terminal, stepsApplied, proofResult.attempt, failure);
  }

  setState("working", "The proof command passed. This checkout works.");
  return await finish("working", stepsApplied, proofResult.attempt, null);
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function preflight(
  input: RescueInput,
  emit: (event: Omit<RescueEvent, "runId" | "seq" | "at">) => void,
): Promise<Blocker | null> {
  const { contract, project } = input;

  // A contract is bound to the project it was captured for, and a different
  // Git remote means a different project. Two checkouts of the same code can
  // still have different remotes - a fork, or a clone taken from a path - and
  // the `remote_mismatch` blocker tells people to apply such a contract by
  // naming its id. That advice has to actually work, so naming the id waives
  // the project binding. Nothing else is waived: the commit must be identical,
  // so the code is the same code, and the signature is still checked in full.
  const sameRevision = contract.source.commit === project.git.commit;
  const crossProject = contract.projectId !== project.binding.projectId;
  const consentedToCrossProject = input.contractNamedExplicitly === true && sameRevision;

  // Signature and integrity, before anything is touched.
  try {
    verifyContractIntegrity(contract, {
      ...(consentedToCrossProject ? {} : { expectedProjectId: project.binding.projectId }),
      ...(input.contractOrigin === "local"
        ? { trustedDeviceKeys: [input.device.publicKey] }
        : {}),
    });
    emit({ kind: "preflight_check", message: "Contract signature verified." });
    if (consentedToCrossProject && crossProject) {
      // Applying another project's contract is worth a line in the log and a
      // line on the screen, every time. It is permitted, not unremarkable.
      emit({
        kind: "preflight_check",
        message: `This contract was captured against a different Git remote. Applying it because you named it by id, and because it is for this exact commit (${contract.source.commit.slice(0, 12)}).`,
      });
      input.store.appendAudit({
        id: randomUUID(),
        workspaceId: project.binding.workspaceId,
        at: new Date().toISOString(),
        actor: input.device.personId,
        action: "security.contract_applied_across_projects",
        subject: `contract:${contract.id}`,
        detail: {
          contractProjectId: contract.projectId,
          checkoutProjectId: project.binding.projectId,
          commit: contract.source.commit,
        },
      });
    }
  } catch (error) {
    if (error instanceof ContractIntegrityError) {
      const code =
        error.reason === "signature_missing"
          ? "signature_missing"
          : error.reason === "wrong_project"
            ? "workspace_forbidden"
            : "signature_invalid";
      input.store.appendAudit({
        id: randomUUID(),
        workspaceId: project.binding.workspaceId,
        at: new Date().toISOString(),
        actor: input.device.personId,
        action: "security.contract_rejected",
        subject: `contract:${contract.id}`,
        detail: { reason: error.reason },
      });
      return blocker(
        code,
        error.message,
        "Fetch the contract again from the control plane, or capture a new one on a working checkout.",
      );
    }
    throw error;
  }

  if (input.device.state === "revoked") {
    return blocker(
      "device_revoked",
      "This device has been revoked in its workspace.",
      "Ask an owner or maintainer to re-enroll this device, then run `iwomc join` again.",
    );
  }

  // Exact revision.
  if (contract.source.commit !== project.git.commit) {
    return blocker(
      "no_contract_for_revision",
      `The contract was captured at ${contract.source.commit.slice(0, 12)} but this checkout is at ${project.git.commit.slice(0, 12)}.`,
      "Check out the exact revision, or choose a nearest contract explicitly with `iwomc rescue --contract <id>`.",
      { contractCommit: contract.source.commit, localCommit: project.git.commit },
    );
  }

  // Same repository, unless the person named this contract for this exact
  // commit, which is the documented way to say "yes, apply it anyway".
  if (
    !consentedToCrossProject &&
    contract.source.canonicalRemoteDigest !== project.git.canonicalRemoteDigest
  ) {
    return blocker(
      "remote_mismatch",
      "This checkout's Git remote does not match the one the contract was captured from.",
      "Run rescue from a checkout of the same repository.",
    );
  }

  // Platform. Being captured elsewhere is not by itself a reason to refuse:
  // what matters is whether anything in the contract only installs there.
  const portability = assessPortability(contract, project.platform);
  if (!portability.capturedHere && !portability.portable) {
    return blocker(
      "platform_mismatch",
      describePortability(portability, project.platform),
      `Ask a teammate on ${project.platform.os}/${project.platform.arch} to run \`iwomc capture\` at this revision.`,
      {
        capturedOn: portability.capturedOn,
        blockedBy: portability.blocking.map((entry) => `${entry.name} (${entry.reason})`),
      },
    );
  }
  emit({
    kind: "preflight_check",
    message: portability.capturedHere
      ? `Platform ${project.platform.os}/${project.platform.arch} matches the contract.`
      : describePortability(portability, project.platform),
  });

  // Support level and approval.
  const recipeReviewed = contract.steps
    .filter((step) => step.kind === "run_reviewed_recipe")
    .every((step) => step.review.approvedCommandDigest === step.commandDigest);
  if (!isAutomaticallyRescuable(contract.state, contract.support, recipeReviewed)) {
    if (contract.support === "observe_only") {
      return blocker(
        "unsupported_ecosystem",
        "This contract is observe-only: IWOMC captured evidence but has no approved way to materialize this project.",
        "Add a reviewed setup recipe, or contribute a native adapter for this ecosystem.",
      );
    }
    if (contract.support === "recipe" && !recipeReviewed) {
      return blocker(
        "recipe_not_reviewed",
        "This contract contains a setup recipe that has not been reviewed.",
        "Ask a maintainer to review the recipe in the Rescue Console before running it.",
      );
    }
    return blocker(
      "contract_not_approved",
      `The contract is in state "${contract.state}", which is not approved for automatic rescue.`,
      "Approve the contract in the Rescue Console, or run `iwomc verify` to check it locally first.",
    );
  }

  // Human approval, when policy demands it.
  if (contract.policy.requireHumanApproval && !input.approved) {
    return blocker(
      "approval_required",
      "This contract's policy requires explicit approval before rescue may change anything.",
      "Re-run with `iwomc rescue --approve`, or approve the run in the Rescue Console.",
    );
  }

  // Declared files must match what the contract was captured against.
  const declaredNow = await digestDeclaredFiles(
    project.projectDir,
    contract.source.declaredFileDigests.map((entry) => entry.path),
    {
      commit: project.git.commit,
      dirtyPaths: new Set(project.git.dirtyPaths),
      subdirectory: project.binding.subdirectory,
    },
  );
  const mismatched = contract.source.declaredFileDigests.filter((expected) => {
    const actual = declaredNow.find((entry) => entry.path === expected.path);
    return actual === undefined || actual.digest !== expected.digest;
  });
  if (mismatched.length > 0) {
    return blocker(
      "no_contract_for_revision",
      `Declared file(s) differ from the captured source: ${mismatched.map((entry) => entry.path).join(", ")}.`,
      "Reset those files to the contract's revision, or capture a new contract for the current state.",
      { paths: mismatched.map((entry) => entry.path) },
    );
  }
  emit({
    kind: "preflight_check",
    message: `${contract.source.declaredFileDigests.length} declared file(s) match the captured source.`,
  });

  // Secrets: named requirements must be present, by name only.
  const missingSecrets = contract.requirements.secrets
    .filter((secret) => secret.required)
    .filter((secret) => {
      const value = process.env[secret.name];
      return value === undefined || value.trim().length === 0;
    });
  if (missingSecrets.length > 0) {
    return blocker(
      "missing_secret",
      `Required secret(s) are not set in this environment: ${missingSecrets.map((secret) => secret.name).join(", ")}.`,
      `Set ${missingSecrets.map((secret) => secret.name).join(", ")} from your team's secret store, then run rescue again. IWOMC never copies secret values between machines.`,
      {
        names: missingSecrets.map((secret) => secret.name),
        references: missingSecrets
          .map((secret) => secret.reference)
          .filter((reference): reference is string => typeof reference === "string"),
      },
    );
  }

  // Disk space.
  const free = await freeBytes(project.projectDir);
  const minimum = input.minimumFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  if (free !== null && free < minimum) {
    return blocker(
      "insufficient_disk_space",
      `Only ${(free / 1024 / 1024).toFixed(0)} MB is free where this checkout lives; rescue needs at least ${(minimum / 1024 / 1024).toFixed(0)} MB.`,
      "Free up disk space and run rescue again.",
    );
  }
  emit({
    kind: "preflight_check",
    message:
      free === null
        ? "Free disk space could not be measured on this platform; the check was skipped rather than assumed."
        : `${(free / 1024 / 1024 / 1024).toFixed(1)} GB free on the checkout's volume.`,
  });

  // Adapter preflight.
  const materializationContext: MaterializationContext = {
    projectDir: project.projectDir,
    files: project.files,
    platform: project.platform,
    probe: (argv, options) =>
      probe(argv, {
        cwd: options?.cwd ?? project.projectDir,
        timeoutMs: options?.timeoutMs ?? 30_000,
        ...(options?.env ? { env: options.env } : {}),
      }),
    managedDir: MANAGED_DIR,
    availableSecretNames: presentSecretNames(contract),
  };
  for (const adapterId of contract.adapters) {
    const adapter = input.registry.byId(adapterId);
    if (!adapter) {
      return blocker(
        "unsupported_ecosystem",
        `This IWOMC build has no adapter named ${adapterId}, which the contract requires.`,
        "Upgrade IWOMC on this machine, or capture a contract with the adapters it has.",
      );
    }
    const result = await adapter.preflight(materializationContext, contract.steps);
    const first = result.issues[0];
    if (first) {
      const code =
        first.code === "missing_runtime"
          ? "missing_runtime"
          : first.code === "missing_system_tool"
            ? "missing_system_tool"
            : "unsupported_ecosystem";
      return blocker(code, first.message, first.nextAction);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function projectPseudonym(projectId: string): string {
  return `iwomc-${digestOf({ projectId }).slice(7, 19)}`;
}

function presentSecretNames(contract: EnvironmentContractV1): string[] {
  return contract.requirements.secrets
    .map((secret) => secret.name)
    .filter((name) => {
      const value = process.env[name];
      return value !== undefined && value.trim().length > 0;
    });
}

/** Put project-local tool directories first so the proof uses them. */
function projectLocalPathEnv(projectDir: string, os: string): Record<string, string> {
  const separator = os === "windows" ? ";" : ":";
  const additions = [
    join(projectDir, "node_modules", ".bin"),
    join(projectDir, ".venv", os === "windows" ? "Scripts" : "bin"),
  ];
  const existing = process.env["PATH"] ?? process.env["Path"] ?? "";
  return { PATH: `${additions.join(separator)}${separator}${existing}` };
}

async function readTrackedPaths(projectDir: string): Promise<Set<string>> {
  const result = await probe(["git", "ls-files"], { cwd: projectDir, timeoutMs: 60_000 });
  if (!result.ok) return new Set();
  return new Set(
    result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

async function freeBytes(path: string): Promise<number | null> {
  try {
    const stats = await statfs(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function terminalMessage(state: RescueTerminalState, failure: Blocker | null): string {
  switch (state) {
    case "working":
      return "working - the proof command passed on this checkout.";
    case "failed":
      return `failed - ${failure?.message ?? "the proof command did not pass."}`;
    case "blocked":
      return `blocked - ${failure?.message ?? "a precondition was not met."}`;
    case "unsupported":
      return `unsupported - ${failure?.message ?? "IWOMC has no approved way to materialize this project."}`;
    case "inconclusive":
      return `inconclusive - ${failure?.message ?? "the run could not determine whether the project works."}`;
    default:
      return state;
  }
}

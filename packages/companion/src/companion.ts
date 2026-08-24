import { randomUUID } from "node:crypto";
import {
  BlockedError,
  assuranceForContractState,
  blocker,
  digestOf,
  isAutomaticallyRescuable,
  parseContract,
  signContract,
  transitionContract,
  type Blocker,
  type ContractState,
  type DriftFinding,
  type EnvironmentContractV1,
  type EnvironmentReceiptV1,
  type IntegrationStatus,
  type PackageEventV1,
  type ProofCommand,
  type RescueEvent,
  type SupportLevel,
  type VerificationAttestationV1,
} from "@iwomc/contracts";
import { defaultRegistry, type AdapterRegistry } from "@iwomc/adapters";
import { CompanionStore, type ProjectBinding, type StoredContract, type StoredRun } from "./store.js";
import { currentPlatform, ensureDeviceIdentity, isLocalOnlyIdentity, type DeviceIdentity } from "./identity.js";
import { bindProject, resolveBoundProject, type ProjectContext } from "./project.js";
import { buildProjectRedactor, captureEnvironment, type CaptureResult } from "./capture.js";
import { rescue as runRescue, projectPseudonym, type RescueResult } from "./rescue.js";
import { draftProofCommand } from "./proof.js";
import { applyPromotion, proposePromotion, type PromotionProposal } from "./promote.js";
import { LocalFreshDirectoryVerifier } from "./verify-local.js";
import {
  loadConfig,
  saveConfig,
  validateIntegrationConfig,
  type IntegrationReport,
  type IwomcConfig,
} from "./config.js";
import { probe } from "./exec.js";
import type { MemoryPort, MemoryStatus, MemoryTimelineEntry, VerifierPort } from "./ports.js";
import { NotAGitRepositoryError, expandCommit } from "./git.js";
import { PackageWatcher, RecorderBusyError, type SweepResult, type WatchOptions } from "./watch.js";
import {
  diffAt,
  diffCommits,
  isCommitNotObserved,
  stateAt,
  stateAtCommit,
  type CommitNotObserved,
  type HistoryResult,
} from "./history.js";
import type { StateDiff } from "./timeline.js";
import {
  chooseContract,
  coveredPlatforms,
  type ContractChoice,
} from "./choose-contract.js";
import { agreementFor, type Agreement } from "./agreement.js";

/**
 * The Companion service.
 *
 * The CLI, the local MCP server, and the control-plane job runner all call
 * these methods; none of them re-implements the workflow (R3.1). Every method
 * returns a structured result that a human view and an agent view can both
 * render without inventing state.
 */

export interface CompanionOptions {
  readonly store?: CompanionStore;
  readonly registry?: AdapterRegistry;
  readonly memory?: MemoryPort;
  readonly verifiers?: readonly VerifierPort[];
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
}

export interface ProjectSummary {
  readonly projectId: string;
  readonly projectName: string;
  readonly workspaceId: string | null;
  readonly subdirectory: string;
  readonly commit: string;
  readonly branch: string | null;
  readonly remoteConfigured: boolean;
  readonly worktreeDirty: boolean;
  readonly dirtyPathCount: number;
}

export interface ContractSummary {
  readonly id: string;
  readonly digest: string;
  readonly state: ContractState;
  readonly support: SupportLevel;
  readonly origin: "local" | "team";
  readonly commit: string;
  readonly issuedAt: string;
  readonly stepCount: number;
  readonly proofCommand: string;
  readonly assurance: ReturnType<typeof assuranceForContractState>;
  readonly signedBy: "device" | "service" | null;
}

export interface StatusResult {
  readonly mode: "local_only" | "team";
  readonly device: {
    readonly id: string;
    readonly displayName: string;
    readonly state: string;
    readonly identity: string;
    readonly localOnly: boolean;
    readonly platform: string;
  };
  readonly project: ProjectSummary | null;
  readonly projectError: string | null;
  readonly support: { level: SupportLevel; reason: string; recognized: { manager: string; support: SupportLevel; note: string; signals: string[] }[] };
  readonly proof: { configured: boolean; command: string | null; description: string | null };
  readonly contracts: readonly ContractSummary[];
  readonly exactContract: ContractSummary | null;
  readonly nearestContract: ContractSummary | null;
  readonly canRescueNow: { possible: boolean; reason: string };
  /**
   * Where the team's captures of this revision differ, or null when fewer
   * than two are comparable. Null means "nothing to compare", never "checked
   * and found to agree".
   */
  readonly agreement: Agreement | null;
  readonly recentRuns: readonly {
    id: string;
    state: string;
    startedAt: string;
    endedAt: string | null;
    commit: string;
  }[];
  readonly integrations: readonly IntegrationReport[];
  readonly memory: { status: IntegrationStatus; detail: string };
  readonly driftCount: number;
  readonly home: string;
}

export interface TimelineResult {
  readonly project: ProjectSummary;
  readonly anchor: { readonly at: string; readonly commit: string | null };
  /** Deterministic. Identical on any machine holding the same log. */
  readonly state: HistoryResult;
  readonly recentEvents: readonly PackageEventV1[];
  readonly totalEvents: number;
  /**
   * Narration, not evidence. Null when the integration is not configured, and
   * carries a `disconnected` status when the worker is not running - the rest
   * of the result is unaffected either way.
   */
  readonly memory: {
    readonly status: MemoryStatus;
    readonly entries: readonly MemoryTimelineEntry[];
  } | null;
}

export interface TimelineDiffResult {
  readonly project: ProjectSummary;
  readonly from: { readonly at: string | null; readonly commit: string | null };
  readonly to: { readonly at: string | null; readonly commit: string | null };
  /** Null when a requested revision was never observed on this device. */
  readonly diff: StateDiff | null;
  readonly missing: readonly CommitNotObserved[];
}

export class Companion {
  readonly store: CompanionStore;
  readonly registry: AdapterRegistry;
  config: IwomcConfig;
  readonly device: DeviceIdentity;
  readonly #memory: MemoryPort | undefined;
  readonly #verifiers: readonly VerifierPort[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => string;

  constructor(options: CompanionOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.store = options.store ?? CompanionStore.open(this.#env);
    this.registry = options.registry ?? defaultRegistry();
    this.config = loadConfig(this.#env);
    this.device = ensureDeviceIdentity(this.store, this.#now);
    this.#memory = options.memory;
    this.#verifiers = options.verifiers ?? [];
  }

  get memory(): MemoryPort | undefined {
    return this.#memory;
  }

  close(): void {
    this.store.close();
  }

  /**
   * Turn the background recorder on or off for this device.
   *
   * Written to the config file rather than held in memory, because the answer
   * has to survive the command that changed it - the next `iwomc status` is a
   * different process, and it is the one that decides whether to start a
   * recorder.
   */
  setAutocapture(enabled: boolean): IwomcConfig {
    const next = saveConfig({ autocapture: enabled }, this.#env);
    this.config = next;
    return next;
  }

  // -- status -------------------------------------------------------------

  async status(dir: string): Promise<StatusResult> {
    let project: ProjectContext | null = null;
    let projectError: string | null = null;
    try {
      project = await resolveBoundProject(this.store, dir, currentPlatform(), this.device.workspaceId);
      if (project === null) {
        projectError =
          "This checkout is not registered with IWOMC yet. Run `iwomc init` here to bind it to a project.";
      }
    } catch (error) {
      projectError =
        error instanceof NotAGitRepositoryError
          ? "IWOMC works inside a Git checkout. Open a repository and run `iwomc init`."
          : (error as Error).message;
    }

    const support = project
      ? await this.registry.supportLevelFor(project.files)
      : { support: "observe_only" as SupportLevel, reason: "No project is bound here.", recognized: [] };

    const proof = project ? this.store.getProof(project.binding.projectId) : null;
    const contracts = project ? this.store.listContracts(project.binding.projectId) : [];
    // The same choice `rescue` makes, so the two can never disagree about which
    // contract applies here. `find` would have taken whichever was stored
    // first, which on a team is arbitrary.
    const forThisRevision = project
      ? contracts.filter((entry) => entry.commit === project.git.commit)
      : [];
    const choice = chooseContract(forThisRevision, currentPlatform());
    const exact = choice.chosen;
    const nearest = project && !exact ? (contracts[0] ?? null) : null;

    const memoryStatus = this.#memory
      ? await this.#memory.status()
      : { status: "not_configured" as IntegrationStatus, detail: "Memory integration is not configured.", endpoint: null };

    const runs = project ? this.store.listRuns(project.binding.projectId, 10) : [];
    const drift = project ? this.store.listDrift(project.binding.projectId, project.git.commit) : [];

    return {
      mode: this.device.workspaceId ? "team" : "local_only",
      device: {
        id: this.device.id,
        displayName: this.device.displayName,
        state: this.device.state,
        identity: this.device.personId,
        localOnly: isLocalOnlyIdentity(this.device.personId),
        platform: `${this.device.platform.os}/${this.device.platform.arch}`,
      },
      project: project ? summarizeProject(project) : null,
      projectError,
      support: {
        level: support.support,
        reason: support.reason,
        recognized: support.recognized.map((entry) => ({
          manager: entry.probe.manager,
          support: entry.probe.support,
          note: entry.probe.note,
          signals: [...entry.signals],
        })),
      },
      proof: {
        configured: proof !== null,
        command: proof ? proof.argv.join(" ") : null,
        description: proof?.description ?? null,
      },
      contracts: contracts.map(summarizeContract),
      exactContract: exact ? summarizeContract(exact) : null,
      nearestContract: nearest ? summarizeContract(nearest) : null,
      canRescueNow: rescueReadiness(project, exact, proof, choice),
      // Two teammates who captured the same revision and got different answers
      // is the earliest signal a team gets that its machines have drifted
      // apart - and it shows up before anything breaks.
      agreement: agreementFor(forThisRevision, currentPlatform()),
      recentRuns: runs.map((run) => ({
        id: run.id,
        state: run.state,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        commit: run.commit,
      })),
      integrations: await this.integrationReports(),
      memory: { status: memoryStatus.status, detail: memoryStatus.detail },
      driftCount: drift.length,
      home: this.store.path,
    };
  }

  /**
   * One answer about every integration, shared by `status`, `doctor`, and the
   * console. Static configuration validation can only say "configured"; where a
   * live probe ran, its result replaces that, so two surfaces can never report
   * different states for the same thing.
   */
  async integrationReports(): Promise<IntegrationReport[]> {
    const verifiers = await this.verifierAvailability();
    const memory = this.#memory
      ? await this.#memory.status()
      : { status: "not_configured" as IntegrationStatus, detail: "Memory integration is not configured.", endpoint: null };

    return validateIntegrationConfig(this.config, this.#env).map((report) => {
      const verifier = verifiers.find((candidate) => candidate.id === report.id);
      if (verifier) {
        return {
          ...report,
          status: verifier.available ? ("connected" as IntegrationStatus) : report.status,
          detail: verifier.detail,
        };
      }
      if (report.id === "claude_mem") {
        return { ...report, status: memory.status, detail: memory.detail };
      }
      return report;
    });
  }

  /** Every verifier this build has, with its live availability. */
  async verifierAvailability(
    dir?: string,
  ): Promise<{ id: string; label: string; available: boolean; detail: string; remainingBudgetUsd?: number }[]> {
    const all: VerifierPort[] = [...this.#verifiers];
    if (!all.some((verifier) => verifier.id === "local_fresh_directory")) {
      all.push(
        new LocalFreshDirectoryVerifier({
          registry: this.registry,
          repositoryRoot: dir ?? process.cwd(),
          now: this.#now,
        }),
      );
    }
    const out: { id: string; label: string; available: boolean; detail: string; remainingBudgetUsd?: number }[] = [];
    for (const verifier of all) {
      const availability = await verifier.availability();
      out.push({
        id: verifier.id,
        label: verifier.label,
        available: availability.available,
        detail: availability.detail,
        ...(availability.remainingBudgetUsd !== undefined
          ? { remainingBudgetUsd: availability.remainingBudgetUsd }
          : {}),
      });
    }
    return out;
  }

  // -- init ---------------------------------------------------------------

  async init(
    dir: string,
    options: { projectName?: string; proofCommand?: string; proofTimeoutMs?: number; envAllowlist?: readonly string[] } = {},
  ): Promise<{ binding: ProjectBinding; proof: ProofCommand | null; support: { level: SupportLevel; reason: string } }> {
    const project = await bindProject(this.store, dir, currentPlatform(), {
      workspaceId: this.device.workspaceId,
      ...(options.projectName ? { projectName: options.projectName } : {}),
      now: this.#now,
    });

    let proof = this.store.getProof(project.binding.projectId);
    if (options.proofCommand) {
      proof = draftProofCommand({
        commandLine: options.proofCommand,
        ...(options.proofTimeoutMs ? { timeoutMs: options.proofTimeoutMs } : {}),
        ...(options.envAllowlist ? { envAllowlist: options.envAllowlist } : {}),
        approvedBy: this.device.personId,
        approvedAt: this.#now(),
      });
      this.store.saveProof(project.binding.projectId, proof, this.#now());
    }

    const support = await this.registry.supportLevelFor(project.files);
    this.store.appendAudit({
      id: randomUUID(),
      workspaceId: project.binding.workspaceId,
      at: this.#now(),
      actor: this.device.personId,
      action: "project.bound",
      subject: `project:${project.binding.projectId}`,
      detail: {
        canonicalRemoteDigest: project.binding.canonicalRemoteDigest,
        subdirectory: project.binding.subdirectory,
        support: support.support,
      },
    });

    return { binding: project.binding, proof, support: { level: support.support, reason: support.reason } };
  }

  async setProofCommand(
    dir: string,
    commandLine: string,
    options: { timeoutMs?: number; envAllowlist?: readonly string[]; description?: string } = {},
  ): Promise<ProofCommand> {
    const project = await this.#requireProject(dir);
    const proof = draftProofCommand({
      commandLine,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.envAllowlist ? { envAllowlist: options.envAllowlist } : {}),
      ...(options.description ? { description: options.description } : {}),
      approvedBy: this.device.personId,
      approvedAt: this.#now(),
    });
    this.store.saveProof(project.binding.projectId, proof, this.#now());
    return proof;
  }

  // -- capture ------------------------------------------------------------

  async capture(
    dir: string,
    options: {
      proofCommand?: string;
      agentSession?: { provider: string; sessionRef: string };
      allowSourceUpload?: boolean;
    } = {},
  ): Promise<CaptureResult & { project: ProjectSummary }> {
    const project = await this.#requireProject(dir);

    let proof = this.store.getProof(project.binding.projectId);
    if (options.proofCommand) {
      proof = draftProofCommand({
        commandLine: options.proofCommand,
        approvedBy: this.device.personId,
        approvedAt: this.#now(),
      });
      this.store.saveProof(project.binding.projectId, proof, this.#now());
    }

    // Bring the log up to date first, so a capture always leaves behind a
    // record of what this revision looked like. Without it, someone who runs
    // `iwomc capture` and then asks `iwomc timeline <that commit>` is told the
    // revision was never observed - moments after IWOMC observed it.
    //
    // This respects the recorder lease: when a resident `iwomc watch` already
    // holds the project, it is already current and this does nothing.
    await this.#recordCurrentState(project.projectDir).catch(() => undefined);

    // What the log recorded while this exact revision was checked out. A
    // capture that only reads the present cannot tell an install from a
    // transitive dependency, and cannot see a downgrade at all.
    const recordedChanges = this.store.listPackageEventsForCommit(
      project.binding.projectId,
      project.git.commit,
    );

    const result = await captureEnvironment({
      project,
      device: this.device,
      registry: this.registry,
      proof,
      ...(recordedChanges.length > 0 ? { recordedChanges } : {}),
      ...(options.agentSession ? { agentSession: options.agentSession } : {}),
      ...(options.allowSourceUpload ? { policyOverrides: { allowSourceUpload: true } } : {}),
      now: this.#now,
    });

    this.store.saveReceipt(result.receipt);
    if (result.contract) this.store.saveContract(result.contract, "local");
    if (result.drift.length > 0) this.store.saveDrift(result.drift);

    this.store.appendAudit({
      id: randomUUID(),
      workspaceId: project.binding.workspaceId,
      at: this.#now(),
      actor: this.device.personId,
      action: "capture.created",
      subject: `receipt:${result.receipt.id}`,
      detail: {
        commit: project.git.commit,
        support: result.support,
        contractDigest: result.contract?.digest ?? null,
        driftCount: result.drift.length,
      },
    });

    await this.#memory?.record({
      event: "capture",
      outcome: result.contract ? "contract_created" : "evidence_only",
      projectPseudonym: projectPseudonym(project.binding.projectId),
      revision: project.git.commit,
      facts: {
        support: result.support,
        drift_count: result.drift.length,
        coverage_gap_count: result.coverage.length,
        worktree_dirty: project.git.worktreeDirty,
        secret_values_present: false,
      },
      references: {
        receipt_id: result.receipt.id,
        ...(result.contract ? { contract_digest: result.contract.digest } : {}),
      },
      at: this.#now(),
    }, result.redactor);

    if (result.drift.length > 0) {
      await this.#memory?.record({
        event: "drift",
        outcome: "drift_detected",
        projectPseudonym: projectPseudonym(project.binding.projectId),
        revision: project.git.commit,
        facts: {
          finding_count: result.drift.length,
          kinds: [...new Set(result.drift.map((finding) => finding.kind))].join(","),
          secret_values_present: false,
        },
        references: { receipt_id: result.receipt.id },
        at: this.#now(),
      }, result.redactor);
    }

    return { ...result, project: summarizeProject(project) };
  }

  // -- verify -------------------------------------------------------------

  async verify(
    dir: string,
    options: { contractId?: string; verifier?: "modal" | "local_fresh_directory"; onEvent?: (event: { at: string; phase: string; message: string }) => void } = {},
  ): Promise<{
    attestation: VerificationAttestationV1 | null;
    contract: EnvironmentContractV1 | null;
    blocker: Blocker | null;
    verifierId: string | null;
    verifierDetail: string;
  }> {
    const project = await this.#requireProject(dir);
    const stored = options.contractId
      ? this.store.getContract(options.contractId)
      : this.store.findContractsForCommit(project.binding.projectId, project.git.commit)[0] ?? null;

    if (!stored) {
      return {
        attestation: null,
        contract: null,
        verifierId: null,
        verifierDetail: "",
        blocker: blocker(
          "no_contract_for_revision",
          `No contract exists for ${project.git.commit.slice(0, 12)}.`,
          "Run `iwomc capture` on a working checkout at this revision first.",
        ),
      };
    }

    const verifiers = this.#resolveVerifiers(project);
    const requested = options.verifier
      ? verifiers.filter((verifier) => verifier.id === options.verifier)
      : verifiers;

    const skipped: string[] = [];
    for (const verifier of requested) {
      const availability = await verifier.availability();
      if (!availability.available) {
        skipped.push(`${verifier.label}: ${availability.detail}`);
        options.onEvent?.({
          at: this.#now(),
          phase: "verifier_unavailable",
          message: `${verifier.label} is unavailable: ${availability.detail}`,
        });
        continue;
      }
      const applicability = await verifier.applicability(stored.contract);
      if (!applicability.applicable) {
        // Available but not usable for this contract. That is a skip with a
        // reason, never a failed verification (R8.4).
        skipped.push(`${verifier.label}: ${applicability.reason}`);
        options.onEvent?.({
          at: this.#now(),
          phase: "verifier_skipped",
          message: `${verifier.label} was skipped: ${applicability.reason}`,
        });
        continue;
      }
      const output = await verifier.verify({
        contract: stored.contract,
        proof: stored.contract.proof,
        sourceDir: project.projectDir,
        platform: project.platform,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      });
      this.store.saveAttestation(output.attestation, output.log);

      let updated = stored.contract;
      if (output.attestation.state === "passed") {
        const target: ContractState =
          output.attestation.assurance === "clean_verified" ? "clean_verified" : "locally_checked";
        updated = this.#advanceContract(stored.contract, target);
        this.store.saveContract(updated, stored.origin);
      }

      this.store.appendAudit({
        id: randomUUID(),
        workspaceId: project.binding.workspaceId,
        at: this.#now(),
        actor: this.device.personId,
        action: "verification.completed",
        subject: `contract:${stored.contract.id}`,
        detail: {
          verifier: verifier.id,
          state: output.attestation.state,
          assurance: output.attestation.assurance,
          cleanup: output.attestation.cleanup,
        },
      });

      await this.#memory?.record({
        event: "verification",
        outcome: output.attestation.state,
        projectPseudonym: projectPseudonym(project.binding.projectId),
        revision: stored.contract.source.commit,
        facts: {
          verifier: verifier.id,
          assurance: output.attestation.assurance,
          proof_exit_code: output.attestation.proofExitCode ?? -1,
          cleanup: output.attestation.cleanup,
          secret_values_present: false,
        },
        references: { contract_digest: stored.contract.digest, attestation_id: output.attestation.id },
        at: this.#now(),
      }, await buildProjectRedactor(project.projectDir));

      return {
        attestation: output.attestation,
        contract: updated,
        blocker:
          output.attestation.state === "passed"
            ? null
            : blocker(
                verifier.id === "modal" ? "integration_unavailable" : "proof_failed",
                output.attestation.failureReason ?? `${verifier.label} did not pass.`,
                "Read the verification log, fix the reported problem, and verify again.",
              ),
        verifierId: verifier.id,
        verifierDetail: [availability.detail, ...skipped].join(" "),
      };
    }

    return {
      attestation: null,
      contract: stored.contract,
      verifierId: null,
      verifierDetail: skipped.join(" "),
      blocker: blocker(
        "integration_unavailable",
        `No verifier could run this contract. ${skipped.join(" ")}`,
        "Configure Modal for clean verification, or make sure Git is on PATH so the local fresh-directory verifier can run.",
        { skipped },
      ),
    };
  }

  // -- rescue -------------------------------------------------------------

  async rescue(
    dir: string,
    options: {
      contractId?: string;
      approve?: boolean;
      onEvent?: (event: RescueEvent) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<RescueResult | { state: "blocked"; blocker: Blocker; runId: null }> {
    const project = await this.#requireProject(dir);
    const proof = this.store.getProof(project.binding.projectId);

    let stored: StoredContract | null;
    let choice: ContractChoice<StoredContract> | null = null;
    if (options.contractId) {
      stored = this.store.getContract(options.contractId);
    } else {
      // Several teammates may have captured this revision, from different
      // machines and to different levels of checking. Pick the one that can
      // actually run here and has the most evidence behind it, not whichever
      // happened to be stored last.
      choice = chooseContract(
        this.store.findContractsForCommit(project.binding.projectId, project.git.commit),
        currentPlatform(),
      );
      stored = choice.chosen;
    }

    if (!stored && choice && choice.otherPlatforms.length > 0) {
      // The revision *is* covered - just not for this machine. Saying "no
      // contract exists" would send someone to ask for a capture that has
      // already happened.
      const platforms = coveredPlatforms(choice.otherPlatforms);
      const here = currentPlatform();
      return {
        state: "blocked",
        runId: null,
        blocker: blocker(
          "platform_mismatch",
          `${choice.otherPlatforms.length === 1 ? "A contract exists" : `${choice.otherPlatforms.length} contracts exist`} for ${project.git.commit.slice(0, 12)}, but ${
            choice.otherPlatforms.length === 1 ? "it targets" : "they target"
          } ${platforms.join(", ")} and this machine is ${here.os}/${here.arch}.`,
          `Ask a teammate on ${here.os}/${here.arch} to run \`iwomc capture\` at this revision, then try again.`,
          { coveredPlatforms: platforms, thisPlatform: `${here.os}/${here.arch}` },
        ),
      };
    }

    if (!stored && choice && choice.withdrawn.length > 0) {
      // Every contract for this revision was rejected, revoked, or replaced.
      // That is a decision someone made, not an absence.
      const states = [...new Set(choice.withdrawn.map((entry) => entry.state))].sort();
      return {
        state: "blocked",
        runId: null,
        blocker: blocker(
          "contract_not_approved",
          `Every contract for ${project.git.commit.slice(0, 12)} has been ${states.join(" or ")}.`,
          "Ask a teammate whose checkout works to capture a new one at this revision.",
          { withdrawnStates: states },
        ),
      };
    }

    if (!stored) {
      const contracts = this.store.listContracts(project.binding.projectId, 5);
      const nearest = contracts[0];

      // A contract for this exact commit under a different project means the
      // two checkouts do not share a Git remote. Telling someone to "ask a
      // teammate to capture" when the capture already happened sends them
      // after the wrong problem entirely.
      const elsewhere = this.store
        .findContractsForCommitAnywhere(project.git.commit)
        .find((entry) => entry.projectId !== project.binding.projectId);

      if (elsewhere) {
        return {
          state: "blocked",
          runId: null,
          blocker: blocker(
            "remote_mismatch",
            `A contract exists for ${project.git.commit.slice(0, 12)}, but it was captured against a different Git remote, so IWOMC treats it as a different project.`,
            project.git.remoteUrl === null
              ? "This checkout has no Git remote configured. Add the shared remote with `git remote add origin <url>` so both checkouts fingerprint the same project."
              : `Check that both checkouts use the same remote, then run \`iwomc status\`. To apply it anyway, run \`iwomc rescue --contract ${elsewhere.id}\`.`,
            { otherContractId: elsewhere.id, remoteConfigured: project.git.remoteUrl !== null },
          ),
        };
      }

      return {
        state: "blocked",
        runId: null,
        blocker: blocker(
          "no_contract_for_revision",
          `No contract exists for ${project.git.commit.slice(0, 12)}.`,
          nearest
            ? `A contract exists for ${nearest.commit.slice(0, 12)}. Apply it deliberately with \`iwomc rescue --contract ${nearest.id}\`, or ask a teammate to capture one at this revision.`
            : "Ask a teammate whose checkout works to run `iwomc capture` at this revision.",
          nearest ? { nearestContractId: nearest.id, nearestCommit: nearest.commit } : undefined,
        ),
      };
    }

    if (proof === null && !stored.contract.proof) {
      return {
        state: "blocked",
        runId: null,
        blocker: blocker(
          "proof_not_configured",
          "No proof command is configured, so rescue cannot prove the project works.",
          "Run `iwomc init --proof \"<command>\"` to set the command that decides whether this project works.",
        ),
      };
    }

    return await runRescue({
      project,
      device: this.device,
      registry: this.registry,
      store: this.store,
      contract: stored.contract,
      contractOrigin: stored.origin,
      ...(this.#memory ? { memory: this.#memory } : {}),
      approved: options.approve ?? false,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      now: this.#now,
    });
  }

  // -- promote ------------------------------------------------------------

  async promote(dir: string, options: { apply?: boolean } = {}): Promise<
    PromotionProposal & { applied: readonly string[] }
  > {
    const project = await this.#requireProject(dir);
    const findings = this.store.listDrift(project.binding.projectId, project.git.commit);
    const proposal = await proposePromotion({ project, registry: this.registry, findings });
    if (!options.apply || proposal.repair === null) {
      return { ...proposal, applied: [] };
    }
    const result = await applyPromotion({ project, repair: proposal.repair });
    if (result.blocker === null) {
      this.store.appendAudit({
        id: randomUUID(),
        workspaceId: project.binding.workspaceId,
        at: this.#now(),
        actor: this.device.personId,
        action: "promotion.applied",
        subject: `repair:${proposal.repair.id}`,
        detail: { files: result.applied, commit: project.git.commit },
      });
      await this.#memory?.record({
        event: "promotion",
        outcome: "applied",
        projectPseudonym: projectPseudonym(project.binding.projectId),
        revision: project.git.commit,
        facts: {
          file_count: result.applied.length,
          finding_count: proposal.findings.length,
          secret_values_present: false,
        },
        references: { repair_id: proposal.repair.id },
        at: this.#now(),
      }, await buildProjectRedactor(project.projectDir));
    }
    return { ...proposal, blocker: result.blocker ?? proposal.blocker, applied: result.applied };
  }

  // -- doctor -------------------------------------------------------------

  async doctor(dir?: string): Promise<{
    checks: { name: string; status: "ok" | "warn" | "fail"; detail: string; nextAction?: string }[];
    integrations: readonly IntegrationReport[];
    verifiers: { id: string; label: string; available: boolean; detail: string; remainingBudgetUsd?: number }[];
    memory: { status: IntegrationStatus; detail: string };
    auditChain: { ok: boolean; brokenAt?: string };
  }> {
    const checks: { name: string; status: "ok" | "warn" | "fail"; detail: string; nextAction?: string }[] = [];

    const git = await probe(["git", "--version"], { timeoutMs: 15_000 });
    checks.push({
      name: "Git available",
      status: git.ok ? "ok" : "fail",
      detail: git.ok ? git.stdout.trim() : "git was not found on PATH.",
      ...(git.ok ? {} : { nextAction: "Install Git and make it available on PATH." }),
    });

    checks.push({
      name: "Local store",
      status: "ok",
      detail: `Encrypted at ${this.store.path}. The device private key stays in this directory.`,
    });

    checks.push({
      name: "Device identity",
      status: this.device.state === "revoked" ? "fail" : "ok",
      detail: `${this.device.displayName} (${this.device.state}), identity ${this.device.personId}${
        isLocalOnlyIdentity(this.device.personId) ? " - local device identity; workspace sharing is available on a reachable control plane" : ""
      }.`,
      ...(isLocalOnlyIdentity(this.device.personId)
        ? { nextAction: "Run `iwomc serve` to create a local workspace, or `iwomc join <invitation>` to pair with one." }
        : {}),
    });

    const bindings = this.store.listBindings();
    checks.push({
      name: "Project bindings",
      status: bindings.length > 0 ? "ok" : "warn",
      detail:
        bindings.length > 0
          ? `${plural(bindings.length, "checkout")} registered on this device.`
          : "No checkouts are registered yet.",
      ...(bindings.length === 0 ? { nextAction: "Run `iwomc init` inside a Git checkout." } : {}),
    });

    // The package log grows for as long as a recorder runs. Its size should
    // never be a surprise found by someone hunting for disk space.
    const footprint = bindings.reduce(
      (total, binding) => {
        const one = this.store.packageLogFootprint(binding.projectId);
        return {
          events: total.events + one.events,
          baselines: total.baselines + one.baselines,
          approximateBytes: total.approximateBytes + one.approximateBytes,
        };
      },
      { events: 0, baselines: 0, approximateBytes: 0 },
    );
    const logMegabytes = footprint.approximateBytes / (1024 * 1024);
    checks.push({
      name: "Package log",
      // Large is not wrong - it means a lot has been recorded - so this warns
      // rather than failing, and says what to do about it.
      status: logMegabytes > 200 ? "warn" : "ok",
      detail:
        footprint.events === 0
          ? "No package changes recorded yet. Run `iwomc watch` to start recording."
          : `${plural(footprint.events, "change")} and ${plural(
              footprint.baselines,
              "snapshot",
            )} recorded, ${logMegabytes < 1 ? "under 1 MB" : `about ${logMegabytes.toFixed(0)} MB`} on disk.`,
      ...(logMegabytes > 200
        ? {
            nextAction:
              "This is a lot of history. Older snapshots are thinned automatically; if you need the space back, remove the project binding and re-add it.",
          }
        : {}),
    });

    if (dir) {
      try {
        const project = await resolveBoundProject(this.store, dir, currentPlatform(), this.device.workspaceId);
        if (project) {
          const support = await this.registry.supportLevelFor(project.files);
          checks.push({
            name: "Ecosystem support here",
            status: support.support === "native" ? "ok" : support.support === "recipe" ? "warn" : "warn",
            detail: `${support.support}: ${support.reason}`,
          });
        }
      } catch {
        // A non-repository directory is already reported by `status`.
      }
    }

    const audit = this.store.verifyAuditChain();
    checks.push({
      name: "Audit chain",
      status: audit.ok ? "ok" : "fail",
      detail: audit.ok
        ? "Every local audit event hashes to its recorded digest."
        : `The audit chain breaks at ${audit.brokenAt}.`,
      ...(audit.ok ? {} : { nextAction: "Report this: the local audit log has been modified." }),
    });

    const memory = this.#memory
      ? await this.#memory.status()
      : { status: "not_configured" as IntegrationStatus, detail: "Memory integration is not configured.", endpoint: null };

    const verifierReports = await this.verifierAvailability(dir);

    return {
      checks,
      integrations: await this.integrationReports(),
      verifiers: verifierReports,
      memory: { status: memory.status, detail: memory.detail },
      auditChain: audit,
    };
  }

  // -- the package log ----------------------------------------------------

  /**
   * Start watching a bound checkout in the background.
   *
   * The caller owns the returned watcher and must stop it; the watch session
   * is only closed on `stop`, and an unclosed session is what later folds read
   * as "the watcher may still have been running", so leaking one degrades the
   * honesty of coverage reporting rather than crashing anything.
   */
  async watch(dir: string, options: WatchOptions = {}): Promise<{ watcher: PackageWatcher; project: ProjectSummary }> {
    const project = await this.#requireProject(dir);
    const watcher = new PackageWatcher({
      store: this.store,
      projectId: project.binding.projectId,
      projectDir: project.projectDir,
      registry: this.registry,
      options: { now: this.#now, ...options },
    });
    await watcher.start();
    this.store.appendAudit({
      id: randomUUID(),
      workspaceId: project.binding.workspaceId,
      at: this.#now(),
      actor: this.device.personId,
      action: "watch.started",
      subject: project.binding.projectId,
      detail: { commit: project.git.commit },
    });
    return { watcher, project: summarizeProject(project) };
  }

  /**
   * Watch every checkout registered on this device.
   *
   * A developer usually has more than one project open, and a recorder that
   * only covers the directory it was started in silently leaves the others
   * with no history at all. Bindings whose checkout has since been deleted or
   * moved are reported rather than skipped in silence.
   */
  async watchAll(options: WatchOptions = {}): Promise<{
    watchers: { projectName: string; projectId: string; watcher: PackageWatcher }[];
    unavailable: { projectName: string; checkoutPath: string; reason: string }[];
  }> {
    const watchers: { projectName: string; projectId: string; watcher: PackageWatcher }[] = [];
    const unavailable: { projectName: string; checkoutPath: string; reason: string }[] = [];

    for (const binding of this.store.listBindings()) {
      try {
        const started = await this.watch(binding.checkoutPath, options);
        watchers.push({
          projectName: binding.projectName,
          projectId: binding.projectId,
          watcher: started.watcher,
        });
      } catch (error) {
        // A project someone else is already recording is not a problem to
        // report as breakage; it is one this process simply skips.
        unavailable.push({
          projectName: binding.projectName,
          checkoutPath: binding.checkoutPath,
          reason:
            error instanceof RecorderBusyError
              ? "Already being recorded by another IWOMC process."
              : error instanceof Error
                ? error.message
                : String(error),
        });
      }
    }
    return { watchers, unavailable };
  }

  /**
   * One observation now, without staying resident.
   *
   * When a resident recorder already holds this project, this reads instead of
   * writing and says so. Recording the same change from two processes would
   * put it in the history twice, at two slightly different moments.
   */
  async sweepOnce(dir: string): Promise<{
    result: SweepResult;
    project: ProjectSummary;
    recorded: boolean;
    heldBy?: { startedAt: string; lastSeenAt: string };
  }> {
    const project = await this.#requireProject(dir);
    const watcher = new PackageWatcher({
      store: this.store,
      projectId: project.binding.projectId,
      projectDir: project.projectDir,
      registry: this.registry,
      options: { now: this.#now },
    });

    try {
      // A one-shot sweep still opens and closes a watch session, so the covered
      // interval it produces is a true statement about when IWOMC was looking.
      //
      // The result is the one `start` returns. That first sweep is the one that
      // compares the stored state against the disk; a second sweep would compare
      // the disk against itself and report nothing.
      const result = await watcher.start();
      await watcher.stop("one-shot sweep");
      return { result, project: summarizeProject(project), recorded: true };
    } catch (error) {
      if (!(error instanceof RecorderBusyError)) throw error;
      const result = await watcher.observe();
      return {
        result,
        project: summarizeProject(project),
        recorded: false,
        ...(error.heldBy ? { heldBy: error.heldBy } : {}),
      };
    }
  }

  /**
   * What was installed at a moment, and - separately - what the agent was
   * doing then.
   *
   * The two halves never mix. `state` is replayed from IWOMC's own log and is
   * the same on every machine that holds the log. `memory` is narration and is
   * absent whenever the Claude-Mem worker is not running, which changes how
   * much the answer explains but never what the answer is.
   */
  async timeline(
    dir: string,
    query: { at?: string; commit?: string; explain?: boolean } = {},
  ): Promise<TimelineResult> {
    const project = await this.#requireProject(dir);
    const projectId = project.binding.projectId;
    const anchorCommit = query.commit
      ? await this.#resolveCommitReference(project.projectDir, query.commit)
      : null;
    const requestedAt = query.at === undefined ? undefined : normalizeInstant(query.at, "--at");

    const state = anchorCommit
      ? stateAtCommit(this.store, projectId, anchorCommit)
      : stateAt(this.store, projectId, requestedAt ?? this.#now());

    const anchorAt = isCommitNotObserved(state) ? (requestedAt ?? this.#now()) : state.at;
    const seq = anchorCommit
      ? (this.store.seqAtCommit(projectId, anchorCommit) ?? this.store.seqAtTime(projectId, anchorAt))
      : this.store.seqAtTime(projectId, anchorAt);
    const recentEvents = this.store.listPackageEvents(projectId, {
      fromSeq: Math.max(0, seq - 24),
      toSeq: seq,
      limit: 25,
    });

    let memory: TimelineResult["memory"] = null;
    if (query.explain !== false && this.#memory) {
      const result = await this.#memory.timeline({
        anchor: anchorAt,
        depthBefore: 5,
        depthAfter: 5,
        projectPseudonym: projectPseudonym(projectId),
      });
      memory = { status: result.status, entries: result.entries };
    }

    return {
      project: summarizeProject(project),
      anchor: { at: anchorAt, commit: anchorCommit },
      state,
      recentEvents,
      totalEvents: this.store.countPackageEvents(projectId),
      memory,
    };
  }

  /** What would have to change to turn one point in time into another. */
  async timelineDiff(
    dir: string,
    from: { at?: string; commit?: string },
    to: { at?: string; commit?: string },
  ): Promise<TimelineDiffResult> {
    const project = await this.#requireProject(dir);
    const projectId = project.binding.projectId;

    if (from.commit && to.commit) {
      const left = await this.#resolveCommitReference(project.projectDir, from.commit);
      const right = await this.#resolveCommitReference(project.projectDir, to.commit);
      const result = diffCommits(this.store, projectId, left, right);
      return {
        project: summarizeProject(project),
        from: { at: null, commit: left },
        to: { at: null, commit: right },
        diff: result.diff,
        missing: result.missing,
      };
    }

    const fromAt = from.at === undefined ? new Date(0).toISOString() : normalizeInstant(from.at, "--since");
    const toAt = to.at === undefined ? this.#now() : normalizeInstant(to.at, "--until");
    return {
      project: summarizeProject(project),
      from: { at: fromAt, commit: null },
      to: { at: toAt, commit: null },
      diff: diffAt(this.store, projectId, fromAt, toAt),
      missing: [],
    };
  }

  /**
   * Take one observation, unless a resident recorder is already doing it.
   *
   * Failures here are deliberately not fatal to the caller: capture's job is
   * to produce a contract, and a package log that could not be updated is a
   * reduced answer, not a broken one.
   */
  async #recordCurrentState(projectDir: string): Promise<void> {
    await this.sweepOnce(projectDir);
  }

  /**
   * Turn what a person typed into a full commit sha.
   *
   * `git log --oneline` prints short hashes, so that is what people paste. A
   * branch name or `HEAD~1` is just as reasonable. When Git in this checkout
   * cannot resolve it, the original text is returned unchanged so the answer
   * is "this revision was never observed here" naming what they asked for,
   * rather than an error about formatting.
   */
  async #resolveCommitReference(projectDir: string, reference: string): Promise<string> {
    const trimmed = reference.trim();
    if (/^[0-9a-f]{40}$/u.test(trimmed)) return trimmed;
    return (await expandCommit(projectDir, trimmed)) ?? trimmed;
  }

  // -- reads --------------------------------------------------------------

  listBindings(): ProjectBinding[] {
    return this.store.listBindings();
  }

  listContracts(projectId: string): StoredContract[] {
    return this.store.listContracts(projectId);
  }

  listRuns(projectId: string): StoredRun[] {
    return this.store.listRuns(projectId);
  }

  listAllRuns(): StoredRun[] {
    return this.store.listAllRuns();
  }

  listDrift(projectId: string): DriftFinding[] {
    return this.store.listDrift(projectId);
  }

  listReceipts(projectId: string): EnvironmentReceiptV1[] {
    return this.store.listReceipts(projectId);
  }

  listAttestations(contractId: string): VerificationAttestationV1[] {
    return this.store.listAttestations(contractId);
  }

  readEvents(runId: string, afterSeq = -1): RescueEvent[] {
    return this.store.readEvents(runId, afterSeq);
  }

  approveContract(contractId: string, note?: string): EnvironmentContractV1 {
    const stored = this.store.getContract(contractId);
    if (!stored) {
      throw new BlockedError(
        blocker("no_contract_for_revision", `No contract ${contractId} is stored on this device.`, "Run `iwomc status` to list contracts."),
      );
    }
    const at = this.#now();
    const approved = parseContract({
      ...transitionContract(stored.contract, "approved"),
      approval: { approvedBy: this.device.personId, approvedAt: at, ...(note ? { note } : {}) },
    });
    const resealed = this.#advanceContract(stored.contract, "approved", {
      approvedBy: this.device.personId,
      approvedAt: at,
      ...(note ? { note } : {}),
    });
    void approved;
    this.store.saveContract(resealed, stored.origin);
    this.store.appendAudit({
      id: randomUUID(),
      workspaceId: stored.contract.workspaceId,
      at,
      actor: this.device.personId,
      action: "contract.approved",
      subject: `contract:${contractId}`,
      detail: { digest: resealed.digest },
    });
    return resealed;
  }

  // -- internals ----------------------------------------------------------

  #advanceContract(
    contract: EnvironmentContractV1,
    to: ContractState,
    approval?: { approvedBy: string; approvedAt: string; note?: string },
  ): EnvironmentContractV1 {
    // Verifying a contract that already holds this state is an ordinary thing
    // to do - re-running `iwomc verify` after a change, or a second person
    // checking the same contract. There is nothing to move, and the state
    // machine rightly refuses a transition to the state a contract is already
    // in, so the answer is to not ask it. Approval is still recorded, because
    // approving something already approved is a real act by a real person.
    if (contract.state === to && !approval) return contract;
    const moved = transitionContract(contract, to);
    const withApproval = approval ? { ...moved, approval } : moved;
    // The transition changed the content, so the contract is re-addressed and
    // re-signed by this device. A team baseline is re-signed by the service.
    const { digest: _previousDigest, signature: _previousSignature, ...content } = withApproval;
    void _previousDigest;
    void _previousSignature;
    const resealed = parseContract({ ...content, digest: digestOf(content) });
    return signContract(resealed, this.device.keyPair, "device", this.#now());
  }

  #resolveVerifiers(project: ProjectContext): VerifierPort[] {
    const configured = [...this.#verifiers];
    if (!configured.some((verifier) => verifier.id === "local_fresh_directory")) {
      configured.push(
        new LocalFreshDirectoryVerifier({
          registry: this.registry,
          repositoryRoot: project.git.repositoryRoot,
          now: this.#now,
        }),
      );
    }
    // Modal first when present: a clean verification outranks a local check.
    return configured.sort((a, b) => (a.id === "modal" ? -1 : b.id === "modal" ? 1 : 0));
  }

  async #requireProject(dir: string): Promise<ProjectContext> {
    const project = await resolveBoundProject(this.store, dir, currentPlatform(), this.device.workspaceId);
    if (project === null) {
      throw new BlockedError(
        blocker(
          "no_project_binding",
          "This checkout is not registered with IWOMC.",
          "Run `iwomc init` in this directory first.",
        ),
      );
    }
    return project;
  }
}

function summarizeProject(project: ProjectContext): ProjectSummary {
  return {
    projectId: project.binding.projectId,
    projectName: project.binding.projectName,
    workspaceId: project.binding.workspaceId,
    subdirectory: project.binding.subdirectory,
    commit: project.git.commit,
    branch: project.git.branch,
    remoteConfigured: project.git.canonicalRemote !== null,
    worktreeDirty: project.git.worktreeDirty,
    dirtyPathCount: project.git.dirtyPaths.length,
  };
}

function summarizeContract(stored: StoredContract): ContractSummary {
  return {
    id: stored.id,
    digest: stored.digest,
    state: stored.state,
    support: stored.contract.support,
    origin: stored.origin,
    commit: stored.commit,
    issuedAt: stored.contract.issuedAt,
    stepCount: stored.contract.steps.length,
    proofCommand: stored.contract.proof.argv.join(" "),
    assurance: assuranceForContractState(stored.state),
    signedBy: stored.contract.signature?.signer ?? null,
  };
}

/** The vocabulary is snake_case in code and plain words in prose. */
function humanState(state: ContractState): string {
  return state.replace(/_/gu, " ");
}

function rescueReadiness(
  project: ProjectContext | null,
  exact: StoredContract | null,
  proof: ProofCommand | null,
  choice?: ContractChoice<StoredContract>,
): { possible: boolean; reason: string } {
  if (!project) {
    return { possible: false, reason: "No IWOMC project is bound to this directory." };
  }
  if (!proof && !exact) {
    return {
      possible: false,
      reason: "No proof command is configured and no contract exists for this revision.",
    };
  }
  if (!exact && choice && choice.otherPlatforms.length > 0) {
    // Someone has covered this revision - on a different kind of machine.
    // Telling them to capture one would be telling them to repeat work.
    const here = currentPlatform();
    return {
      possible: false,
      reason: `This revision is covered for ${coveredPlatforms(choice.otherPlatforms).join(", ")}, but not for ${here.os}/${here.arch}. A teammate on ${here.os}/${here.arch} needs to capture it.`,
    };
  }
  if (!exact && choice && choice.withdrawn.length > 0) {
    const states = [...new Set(choice.withdrawn.map((entry) => entry.state))].sort();
    return {
      possible: false,
      reason: `Every contract for ${project.git.commit.slice(0, 12)} has been ${states.join(" or ")}. A new capture is needed.`,
    };
  }
  if (!exact) {
    return {
      possible: false,
      reason: `No contract exists for ${project.git.commit.slice(0, 12)}. Capture one on a working checkout, or choose a nearest contract explicitly.`,
    };
  }
  if (exact.contract.support === "observe_only") {
    return { possible: false, reason: "The contract for this revision is observe-only and cannot be applied." };
  }
  if (!exact.contract.signature) {
    return { possible: false, reason: "The contract for this revision is unsigned." };
  }
  // The same gate rescue itself uses, so status can never promise more than
  // rescue will do.
  const recipeReviewed = exact.contract.steps
    .filter((step) => step.kind === "run_reviewed_recipe")
    .every((step) => step.review.approvedCommandDigest === step.commandDigest);
  if (!isAutomaticallyRescuable(exact.state, exact.contract.support, recipeReviewed)) {
    if (exact.state === "candidate") {
      return {
        possible: false,
        reason: `A candidate contract exists for this revision but has not been checked yet. Run \`iwomc verify\` to check it in a fresh directory, or \`iwomc approve ${exact.id}\` to accept it as-is.`,
      };
    }
    if (exact.contract.support === "recipe" && !recipeReviewed) {
      return {
        possible: false,
        reason: "The contract for this revision contains a setup recipe that has not been reviewed.",
      };
    }
    return {
      possible: false,
      reason: `The contract for this revision is ${humanState(exact.state)}, which is not approved for automatic rescue.`,
    };
  }
  return {
    possible: true,
    reason: `A ${humanState(exact.state)} contract exists for this exact revision; rescue will apply it and run \`${exact.contract.proof.argv.join(" ")}\`.`,
  };
}

/**
 * Accept an instant, or refuse clearly.
 *
 * Left unchecked, an unparseable value flows into a string comparison against
 * ISO timestamps and quietly answers *something* - a confident, wrong-looking
 * report of an empty project. Someone typing `--at yesterday` deserves to be
 * told that is not a date, not shown a project with nothing installed.
 */
export function normalizeInstant(value: string, flag: string): string {
  const trimmed = value.trim();
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new BlockedError({
      code: "invalid_input",
      message: `${flag} needs a date and time, and "${value}" is not one.`,
      nextAction: `Pass something like ${flag} 2026-08-23T14:32:00Z, or omit it for the current state.`,
    });
  }
  return new Date(parsed).toISOString();
}

/** "1 change", "2 changes" - never "1 change(s)". */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

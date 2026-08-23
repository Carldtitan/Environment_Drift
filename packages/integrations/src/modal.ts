import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundLog,
  defaultRedactor,
  digestBytes,
  type EnvironmentContractV1,
  type PlatformTarget,
  type RuntimeFingerprint,
  type VerificationAttestationV1,
  type VerificationState,
} from "@iwomc/contracts";
import type { AdapterRegistry, MaterializationContext, ProjectFiles } from "@iwomc/adapters";
import type {
  VerificationOutput,
  VerificationRequest,
  VerifierApplicability,
  VerifierAvailability,
  VerifierPort,
} from "@iwomc/companion";
import { run } from "@iwomc/companion";
import type { BudgetLedger } from "./budget.js";

/**
 * Modal clean verification (R8).
 *
 * A disposable Sandbox is created from the contract's runtime requirements, the
 * exact approved source is copied in, the contract's typed steps run, the proof
 * command runs, and the Sandbox is terminated on every path. Modal is used
 * headlessly: there is no desktop, browser, or visual testing surface here.
 *
 * Bounds are enforced before anything is provisioned: CPU, memory, wall-clock
 * timeout, output size, retries, and the app-level USD budget.
 */

export interface ModalLimits {
  readonly cpuCores: number;
  readonly memoryMiB: number;
  readonly timeoutSeconds: number;
  readonly maxRetries: number;
  readonly maxLogBytes: number;
}

export const DEFAULT_MODAL_LIMITS: ModalLimits = {
  cpuCores: 2,
  memoryMiB: 2048,
  timeoutSeconds: 900,
  maxRetries: 1,
  maxLogBytes: 512 * 1024,
};

export interface ModalVerifierOptions {
  readonly budget: BudgetLedger;
  readonly registry: AdapterRegistry;
  readonly limits?: Partial<ModalLimits>;
  readonly appName?: string;
  readonly profile?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  /** Injected in tests. Production loads the official `modal` SDK. */
  readonly loadSdk?: () => Promise<ModalSdk>;
}

/** The narrow slice of the Modal SDK this adapter depends on. */
export interface ModalSdk {
  readonly ModalClient: new (params?: { profile?: string }) => ModalClientLike;
}

export interface ModalClientLike {
  readonly apps: { fromName(name: string, params?: { createIfMissing?: boolean }): Promise<unknown> };
  readonly images: { fromRegistry(tag: string): unknown };
  readonly sandboxes: {
    create(app: unknown, image: unknown, params?: Record<string, unknown>): Promise<ModalSandboxLike>;
  };
  close?(): void;
}

export interface ModalSandboxLike {
  readonly sandboxId: string;
  readonly filesystem: { copyFromLocal(localPath: string, remotePath: string): Promise<void> };
  exec(
    command: string[],
    params?: Record<string, unknown>,
  ): Promise<{
    stdout: { readText(): Promise<string> };
    stderr: { readText(): Promise<string> };
    wait(): Promise<number>;
  }>;
  terminate(): Promise<void>;
}

const REMOTE_ROOT = "/workspace";

export class ModalVerifier implements VerifierPort {
  readonly id = "modal" as const;
  readonly label = "Modal clean verifier";

  readonly #budget: BudgetLedger;
  readonly #registry: AdapterRegistry;
  readonly #limits: ModalLimits;
  readonly #appName: string;
  readonly #profile: string | null;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => string;
  readonly #loadSdk: () => Promise<ModalSdk>;

  constructor(options: ModalVerifierOptions) {
    this.#budget = options.budget;
    this.#registry = options.registry;
    this.#limits = { ...DEFAULT_MODAL_LIMITS, ...options.limits };
    this.#appName = options.appName ?? "iwomc-clean-verifier";
    this.#profile = options.profile ?? null;
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#loadSdk =
      options.loadSdk ??
      (async () => {
        // Loaded dynamically so IWOMC still runs when the SDK is not installed.
        const module = (await import("modal")) as unknown as ModalSdk;
        return module;
      });
  }

  get limits(): ModalLimits {
    return this.#limits;
  }

  async availability(): Promise<VerifierAvailability> {
    const worstCase = this.#worstCaseCost();
    const decision = this.#budget.authorize(worstCase);

    if (!this.#credentialsPresent()) {
      return {
        available: false,
        status: "not_configured",
        detail:
          "No Modal credentials were found. Run `modal token set --token-id <id> --token-secret <secret>`, or set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.",
        remainingBudgetUsd: decision.remainingUsd,
      };
    }

    let sdk: ModalSdk;
    try {
      sdk = await this.#loadSdk();
    } catch (error) {
      return {
        available: false,
        status: "misconfigured",
        detail: `The Modal SDK could not be loaded (${(error as Error).message}). Install the \`modal\` package to enable clean verification.`,
        remainingBudgetUsd: decision.remainingUsd,
      };
    }

    if (!decision.allowed) {
      return {
        available: false,
        status: "unavailable",
        detail: decision.reason,
        remainingBudgetUsd: decision.remainingUsd,
      };
    }

    // A live authentication check: presence of a token is never treated as
    // "connected". `apps.fromName` is a control-plane call, not a sandbox.
    try {
      const client = new sdk.ModalClient(this.#profile ? { profile: this.#profile } : undefined);
      await client.apps.fromName(this.#appName, { createIfMissing: true });
      client.close?.();
      return {
        available: true,
        status: "connected",
        detail: `Authenticated with Modal. ${decision.reason}`,
        remainingBudgetUsd: decision.remainingUsd,
      };
    } catch (error) {
      return {
        available: false,
        status: "misconfigured",
        detail: `Modal rejected these credentials: ${(error as Error).message}`,
        remainingBudgetUsd: decision.remainingUsd,
      };
    }
  }

  /**
   * Clean verification needs the exact source inside a remote sandbox. A
   * project that has not approved that, or a runtime combination with no
   * mapped base image, is skipped with a stated reason - it is not a failed
   * verification, and it must never be reported as one.
   */
  async applicability(contract: EnvironmentContractV1): Promise<VerifierApplicability> {
    if (!contract.policy.allowSourceUpload) {
      return {
        applicable: false,
        reason:
          "This project has not approved sending its source to a remote verifier. Capture with --allow-source-upload, or install the IWOMC GitHub App so Modal can fetch the exact revision itself.",
      };
    }
    const image = selectImage(contract.requirements.runtimes);
    if (image === null) {
      return {
        applicable: false,
        reason:
          "IWOMC has no clean-verification base image for this combination of runtime requirements, so it will not substitute a different runtime.",
      };
    }
    return { applicable: true, reason: `Would verify on ${image.tag} (${image.reason}).` };
  }

  async verify(request: VerificationRequest): Promise<VerificationOutput> {
    const startedAt = this.#now();
    const id = randomUUID();
    const log: string[] = [];
    const record = (phase: string, message: string): void => {
      const safe = defaultRedactor.redactText(message).value;
      log.push(`[${this.#now()}] ${phase}: ${safe}`);
      request.onEvent?.({ at: this.#now(), phase, message: safe });
    };

    let state: VerificationState = "queued";
    let failureReason: string | undefined;
    let cleanup: VerificationAttestationV1["cleanup"] = "not_required";
    const stepExitCodes: { stepId: string; exitCode: number }[] = [];
    let proofExitCode: number | null = null;
    let proofTimedOut = false;
    const runtimeFingerprint: RuntimeFingerprint[] = [];
    let cost: VerificationAttestationV1["cost"];

    const linuxPlatform: PlatformTarget = { os: "linux", arch: "x64" };

    // Policy gate before anything is provisioned or uploaded.
    if (!request.contract.policy.allowSourceUpload) {
      failureReason =
        "This project has not approved uploading source for clean verification. Capture with --allow-source-upload, or configure a GitHub App installation so Modal can fetch the exact revision directly.";
      record("blocked", failureReason);
      return this.#attestation({
        id,
        request,
        startedAt,
        state: "failed",
        stepExitCodes,
        proofExitCode,
        proofTimedOut,
        cleanup: "not_required",
        failureReason,
        runtimeFingerprint,
        log,
        platform: linuxPlatform,
      });
    }

    const worstCase = this.#worstCaseCost();
    const decision = this.#budget.authorize(worstCase);
    if (!decision.allowed) {
      failureReason = decision.reason;
      record("blocked", failureReason);
      return this.#attestation({
        id,
        request,
        startedAt,
        state: "failed",
        stepExitCodes,
        proofExitCode,
        proofTimedOut,
        cleanup: "not_required",
        failureReason,
        runtimeFingerprint,
        log,
        platform: linuxPlatform,
      });
    }

    const image = selectImage(request.contract.requirements.runtimes.map((entry) => entry));
    if (image === null) {
      failureReason =
        "IWOMC has no clean-verification base image for this combination of runtime requirements. Use local verification, or add an image mapping for this ecosystem.";
      record("blocked", failureReason);
      return this.#attestation({
        id,
        request,
        startedAt,
        state: "failed",
        stepExitCodes,
        proofExitCode,
        proofTimedOut,
        cleanup: "not_required",
        failureReason,
        runtimeFingerprint,
        log,
        platform: linuxPlatform,
      });
    }
    record("provisioning", `Base image: ${image.tag} (${image.reason})`);

    let bundleDir: string | null = null;
    let sandbox: ModalSandboxLike | null = null;
    let client: ModalClientLike | null = null;
    const provisionedAt = Date.now();

    try {
      // 1. Bounded, expiring source bundle of the exact revision.
      state = "preparing_source";
      bundleDir = await mkdtemp(join(tmpdir(), "iwomc-modal-src-"));
      const bundlePath = join(bundleDir, "source.tar");
      const archive = await run(
        ["git", "archive", "--format=tar", "-o", bundlePath, request.contract.source.commit],
        { cwd: request.sourceDir, timeoutMs: 180_000, envAllowlist: null },
      );
      if (archive.exitCode !== 0) {
        failureReason = `Could not build a source bundle for ${request.contract.source.commit.slice(0, 12)}: ${archive.stderr.slice(0, 300)}`;
        throw new Error(failureReason);
      }
      record("preparing_source", `Bundled the exact revision ${request.contract.source.commit.slice(0, 12)}.`);

      // 2. Disposable sandbox.
      state = "provisioning";
      const sdk = await this.#loadSdk();
      client = new sdk.ModalClient(this.#profile ? { profile: this.#profile } : undefined);
      const app = await client.apps.fromName(this.#appName, { createIfMissing: true });
      const modalImage = client.images.fromRegistry(image.tag);
      sandbox = await client.sandboxes.create(app, modalImage, {
        cpu: this.#limits.cpuCores,
        cpuLimit: this.#limits.cpuCores,
        memoryMiB: this.#limits.memoryMiB,
        memoryLimitMiB: this.#limits.memoryMiB,
        timeoutMs: this.#limits.timeoutSeconds * 1000,
        workdir: REMOTE_ROOT,
        // No inbound ports, no tunnels: clean verification is headless.
        command: ["sleep", String(this.#limits.timeoutSeconds)],
        env: { CI: "1", IWOMC_VERIFICATION: "1" },
        tags: { iwomc: "clean-verification", contract: request.contract.digest.slice(7, 23) },
      });
      record("provisioning", `Sandbox ${sandbox.sandboxId} created with ${this.#limits.cpuCores} CPU and ${this.#limits.memoryMiB} MiB.`);

      const exec = async (
        command: string[],
        options: { workdir?: string; timeoutMs?: number; env?: Record<string, string> } = {},
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
        const process = await (sandbox as ModalSandboxLike).exec(command, {
          workdir: options.workdir ?? REMOTE_ROOT,
          timeoutMs: options.timeoutMs ?? this.#limits.timeoutSeconds * 1000,
          ...(options.env ? { env: options.env } : {}),
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          process.stdout.readText(),
          process.stderr.readText(),
          process.wait(),
        ]);
        return {
          exitCode,
          stdout: boundLog(stdout, this.#limits.maxLogBytes).text,
          stderr: boundLog(stderr, this.#limits.maxLogBytes).text,
        };
      };

      // 3. Unpack the exact source.
      await exec(["mkdir", "-p", REMOTE_ROOT]);
      await sandbox.filesystem.copyFromLocal(bundlePath, `${REMOTE_ROOT}/source.tar`);
      const untar = await exec(["tar", "-xf", "source.tar"], { workdir: REMOTE_ROOT });
      if (untar.exitCode !== 0) {
        failureReason = `Could not unpack the source bundle: ${untar.stderr.slice(0, 300)}`;
        throw new Error(failureReason);
      }
      await exec(["rm", "-f", `${REMOTE_ROOT}/source.tar`]);
      record("preparing_source", "Source unpacked into the sandbox.");

      const projectRoot =
        request.contract.source.subdirectory === "."
          ? REMOTE_ROOT
          : `${REMOTE_ROOT}/${request.contract.source.subdirectory}`;

      // 4. Runtime fingerprint of the machine that will do the work.
      for (const runtime of request.contract.requirements.runtimes) {
        const result = await exec([runtime.runtime, "--version"], { workdir: projectRoot, timeoutMs: 60_000 });
        const match = /(\d+\.\d+(?:\.\d+)?)/u.exec(`${result.stdout} ${result.stderr}`);
        runtimeFingerprint.push({
          runtime: runtime.runtime,
          version: result.exitCode === 0 ? (match?.[1] ?? "unknown") : "unavailable",
          source: result.exitCode === 0 ? "observed" : "unavailable",
        });
      }

      // 5. Typed materialization steps, planned for a Linux target.
      state = "materializing";
      const context = this.#remoteContext(projectRoot, linuxPlatform);
      for (const step of request.contract.steps) {
        if (step.kind === "ensure_runtime" || step.kind === "ensure_system_tool") {
          const argv = step.kind === "ensure_runtime" ? step.probeArgv : step.probeArgv;
          const result = await exec([...argv], { workdir: projectRoot, timeoutMs: 60_000 });
          stepExitCodes.push({ stepId: step.id, exitCode: result.exitCode });
          record("materializing", `${step.description} -> exit ${result.exitCode}`);
          if (result.exitCode !== 0) {
            failureReason = `${step.description} is not satisfied in a clean environment (exit ${result.exitCode}).`;
            state = "failed";
            break;
          }
          continue;
        }
        const adapter = this.#registry.byId(step.adapterId);
        const plan = adapter?.planCommand(step, context) ?? null;
        if (plan === null) {
          failureReason = `No adapter in this build can execute step ${step.id} (${step.kind}).`;
          state = "failed";
          break;
        }
        const workdir = plan.workDir === "." ? projectRoot : `${projectRoot}/${plan.workDir}`;
        const result = await exec([...plan.argv], {
          workdir,
          timeoutMs: Math.min(plan.timeoutMs, this.#limits.timeoutSeconds * 1000),
          env: { ...plan.env },
        });
        stepExitCodes.push({ stepId: step.id, exitCode: result.exitCode });
        record("materializing", `${step.description} -> exit ${result.exitCode}`);
        if (result.stderr.trim().length > 0) record("step_output", result.stderr.slice(-2000));
        if (!plan.expectedExitCodes.includes(result.exitCode)) {
          failureReason = `${step.description} failed in a clean environment (exit ${result.exitCode}).`;
          state = "failed";
          break;
        }
      }

      // 6. Proof.
      if (state !== "failed") {
        state = "proving";
        const proofWorkdir =
          request.proof.workDir === "." ? projectRoot : `${projectRoot}/${request.proof.workDir}`;
        const proofResult = await exec([...request.proof.argv], {
          workdir: proofWorkdir,
          timeoutMs: Math.min(request.proof.timeoutMs, this.#limits.timeoutSeconds * 1000),
          env: {
            PATH: `${projectRoot}/node_modules/.bin:${projectRoot}/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
          },
        });
        proofExitCode = proofResult.exitCode;
        record("proving", `Proof command exited ${proofResult.exitCode}.`);
        if (proofResult.stdout.trim().length > 0) record("proof_output", proofResult.stdout.slice(-4000));
        if (proofResult.stderr.trim().length > 0) record("proof_output", proofResult.stderr.slice(-4000));
        state = request.proof.expectedExitCodes.includes(proofResult.exitCode) ? "passed" : "failed";
        if (state === "failed") {
          failureReason = `The proof command failed in a clean environment (exit ${proofResult.exitCode}).`;
        }
      }
    } catch (error) {
      state = "failed";
      failureReason = failureReason ?? (error as Error).message;
      record("failed", failureReason);
    } finally {
      const elapsedSeconds = Math.max(1, Math.ceil((Date.now() - provisionedAt) / 1000));
      const actual = this.#budget.estimate({
        cpuCores: this.#limits.cpuCores,
        memoryMiB: this.#limits.memoryMiB,
        seconds: elapsedSeconds,
      });
      if (sandbox !== null) {
        try {
          await sandbox.terminate();
          cleanup = "terminated";
          record("cleanup", `Sandbox ${sandbox.sandboxId} terminated.`);
        } catch (error) {
          cleanup = "cleanup_failed";
          record("cleanup", `Sandbox ${sandbox.sandboxId} could not be terminated: ${(error as Error).message}`);
        }
        this.#budget.record({
          amountUsd: actual,
          reference: `verification:${id}`,
          at: this.#now(),
        });
        cost = {
          currency: "USD",
          amount: actual,
          basis: `${this.#limits.cpuCores} CPU x ${this.#limits.memoryMiB} MiB x ${elapsedSeconds}s. ${this.#budget.rates.note}`,
        };
      }
      try {
        client?.close?.();
      } catch {
        // Closing the client is best-effort; the sandbox is already terminated.
      }
      if (bundleDir !== null) {
        await rm(bundleDir, { recursive: true, force: true }).catch(() => {
          record("cleanup", "The local source bundle could not be removed.");
        });
      }
    }

    return this.#attestation({
      id,
      request,
      startedAt,
      state,
      stepExitCodes,
      proofExitCode,
      proofTimedOut,
      cleanup,
      ...(failureReason ? { failureReason } : {}),
      runtimeFingerprint,
      log,
      platform: linuxPlatform,
      ...(cost ? { cost } : {}),
    });
  }

  #worstCaseCost(): number {
    return this.#budget.estimate({
      cpuCores: this.#limits.cpuCores,
      memoryMiB: this.#limits.memoryMiB,
      seconds: this.#limits.timeoutSeconds,
    });
  }

  #credentialsPresent(): boolean {
    const id = this.#env["MODAL_TOKEN_ID"];
    const secret = this.#env["MODAL_TOKEN_SECRET"];
    if (typeof id === "string" && id.trim().length > 0 && typeof secret === "string" && secret.trim().length > 0) {
      return true;
    }
    // The SDK also reads ~/.modal.toml; the availability probe below is what
    // actually decides, so a profile file is enough to attempt it.
    return this.#profile !== null || this.#env["MODAL_PROFILE"] !== undefined || hasModalConfig(this.#env);
  }

  #remoteContext(projectRoot: string, platform: PlatformTarget): MaterializationContext {
    // Steps are planned for the sandbox, so the file view is deliberately
    // empty: `planCommand` uses only the platform and managed directory.
    const files: ProjectFiles = {
      entries: [],
      read: async () => null,
      exists: async () => false,
    };
    return {
      projectDir: projectRoot,
      files,
      platform,
      probe: async () => ({ ok: false, exitCode: null, stdout: "", stderr: "", timedOut: false, notFound: true }),
      managedDir: ".iwomc",
      availableSecretNames: [],
    };
  }

  #attestation(input: {
    id: string;
    request: VerificationRequest;
    startedAt: string;
    state: VerificationState;
    stepExitCodes: { stepId: string; exitCode: number }[];
    proofExitCode: number | null;
    proofTimedOut: boolean;
    cleanup: VerificationAttestationV1["cleanup"];
    failureReason?: string;
    runtimeFingerprint: RuntimeFingerprint[];
    log: string[];
    platform: PlatformTarget;
    cost?: VerificationAttestationV1["cost"];
  }): VerificationOutput {
    const logText = boundLog(input.log.join("\n"), this.#limits.maxLogBytes).text;
    const attestation: VerificationAttestationV1 = {
      schemaVersion: 1,
      id: input.id,
      contractId: input.request.contract.id,
      contractDigest: input.request.contract.digest,
      verifier: "modal",
      state: input.state,
      // Only a passing Modal run earns `clean_verified`.
      assurance: input.state === "passed" ? "clean_verified" : "unverified",
      startedAt: input.startedAt,
      endedAt: this.#now(),
      runtimeFingerprint: input.runtimeFingerprint,
      platform: input.platform,
      stepExitCodes: input.stepExitCodes,
      proofExitCode: input.proofExitCode,
      proofTimedOut: input.proofTimedOut,
      logDigest: digestBytes(logText),
      cleanup: input.cleanup,
      ...(input.cost ? { cost: input.cost } : {}),
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    };
    return { attestation, log: logText };
  }
}

function hasModalConfig(env: NodeJS.ProcessEnv): boolean {
  const home = env["HOME"] ?? env["USERPROFILE"];
  if (!home) return false;
  try {
    return existsSync(join(home, ".modal.toml"));
  } catch {
    return false;
  }
}

export interface ImageChoice {
  readonly tag: string;
  readonly reason: string;
}

/**
 * Choose an official base image from the contract's runtime requirements.
 * Returning null is the honest answer for a combination IWOMC has not mapped -
 * it never silently substitutes a different runtime.
 */
export function selectImage(runtimes: readonly { runtime: string; versionSpec: string; observedVersion?: string }[]): ImageChoice | null {
  const wants = new Map(runtimes.map((entry) => [entry.runtime, entry]));
  const node = wants.get("node");
  const python = wants.get("python");

  if (node && !python) {
    const major = majorFromSpec(node.observedVersion ?? node.versionSpec) ?? "22";
    return { tag: `node:${major}-bookworm-slim`, reason: `contract requires node ${node.versionSpec}` };
  }
  if (python && !node) {
    const version = minorFromSpec(python.observedVersion ?? python.versionSpec) ?? "3.12";
    return { tag: `python:${version}-slim-bookworm`, reason: `contract requires python ${python.versionSpec}` };
  }
  if (node && python) {
    return null;
  }
  if (runtimes.length === 0) {
    return { tag: "debian:bookworm-slim", reason: "the contract declares no runtime requirement" };
  }
  return null;
}

function majorFromSpec(spec: string): string | null {
  const match = /(\d+)/u.exec(spec);
  return match?.[1] ?? null;
}

function minorFromSpec(spec: string): string | null {
  const match = /(\d+)\.(\d+)/u.exec(spec);
  return match ? `${match[1]}.${match[2]}` : null;
}


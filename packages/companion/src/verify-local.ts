import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  boundLog,
  digestBytes,
  type RuntimeFingerprint,
  type VerificationAttestationV1,
  type VerificationState,
} from "@iwomc/contracts";
import type { AdapterRegistry, MaterializationContext } from "@iwomc/adapters";
import { probe, run } from "./exec.js";
import { materialize } from "./materialize.js";
import { runProof } from "./proof.js";
import { MANAGED_DIR } from "./paths.js";
import { FileSystemProjectFiles } from "./project.js";
import type {
  VerificationRequest,
  VerificationOutput,
  VerifierApplicability,
  VerifierAvailability,
  VerifierPort,
} from "./ports.js";

/**
 * The local fresh-directory verifier (task 8.3).
 *
 * It clones the repository into a temporary directory, checks out the exact
 * revision, and applies the contract to a directory that has never had a
 * node_modules, a .venv, or a .env. That is a real check, so it earns the
 * `locally checked` label - and only Modal can earn `clean verified`.
 */
export class LocalFreshDirectoryVerifier implements VerifierPort {
  readonly id = "local_fresh_directory" as const;
  readonly label = "Local fresh directory";

  readonly #registry: AdapterRegistry;
  readonly #repositoryRoot: string;
  readonly #now: () => string;
  readonly #keepWorkDir: boolean;

  constructor(input: {
    registry: AdapterRegistry;
    repositoryRoot: string;
    now?: () => string;
    keepWorkDir?: boolean;
  }) {
    this.#registry = input.registry;
    this.#repositoryRoot = input.repositoryRoot;
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#keepWorkDir = input.keepWorkDir ?? false;
  }

  async availability(): Promise<VerifierAvailability> {
    const git = await probe(["git", "--version"], { timeoutMs: 15_000 });
    if (!git.ok) {
      return {
        available: false,
        status: "unavailable",
        detail: "Git is not available on PATH, so a fresh checkout cannot be created.",
      };
    }
    return {
      available: true,
      status: "connected",
      detail: "Verifies in a temporary clone of this repository at the contract's exact revision.",
    };
  }

  async applicability(): Promise<VerifierApplicability> {
    return {
      applicable: true,
      reason: "Runs entirely on this machine, so no source ever leaves it.",
    };
  }

  async verify(request: VerificationRequest): Promise<VerificationOutput> {
    const startedAt = this.#now();
    const id = randomUUID();
    const log: string[] = [];
    const record = (phase: string, message: string): void => {
      const line = `[${this.#now()}] ${phase}: ${message}`;
      log.push(line);
      request.onEvent?.({ at: this.#now(), phase, message });
    };

    let state: VerificationState = "queued";
    let workDir: string | null = null;
    let cleanup: VerificationAttestationV1["cleanup"] = "not_required";
    const stepExitCodes: { stepId: string; exitCode: number }[] = [];
    let proofExitCode: number | null = null;
    let proofTimedOut = false;
    let failureReason: string | undefined;

    try {
      state = "provisioning";
      record("provisioning", "Creating a temporary directory for a fresh checkout.");
      workDir = await mkdtemp(join(tmpdir(), "iwomc-verify-"));

      state = "preparing_source";
      const checkout = join(workDir, "source");
      record("preparing_source", `Cloning ${this.#repositoryRoot} at ${request.contract.source.commit.slice(0, 12)}.`);
      const clone = await run(["git", "clone", "--quiet", "--no-checkout", this.#repositoryRoot, checkout], {
        cwd: workDir,
        timeoutMs: 300_000,
        envAllowlist: null,
      });
      if (clone.exitCode !== 0) {
        failureReason = `git clone failed: ${clone.stderr.slice(0, 500)}`;
        throw new VerificationFailure(failureReason);
      }
      const checkoutResult = await run(
        ["git", "checkout", "--quiet", "--detach", request.contract.source.commit],
        { cwd: checkout, timeoutMs: 120_000, envAllowlist: null },
      );
      if (checkoutResult.exitCode !== 0) {
        failureReason = `The revision ${request.contract.source.commit.slice(0, 12)} is not present in this repository: ${checkoutResult.stderr.slice(0, 300)}`;
        throw new VerificationFailure(failureReason);
      }

      const projectDir =
        request.contract.source.subdirectory === "."
          ? checkout
          : resolve(checkout, request.contract.source.subdirectory);
      await mkdir(join(projectDir, MANAGED_DIR), { recursive: true });
      const files = await new FileSystemProjectFiles(projectDir).load();

      const context: MaterializationContext = {
        projectDir,
        files,
        platform: request.platform,
        probe: (argv, options) =>
          probe(argv, { cwd: options?.cwd ?? projectDir, timeoutMs: options?.timeoutMs ?? 30_000 }),
        managedDir: MANAGED_DIR,
        availableSecretNames: [],
      };

      state = "materializing";
      record("materializing", `Applying ${request.contract.steps.length} contract step(s).`);
      const materialized = await materialize({
        contract: request.contract,
        registry: this.#registry,
        context,
        completedKeys: new Set(),
        emit: (event) => record(event.kind, event.message),
        journal: () => {},
        trackedPaths: new Set(),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      for (const outcome of materialized.outcomes) {
        if (outcome.exitCode !== null) {
          stepExitCodes.push({ stepId: outcome.stepId, exitCode: outcome.exitCode });
        }
      }
      if (materialized.blocker) {
        failureReason = materialized.blocker.message;
        state = "failed";
      } else {
        state = "proving";
        record("proving", `Running the proof command: ${request.proof.argv.join(" ")}`);
        const proofResult = await runProof({
          proof: request.proof,
          projectDir,
          assurance: "locally_checked",
          emit: (event) => record(event.kind, event.message),
          env: projectLocalPath(projectDir, request.platform.os),
          ...(request.signal ? { signal: request.signal } : {}),
          now: this.#now,
        });
        proofExitCode = proofResult.attempt.exitCode;
        proofTimedOut = proofResult.attempt.timedOut;
        state = proofResult.passed ? "passed" : "failed";
        if (!proofResult.passed) failureReason = proofResult.blocker?.message;
      }
    } catch (error) {
      state = "failed";
      failureReason = failureReason ?? (error as Error).message;
      record("failed", failureReason);
    } finally {
      if (workDir !== null && !this.#keepWorkDir) {
        try {
          await rm(workDir, { recursive: true, force: true, maxRetries: 3 });
          cleanup = "terminated";
          record("cleanup", "Temporary directory removed.");
        } catch (error) {
          cleanup = "cleanup_failed";
          record("cleanup", `Temporary directory could not be removed: ${(error as Error).message}`);
        }
      } else if (workDir !== null) {
        cleanup = "not_required";
        record("cleanup", `Temporary directory kept at ${workDir} for inspection.`);
      }
    }

    const logText = boundLog(log.join("\n"), 512 * 1024).text;
    const runtimeFingerprint = await fingerprint(request.contract);

    const attestation: VerificationAttestationV1 = {
      schemaVersion: 1,
      id,
      contractId: request.contract.id,
      contractDigest: request.contract.digest,
      verifier: this.id,
      state,
      // A local fresh directory can never claim `clean_verified`.
      assurance: state === "passed" ? "locally_checked" : "unverified",
      startedAt,
      endedAt: this.#now(),
      runtimeFingerprint,
      platform: request.platform,
      stepExitCodes,
      proofExitCode,
      proofTimedOut,
      logDigest: digestBytes(logText),
      cleanup,
      ...(failureReason ? { failureReason } : {}),
    };

    return { attestation, log: logText };
  }
}

class VerificationFailure extends Error {}

async function fingerprint(contract: {
  requirements: { runtimes: readonly { runtime: string }[] };
}): Promise<RuntimeFingerprint[]> {
  const out: RuntimeFingerprint[] = [];
  for (const runtime of contract.requirements.runtimes) {
    const result = await probe([runtime.runtime, "--version"], { timeoutMs: 20_000 });
    if (!result.ok) {
      out.push({ runtime: runtime.runtime, version: "unavailable", source: "unavailable" });
      continue;
    }
    const match = /(\d+\.\d+(?:\.\d+)?)/u.exec(`${result.stdout} ${result.stderr}`);
    out.push({
      runtime: runtime.runtime,
      version: match?.[1] ?? result.stdout.trim().slice(0, 32),
      source: "observed",
    });
  }
  return out;
}

function projectLocalPath(projectDir: string, os: string): Record<string, string> {
  const separator = os === "windows" ? ";" : ":";
  const additions = [
    join(projectDir, "node_modules", ".bin"),
    join(projectDir, ".venv", os === "windows" ? "Scripts" : "bin"),
  ];
  const existing = process.env["PATH"] ?? process.env["Path"] ?? "";
  return { PATH: `${additions.join(separator)}${separator}${existing}` };
}

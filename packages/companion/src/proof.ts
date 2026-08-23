import { randomUUID } from "node:crypto";
import { blocker, type Blocker, type ProofAttempt, type ProofCommand, type RescueEvent, type VerificationAssurance } from "@iwomc/contracts";
import { run } from "./exec.js";
import { parseCommandLine } from "./command.js";
import { resolveInsideProject } from "./paths.js";

/**
 * Proof execution (task 3.4).
 *
 * A rescue reports `working` only when this returns a passing attempt. A
 * successful install with a failing proof is `failed`, never `working` (R7.6).
 */

export interface ProofRunInput {
  readonly proof: ProofCommand;
  readonly projectDir: string;
  readonly assurance: VerificationAssurance;
  readonly emit?: (event: Omit<RescueEvent, "runId" | "seq" | "at">) => void;
  readonly signal?: AbortSignal;
  /**
   * Extra environment for the proof, typically project-local bin paths.
   * Values here are non-secret; secrets reach the proof only through the
   * contract's environment allowlist, read from the developer's own shell.
   */
  readonly env?: Readonly<Record<string, string>>;
  readonly now?: () => string;
}

export interface ProofRunResult {
  readonly attempt: ProofAttempt;
  readonly passed: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly blocker: Blocker | null;
}

export async function runProof(input: ProofRunInput): Promise<ProofRunResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const workDir = resolveInsideProject(input.projectDir, input.proof.workDir);
  if (workDir === null) {
    return {
      attempt: {
        proofId: input.proof.id,
        exitCode: null,
        durationMs: 0,
        timedOut: false,
        assurance: "unverified",
        startedAt,
      },
      passed: false,
      stdout: "",
      stderr: "",
      blocker: blocker(
        "policy_denied",
        `The proof command's working directory (${input.proof.workDir}) is outside the checkout.`,
        "Reject this contract and capture a new one.",
      ),
    };
  }

  input.emit?.({
    kind: "proof_started",
    message: `Running the proof command: ${input.proof.argv.join(" ")}`,
  });

  const result = await run(input.proof.argv, {
    cwd: workDir,
    timeoutMs: input.proof.timeoutMs,
    // The proof sees only the variables the contract names, plus the base
    // environment every process needs.
    envAllowlist: [...input.proof.envAllowlist],
    env: input.env ?? {},
    maxOutputBytes: input.proof.maxOutputBytes,
    onOutput: (stream, chunk) => {
      const text = chunk.trimEnd();
      if (text.length === 0) return;
      input.emit?.({ kind: "proof_output", stream, message: text.slice(0, 8000) });
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const passed =
    !result.notFound &&
    !result.timedOut &&
    result.exitCode !== null &&
    input.proof.expectedExitCodes.includes(result.exitCode);

  const attempt: ProofAttempt = {
    proofId: input.proof.id,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    assurance: passed ? input.assurance : "unverified",
    startedAt,
  };

  input.emit?.({
    kind: "proof_finished",
    message: passed
      ? `The proof command passed (exit ${result.exitCode}).`
      : result.timedOut
        ? `The proof command timed out after ${input.proof.timeoutMs} ms.`
        : result.notFound
          ? `${input.proof.argv[0]} is not available on PATH.`
          : `The proof command failed (exit ${result.exitCode ?? "null"}).`,
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
  });

  let failure: Blocker | null = null;
  if (!passed) {
    if (result.notFound) {
      failure = blocker(
        "proof_failed",
        `${input.proof.argv[0]} is not available on PATH, so the proof command could not run.`,
        `Install ${input.proof.argv[0]}, then run rescue again.`,
      );
    } else if (result.timedOut) {
      failure = blocker(
        "proof_timeout",
        `The proof command did not finish within ${input.proof.timeoutMs} ms.`,
        "Increase the proof timeout, or fix what is hanging, then run rescue again.",
      );
    } else {
      failure = blocker(
        "proof_failed",
        `The proof command exited with code ${result.exitCode ?? "null"}; expected ${input.proof.expectedExitCodes.join(" or ")}.`,
        "Read the proof output above. The environment was prepared, but the project still does not pass its own check.",
        { exitCode: result.exitCode },
      );
    }
  }

  return { attempt, passed, stdout: result.stdout, stderr: result.stderr, blocker: failure };
}

export interface ProofDraftInput {
  readonly commandLine: string;
  readonly workDir?: string;
  readonly description?: string;
  readonly timeoutMs?: number;
  readonly envAllowlist?: readonly string[];
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

/**
 * Build a proof command from a human-typed line. The line is tokenized, never
 * handed to a shell, and anything shell-shaped is refused.
 */
export function draftProofCommand(input: ProofDraftInput): ProofCommand {
  const argv = parseCommandLine(input.commandLine);
  return {
    id: randomUUID(),
    argv,
    workDir: input.workDir ?? ".",
    timeoutMs: input.timeoutMs ?? 600_000,
    expectedExitCodes: [0],
    envAllowlist: [...(input.envAllowlist ?? [])],
    description: input.description ?? `Project proof: ${argv.join(" ")}`,
    maxOutputBytes: 512 * 1024,
    ...(input.approvedBy ? { approvedBy: input.approvedBy } : {}),
    ...(input.approvedAt ? { approvedAt: input.approvedAt } : {}),
  };
}

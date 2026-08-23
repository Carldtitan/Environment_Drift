import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BlockedError, blocker, digestBytes, digestOf, type Blocker } from "@iwomc/contracts";
import type {
  EnvironmentContractV1,
  MaterializationStep,
  RescueEvent,
} from "@iwomc/contracts";
import type { AdapterRegistry, MaterializationContext } from "@iwomc/adapters";
import { run, probe } from "./exec.js";
import { satisfies } from "@iwomc/adapters";
import { MANAGED_DIR, resolveInsideManagedDir, resolveInsideProject } from "./paths.js";

/**
 * The typed materialization executor (task 3.3).
 *
 * It refuses unknown step kinds, paths outside the checkout, unreviewed
 * recipes, and any write to a Git-tracked file. Every attempt is journaled
 * before and after it runs, so an interrupted rescue can resume the steps that
 * already succeeded instead of repeating them (R7.4).
 */

export interface StepOutcome {
  readonly stepId: string;
  readonly idempotencyKey: string;
  readonly status: "succeeded" | "skipped" | "failed";
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly detail: Record<string, unknown>;
  readonly blocker?: Blocker;
}

export interface MaterializeInput {
  readonly contract: EnvironmentContractV1;
  readonly registry: AdapterRegistry;
  readonly context: MaterializationContext;
  /** Idempotency keys already recorded as succeeded for this contract. */
  readonly completedKeys: ReadonlySet<string>;
  readonly emit: (event: Omit<RescueEvent, "runId" | "seq" | "at">) => void;
  readonly journal: (entry: {
    stepId: string;
    idempotencyKey: string;
    phase: "started" | "succeeded" | "failed" | "skipped";
    detail: Record<string, unknown>;
  }) => void;
  readonly signal?: AbortSignal;
  readonly trackedPaths: ReadonlySet<string>;
}

export interface MaterializeResult {
  readonly outcomes: readonly StepOutcome[];
  readonly blocker: Blocker | null;
}

export async function materialize(input: MaterializeInput): Promise<MaterializeResult> {
  const outcomes: StepOutcome[] = [];

  for (const step of input.contract.steps) {
    if (input.completedKeys.has(step.idempotencyKey)) {
      const outcome: StepOutcome = {
        stepId: step.id,
        idempotencyKey: step.idempotencyKey,
        status: "skipped",
        exitCode: null,
        durationMs: 0,
        detail: { reason: "already applied for this contract" },
      };
      outcomes.push(outcome);
      input.journal({ ...outcome, phase: "skipped" });
      input.emit({
        kind: "step_finished",
        stepId: step.id,
        message: `${step.description} - already applied, skipped.`,
      });
      continue;
    }

    input.emit({ kind: "step_started", stepId: step.id, message: step.description });
    input.journal({
      stepId: step.id,
      idempotencyKey: step.idempotencyKey,
      phase: "started",
      detail: { kind: step.kind },
    });

    let outcome: StepOutcome;
    try {
      outcome = await runStep(step, input);
    } catch (error) {
      if (error instanceof BlockedError) {
        outcome = {
          stepId: step.id,
          idempotencyKey: step.idempotencyKey,
          status: "failed",
          exitCode: null,
          durationMs: 0,
          detail: { blocker: error.blocker.code },
          blocker: error.blocker,
        };
      } else {
        outcome = {
          stepId: step.id,
          idempotencyKey: step.idempotencyKey,
          status: "failed",
          exitCode: null,
          durationMs: 0,
          detail: { error: (error as Error).message },
          blocker: blocker(
            "internal_error",
            `Step ${step.id} failed: ${(error as Error).message}`,
            "Re-run `iwomc rescue`. If it repeats, run `iwomc doctor` and report the step id.",
          ),
        };
      }
    }

    outcomes.push(outcome);
    input.journal({
      stepId: outcome.stepId,
      idempotencyKey: outcome.idempotencyKey,
      phase: outcome.status,
      detail: outcome.detail,
    });
    input.emit({
      kind: "step_finished",
      stepId: step.id,
      message:
        outcome.status === "succeeded"
          ? `${step.description} - done.`
          : `${step.description} - ${outcome.blocker?.message ?? "failed"}`,
      ...(outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.blocker ? { blocker: outcome.blocker } : {}),
    });

    if (outcome.status === "failed") {
      return { outcomes, blocker: outcome.blocker ?? null };
    }
  }

  return { outcomes, blocker: null };
}

async function runStep(step: MaterializationStep, input: MaterializeInput): Promise<StepOutcome> {
  const started = Date.now();
  const ctx = input.context;

  switch (step.kind) {
    case "ensure_runtime": {
      const result = await probe(step.probeArgv, { cwd: ctx.projectDir, timeoutMs: 30_000 });
      if (!result.ok) {
        return fail(step, started, "missing_runtime", `${step.runtime} is not available on PATH.`, `Install ${step.runtime} ${step.versionSpec} and make it available on PATH, then run rescue again.`);
      }
      const version = extractVersion(`${result.stdout} ${result.stderr}`);
      if (version === null) {
        return succeed(step, started, {
          note: `${step.runtime} is present but its version could not be parsed; the version constraint was not checked.`,
        });
      }
      const verdict = satisfies(version, step.versionSpec);
      if (verdict === "unsatisfied") {
        return fail(
          step,
          started,
          "missing_runtime",
          `${step.runtime} ${version} does not satisfy ${step.versionSpec}.`,
          `Install ${step.runtime} ${step.versionSpec} and make it available on PATH.`,
        );
      }
      return succeed(step, started, { version, constraint: step.versionSpec, verdict });
    }

    case "ensure_system_tool": {
      const result = await probe(step.probeArgv, { cwd: ctx.projectDir, timeoutMs: 30_000 });
      if (!result.ok) {
        return fail(
          step,
          started,
          "missing_system_tool",
          `${step.tool} is not available on PATH.`,
          step.installHint ?? `Install ${step.tool} and make it available on PATH.`,
        );
      }
      return succeed(step, started, { tool: step.tool });
    }

    case "write_project_local_file": {
      const target = resolveInsideManagedDir(ctx.projectDir, step.path);
      if (target === null) {
        return fail(
          step,
          started,
          "policy_denied",
          `Step ${step.id} tried to write outside the ${MANAGED_DIR} directory.`,
          "Reject this contract: rescue may only write project-local managed state.",
        );
      }
      if (digestBytes(step.content) !== step.contentDigest) {
        return fail(
          step,
          started,
          "signature_invalid",
          `Step ${step.id} content does not match its recorded digest.`,
          "Re-fetch the contract; it may have been modified.",
        );
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, step.content, "utf8");
      return succeed(step, started, { path: step.path, bytes: step.content.length });
    }

    case "create_virtual_environment": {
      const target = resolveInsideProject(ctx.projectDir, step.path);
      if (target === null) {
        return fail(
          step,
          started,
          "policy_denied",
          `Step ${step.id} tried to create an environment outside the checkout.`,
          "Reject this contract.",
        );
      }
      if (input.trackedPaths.has(normalize(step.path))) {
        return fail(
          step,
          started,
          "policy_denied",
          `${step.path} is tracked by Git; rescue never writes a tracked file.`,
          "Remove the path from version control, or capture a contract that uses a different directory.",
        );
      }
      return await runPlanned(step, input, started);
    }

    case "install_project_dependencies":
    case "apply_package_overlay":
      return await runPlanned(step, input, started);

    case "run_reviewed_recipe": {
      if (input.contract.policy.requireRecipeReview) {
        if (step.review.approvedCommandDigest !== step.commandDigest) {
          return fail(
            step,
            started,
            "recipe_not_reviewed",
            `Recipe ${step.id} was modified after it was reviewed.`,
            "Have a maintainer review the current command before rescuing with this contract.",
          );
        }
        if (digestOf(step.argv) !== step.commandDigest) {
          return fail(
            step,
            started,
            "recipe_not_reviewed",
            `Recipe ${step.id} does not match its command digest.`,
            "Re-fetch the contract; it may have been modified.",
          );
        }
      }
      return await runPlanned(step, input, started);
    }

    default: {
      // A step kind the executor does not implement is refused, never guessed.
      const unknown = step as { kind: string; id: string };
      return {
        stepId: unknown.id,
        idempotencyKey: "unknown",
        status: "failed",
        exitCode: null,
        durationMs: Date.now() - started,
        detail: { kind: unknown.kind },
        blocker: blocker(
          "policy_denied",
          `This IWOMC build does not implement step kind "${unknown.kind}".`,
          "Upgrade IWOMC, or capture a new contract with this version.",
        ),
      };
    }
  }
}

async function runPlanned(
  step: MaterializationStep,
  input: MaterializeInput,
  started: number,
): Promise<StepOutcome> {
  const adapter = input.registry.byId(step.adapterId);
  if (!adapter) {
    return fail(
      step,
      started,
      "unsupported_ecosystem",
      `No adapter named ${step.adapterId} is installed in this IWOMC build.`,
      "Upgrade IWOMC, or capture a new contract with the adapters this machine has.",
    );
  }
  const plan = adapter.planCommand(step, input.context);
  if (plan === null) {
    return fail(
      step,
      started,
      "unsupported_ecosystem",
      `${step.adapterId} does not know how to execute step ${step.id}.`,
      "Capture a new contract with this IWOMC version.",
    );
  }

  const workDir = resolveInsideProject(input.context.projectDir, plan.workDir);
  if (workDir === null) {
    return fail(
      step,
      started,
      "policy_denied",
      `Step ${step.id} asked to run outside the checkout.`,
      "Reject this contract.",
    );
  }

  const envAllowlist =
    step.kind === "run_reviewed_recipe" ? [...step.envAllowlist] : null;

  const result = await run(plan.argv, {
    cwd: workDir,
    timeoutMs: plan.timeoutMs,
    env: plan.env,
    // Materialization steps other than a reviewed recipe need a real PATH to
    // find their package manager; a recipe is restricted to its allowlist.
    envAllowlist,
    maxOutputBytes: 256 * 1024,
    onOutput: (stream, chunk) => {
      const text = chunk.trimEnd();
      if (text.length === 0) return;
      input.emit({ kind: "step_output", stepId: step.id, stream, message: text.slice(0, 8000) });
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (result.notFound) {
    return fail(
      step,
      started,
      "missing_system_tool",
      `${plan.argv[0]} is not available on PATH.`,
      `Install ${plan.argv[0]} and make it available on PATH, then run rescue again.`,
    );
  }
  if (result.timedOut) {
    return fail(
      step,
      started,
      "step_failed",
      `${step.description} timed out after ${plan.timeoutMs} ms.`,
      "Check the network or increase the step timeout in the contract, then run rescue again.",
    );
  }
  if (result.exitCode === null || !plan.expectedExitCodes.includes(result.exitCode)) {
    return {
      stepId: step.id,
      idempotencyKey: step.idempotencyKey,
      status: "failed",
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      detail: { argv: plan.argv, stderr: result.stderr.slice(-4000) },
      blocker: blocker(
        "step_failed",
        `${step.description} exited with code ${result.exitCode ?? "null"}.`,
        "Read the step output above, fix the reported problem, then run rescue again.",
        { stepId: step.id, exitCode: result.exitCode },
      ),
    };
  }

  return {
    stepId: step.id,
    idempotencyKey: step.idempotencyKey,
    status: "succeeded",
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
    detail: { argv: plan.argv },
  };
}

function succeed(
  step: MaterializationStep,
  started: number,
  detail: Record<string, unknown>,
): StepOutcome {
  return {
    stepId: step.id,
    idempotencyKey: step.idempotencyKey,
    status: "succeeded",
    exitCode: 0,
    durationMs: Date.now() - started,
    detail,
  };
}

function fail(
  step: MaterializationStep,
  started: number,
  code: Parameters<typeof blocker>[0],
  message: string,
  nextAction: string,
): StepOutcome {
  return {
    stepId: step.id,
    idempotencyKey: step.idempotencyKey,
    status: "failed",
    exitCode: null,
    durationMs: Date.now() - started,
    detail: { code },
    blocker: blocker(code, message, nextAction, { stepId: step.id }),
  };
}

function extractVersion(text: string): string | null {
  const match = /(\d+\.\d+(?:\.\d+)?)/u.exec(text);
  return match?.[1] ?? null;
}

function normalize(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

export { join as joinPath };

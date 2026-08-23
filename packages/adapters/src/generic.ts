import { digestOf } from "@iwomc/contracts";
import type { DriftFinding, MaterializationStep, ProposedFileChange } from "@iwomc/contracts";
import type {
  AdapterContext,
  AdapterManifest,
  AdapterVerification,
  CommandPlan,
  CompileResult,
  DeclaredState,
  Detection,
  EnvironmentAdapter,
  EvidenceBundle,
  InventoryResult,
  MaterializationContext,
  ObservedEffect,
  ObservedProcess,
  PreflightIssue,
  PreflightResult,
  ProjectFiles,
} from "./types.js";

/**
 * The fallback adapter (R11.5).
 *
 * It never invents a setup. It can carry a *reviewed* recipe that a human
 * authored, and otherwise reports `observe_only`: evidence is still captured,
 * but rescue will not guess a command for an ecosystem nobody implemented.
 */
export class GenericAdapter implements EnvironmentAdapter {
  readonly manifest: AdapterManifest = {
    id: "generic.recipe",
    ecosystem: "generic",
    manager: "reviewed-recipe",
    support: "recipe",
    declaredFiles: [],
    capabilities: {
      detect: true,
      readDeclaredState: false,
      inventory: false,
      compile: true,
      materialize: true,
      verify: false,
    },
    conformanceTested: true,
    supportNote:
      "Carries a setup command a human wrote and reviewed, with a fixed working directory, environment allowlist, timeout, and expected exit codes. It never proposes a command on its own.",
  };

  async detect(_files: ProjectFiles): Promise<Detection> {
    // The fallback is selected by the compiler when no native adapter owns the
    // project; it does not claim a project on its own.
    return { detected: false, signals: [], confidence: "low" };
  }

  async readDeclaredState(_ctx: AdapterContext): Promise<DeclaredState> {
    return {
      adapterId: this.manifest.id,
      files: [],
      runtimes: [],
      packages: [],
      systemTools: [],
      secrets: [],
      gaps: [
        {
          area: "generic.declaration",
          reason:
            "No native adapter owns this project, so IWOMC cannot read its declared dependency set.",
          remediation:
            "Add a reviewed setup recipe for this project, or contribute a native adapter for its ecosystem.",
        },
      ],
    };
  }

  async inventory(_ctx: AdapterContext): Promise<InventoryResult> {
    return {
      adapterId: this.manifest.id,
      available: false,
      gaps: [
        {
          area: "generic.inventory",
          reason: "IWOMC has no inventory strategy for this ecosystem, so absence is not evidence of absence.",
        },
      ],
    };
  }

  observeProcess(_process: ObservedProcess): readonly ObservedEffect[] {
    return [];
  }

  async deriveObservedEffects(_ctx: AdapterContext): Promise<readonly ObservedEffect[]> {
    // Nothing can be derived for an ecosystem IWOMC does not model.
    return [];
  }

  compile(bundle: EvidenceBundle): CompileResult {
    return {
      adapterId: this.manifest.id,
      support: "observe_only",
      reason:
        "No native adapter owns this project and no reviewed setup recipe is attached, so IWOMC captured evidence but cannot materialize an environment.",
      coverage: [
        ...bundle.declared.gaps,
        {
          area: "generic.materialization",
          reason: "Rescue is unavailable until a reviewer approves a setup recipe for this project.",
          remediation: "Run `iwomc capture --recipe \"<command>\"` and have a maintainer review it.",
        },
      ],
      packages: [],
    };
  }

  async preflight(
    ctx: MaterializationContext,
    steps: readonly MaterializationStep[],
  ): Promise<PreflightResult> {
    const issues: PreflightIssue[] = [];
    for (const step of steps) {
      if (step.adapterId !== this.manifest.id) continue;
      if (step.kind !== "run_reviewed_recipe") continue;
      const executable = step.argv[0];
      if (executable === undefined) continue;
      const probe = await ctx.probe([executable, "--version"], { timeoutMs: 30_000 });
      if (probe.notFound) {
        issues.push({
          code: "missing_system_tool",
          message: `${executable} is not available on PATH, so the reviewed recipe cannot run.`,
          nextAction: `Install ${executable} and make it available on PATH.`,
        });
      }
    }
    return { adapterId: this.manifest.id, issues };
  }

  planCommand(step: MaterializationStep, _ctx: MaterializationContext): CommandPlan | null {
    if (step.adapterId !== this.manifest.id) return null;
    if (step.kind !== "run_reviewed_recipe") return null;
    return {
      argv: step.argv,
      workDir: step.workDir,
      env: {},
      timeoutMs: step.timeoutMs,
      expectedExitCodes: step.expectedExitCodes,
    };
  }

  async verifyAfterMaterialize(_ctx: MaterializationContext): Promise<AdapterVerification> {
    return {
      adapterId: this.manifest.id,
      satisfied: true,
      checks: [
        {
          name: "recipe completed",
          passed: true,
          detail:
            "A reviewed recipe reports success by its exit code only; the proof command is what decides whether the project works.",
        },
      ],
    };
  }

  async proposeRepair(
    _bundle: EvidenceBundle,
    _finding: Omit<DriftFinding, "id" | "projectId" | "commit" | "detectedAt">,
    _pending?: ReadonlyMap<string, string>,
  ): Promise<readonly ProposedFileChange[]> {
    return [];
  }
}

/**
 * Build a reviewed recipe step. The caller must have obtained an explicit human
 * review; the digest binds the review to the exact argv.
 */
export function buildReviewedRecipeStep(input: {
  readonly argv: readonly string[];
  readonly workDir: string;
  readonly description: string;
  readonly envAllowlist: readonly string[];
  readonly timeoutMs: number;
  readonly expectedExitCodes: readonly number[];
  readonly reviewedBy: string;
  readonly reviewedAt: string;
}): MaterializationStep {
  const commandDigest = digestOf(input.argv);
  return {
    id: `generic.recipe:${commandDigest.slice(7, 19)}`,
    kind: "run_reviewed_recipe",
    adapterId: "generic.recipe",
    workDir: input.workDir,
    idempotencyKey: `recipe-${commandDigest.slice(7, 27)}`,
    description: input.description,
    argv: [...input.argv],
    commandDigest,
    envAllowlist: [...input.envAllowlist],
    timeoutMs: input.timeoutMs,
    expectedExitCodes: [...input.expectedExitCodes],
    review: {
      reviewedBy: input.reviewedBy,
      reviewedAt: input.reviewedAt,
      approvedCommandDigest: commandDigest,
    },
  };
}

export const genericAdapter = new GenericAdapter();

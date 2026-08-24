import type {
  CoverageGap,
  EvidenceItem,
  MaterializationStep,
  PackageRequirement,
  PlatformTarget,
  RuntimeRequirement,
  SecretRequirement,
  SupportLevel,
  SystemToolRequirement,
  InventorySnapshot,
  DriftFinding,
  ProposedFileChange,
} from "@iwomc/contracts";

/**
 * The ecosystem adapter protocol (R11, design 4.2).
 *
 * An adapter never runs a command merely because a directory contains a file
 * with a familiar name. Detection is file-shaped; execution only happens for a
 * step the adapter itself compiled and a human or policy approved.
 */

/** A read-only view of the project directory handed to detection and parsing. */
export interface ProjectFiles {
  /** Repository-relative POSIX paths present at the project root, one level deep. */
  readonly entries: readonly string[];
  /** Read a project-relative file as UTF-8, or null when it does not exist. */
  read(path: string): Promise<string | null>;
  /** True when a project-relative path exists. */
  exists(path: string): Promise<boolean>;
}

export interface Detection {
  readonly detected: boolean;
  /** Files that triggered detection - the evidence for the decision. */
  readonly signals: readonly string[];
  /** Confidence that this adapter owns the project, not just that files exist. */
  readonly confidence: "high" | "medium" | "low";
  readonly note?: string;
}

export interface AdapterContext {
  /** Absolute path of the project root on this machine. */
  readonly projectDir: string;
  readonly files: ProjectFiles;
  readonly platform: PlatformTarget;
  /** Run a bounded, non-mutating probe. Adapters use it for inventory only. */
  readonly probe: ProbeRunner;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True when the executable itself could not be found. */
  readonly notFound: boolean;
}

export type ProbeRunner = (
  argv: readonly string[],
  options?: { readonly cwd?: string; readonly timeoutMs?: number },
) => Promise<ProbeResult>;

export interface DeclaredState {
  readonly adapterId: string;
  /** Manifest/lockfile paths this adapter treats as declared environment. */
  readonly files: readonly string[];
  readonly runtimes: readonly RuntimeRequirement[];
  readonly packages: readonly PackageRequirement[];
  readonly systemTools: readonly SystemToolRequirement[];
  readonly secrets: readonly SecretRequirement[];
  readonly gaps: readonly CoverageGap[];
  /**
   * Exact versions the repository would install, by package name.
   *
   * A version *range* in a manifest is not what a teammate gets - the lockfile
   * is. Comparing what is installed here against the range would fire on every
   * healthy project; comparing it against the lockfile only fires when a fresh
   * install would genuinely produce something different.
   *
   * Empty when the ecosystem has no lockfile committed.
   */
  readonly lockedVersions?: Readonly<Record<string, string>>;
}

export interface InventoryResult {
  readonly adapterId: string;
  readonly available: boolean;
  readonly snapshot?: InventorySnapshot;
  readonly gaps: readonly CoverageGap[];
}

/** A package-manager process the Companion correlated to the project. */
export interface ObservedProcess {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly startedAt: string;
  readonly exitCode: number | null;
  readonly provider?: string;
  readonly sessionRef?: string;
}

export interface ObservedEffect {
  readonly adapterId: string;
  readonly kind: "package_added" | "package_removed" | "environment_created" | "unknown_action";
  readonly manager: string;
  readonly packages: readonly { readonly name: string; readonly versionSpec: string }[];
  readonly confidence: "high" | "medium" | "low";
  readonly summary: string;
}

export interface EvidenceBundle {
  readonly projectDir: string;
  readonly platform: PlatformTarget;
  readonly declared: DeclaredState;
  readonly inventoryBefore?: InventorySnapshot;
  readonly inventoryAfter?: InventorySnapshot;
  readonly observed: readonly ObservedEffect[];
  readonly evidence: readonly EvidenceItem[];
  /** Project-relative directory used for IWOMC-managed local state. */
  readonly managedDir: string;
}

export interface ContractFragment {
  readonly adapterId: string;
  readonly support: Extract<SupportLevel, "native" | "recipe">;
  readonly runtimes: readonly RuntimeRequirement[];
  readonly packages: readonly PackageRequirement[];
  readonly systemTools: readonly SystemToolRequirement[];
  readonly secrets: readonly SecretRequirement[];
  /** Steps carry no review; the compiler attaches one for recipe steps. */
  readonly steps: readonly MaterializationStep[];
  readonly coverage: readonly CoverageGap[];
  readonly drift: readonly Omit<DriftFinding, "id" | "projectId" | "commit" | "detectedAt">[];
}

export interface UnsupportedResult {
  readonly adapterId: string;
  readonly support: "observe_only";
  readonly reason: string;
  readonly coverage: readonly CoverageGap[];
  /** Evidence is still captured, it simply cannot be materialized. */
  readonly packages: readonly PackageRequirement[];
}

export type CompileResult = ContractFragment | UnsupportedResult;

export function isUnsupported(result: CompileResult): result is UnsupportedResult {
  return result.support === "observe_only";
}

/** How a step this adapter owns is turned into an actual process invocation. */
export interface CommandPlan {
  readonly argv: readonly string[];
  /** Project-relative working directory. */
  readonly workDir: string;
  /** Additional environment entries. Never contains secret values. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly expectedExitCodes: readonly number[];
}

export interface MaterializationContext extends AdapterContext {
  /** Project-relative directory for IWOMC-managed state. */
  readonly managedDir: string;
  /** Names of secrets present in the environment. Values are never exposed. */
  readonly availableSecretNames: readonly string[];
}

export interface AdapterVerification {
  readonly adapterId: string;
  readonly satisfied: boolean;
  readonly checks: readonly {
    readonly name: string;
    readonly passed: boolean;
    readonly detail: string;
  }[];
}

export interface PreflightIssue {
  readonly code:
    | "missing_runtime"
    | "missing_system_tool"
    | "unsupported_ecosystem"
    | "unsupported_platform"
    | "manifest_missing";
  readonly message: string;
  readonly nextAction: string;
}

export interface PreflightResult {
  readonly adapterId: string;
  readonly issues: readonly PreflightIssue[];
}

/** Metadata that drives the honest capability matrix in docs and the console. */
export interface AdapterManifest {
  readonly id: string;
  readonly ecosystem: string;
  readonly manager: string;
  readonly support: SupportLevel;
  readonly declaredFiles: readonly string[];
  readonly capabilities: {
    readonly detect: boolean;
    readonly readDeclaredState: boolean;
    readonly inventory: boolean;
    readonly compile: boolean;
    readonly materialize: boolean;
    readonly verify: boolean;
  };
  /** Only true when a conformance test proves the full loop for this adapter. */
  readonly conformanceTested: boolean;
  /** Why the support level is what it is - shown verbatim in the UI. */
  readonly supportNote: string;
}

export interface EnvironmentAdapter {
  readonly manifest: AdapterManifest;
  detect(files: ProjectFiles): Promise<Detection>;
  readDeclaredState(ctx: AdapterContext): Promise<DeclaredState>;
  inventory(ctx: AdapterContext): Promise<InventoryResult>;
  observeProcess(process: ObservedProcess): readonly ObservedEffect[];
  /**
   * Effects derived from the installed state alone, with no process
   * observation: for example a package that is installed and reachable from no
   * declared dependency, which means someone installed it directly here.
   */
  deriveObservedEffects(ctx: AdapterContext): Promise<readonly ObservedEffect[]>;
  compile(bundle: EvidenceBundle): CompileResult;
  preflight(ctx: MaterializationContext, steps: readonly MaterializationStep[]): Promise<PreflightResult>;
  /** Turn one owned step into a bounded command, or null when it needs none. */
  planCommand(step: MaterializationStep, ctx: MaterializationContext): CommandPlan | null;
  verifyAfterMaterialize(ctx: MaterializationContext): Promise<AdapterVerification>;
  /**
   * Repository repair proposed by `promote`, as a plain file diff.
   *
   * `pending` carries content already proposed by earlier findings for the same
   * files, so several findings compose into one coherent change instead of
   * overwriting each other.
   */
  proposeRepair(
    bundle: EvidenceBundle,
    finding: Omit<DriftFinding, "id" | "projectId" | "commit" | "detectedAt">,
    pending?: ReadonlyMap<string, string>,
  ): Promise<readonly ProposedFileChange[]>;
}

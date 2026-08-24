import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { digestOf } from "@iwomc/contracts";
import type {
  CoverageGap,
  DriftFinding,
  MaterializationStep,
  PackageRequirement,
  ProposedFileChange,
  RuntimeRequirement,
  SecretRequirement,
  SystemToolRequirement,
} from "@iwomc/contracts";
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
import { parseToml, tomlGet, tomlString, tomlStringArray } from "./toml.js";
import { pinExact, satisfies } from "./semver.js";
import { unifiedDiff } from "./diff.js";

type ContractDrift = Omit<DriftFinding, "id" | "projectId" | "commit" | "detectedAt">;

const REQUIREMENTS = "requirements.txt";
const PYPROJECT = "pyproject.toml";
const UV_LOCK = "uv.lock";
const VENV_DIR = ".venv";

/** Distributions every virtual environment ships with; not project drift. */
const BOOTSTRAP_DISTRIBUTIONS = new Set(["pip", "setuptools", "wheel", "pkg-resources", "distribute"]);

/** PEP 508 requirement line -> name plus the version specifier that follows. */
export function parseRequirementLine(line: string): { name: string; versionSpec: string } | null {
  const text = line.split("#")[0]?.trim() ?? "";
  if (text.length === 0) return null;
  if (text.startsWith("-")) return null; // -r, -e, --index-url and friends
  if (/^(?:https?|git\+|file):/u.test(text)) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/u.exec(text);
  if (!match) return null;
  const name = normalizePythonName(match[1] as string);
  const rest = (match[3] ?? "").split(";")[0]?.trim() ?? "";
  return { name, versionSpec: rest.length > 0 ? rest : "*" };
}

/** PEP 503 normalization so `Flask_Login` and `flask-login` are one package. */
export function normalizePythonName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/gu, "-");
}

/**
 * Read installed distributions from the project-local virtual environment by
 * listing `*.dist-info` directories. Filesystem only - no interpreter is run.
 */
async function readVenvDistributions(
  projectDir: string,
  venvDir: string,
): Promise<Map<string, string> | null> {
  const candidates: string[] = [join(projectDir, venvDir, "Lib", "site-packages")];
  const libDir = join(projectDir, venvDir, "lib");
  try {
    for (const entry of await readdir(libDir)) {
      candidates.push(join(libDir, entry, "site-packages"));
    }
  } catch {
    // POSIX layout absent; the Windows candidate above may still exist.
  }

  for (const sitePackages of candidates) {
    let entries: string[];
    try {
      entries = await readdir(sitePackages);
    } catch {
      continue;
    }
    const installed = new Map<string, string>();
    for (const entry of entries) {
      const match = /^(.+?)-(\d[^-]*)\.dist-info$/u.exec(entry);
      if (!match) continue;
      installed.set(normalizePythonName(match[1] as string), match[2] as string);
    }
    return installed;
  }
  return null;
}

/** Path of the interpreter/console script inside a project-local venv. */
function venvBin(venvDir: string, tool: string, os: string): string {
  return os === "windows" ? `${venvDir}/Scripts/${tool}.exe` : `${venvDir}/bin/${tool}`;
}

interface PythonDeclaration {
  readonly files: string[];
  readonly packages: PackageRequirement[];
  readonly requiresPython: string | null;
  readonly gaps: CoverageGap[];
  readonly hasUvLock: boolean;
  readonly hasPoetry: boolean;
  readonly isPackage: boolean;
}

async function readPythonDeclaration(
  files: ProjectFiles,
  manager: "pip" | "uv",
): Promise<PythonDeclaration> {
  const declaredFiles: string[] = [];
  const packages: PackageRequirement[] = [];
  const gaps: CoverageGap[] = [];
  let requiresPython: string | null = null;
  let hasUvLock = false;
  let hasPoetry = false;
  let isPackage = false;

  const requirements = await files.read(REQUIREMENTS);
  if (requirements !== null) {
    declaredFiles.push(REQUIREMENTS);
    for (const line of requirements.split(/\r?\n/u)) {
      const parsed = parseRequirementLine(line);
      if (parsed === null) {
        const trimmed = line.split("#")[0]?.trim() ?? "";
        if (trimmed.length > 0) {
          gaps.push({
            area: "python.requirements",
            reason: `requirements.txt line "${trimmed.slice(0, 80)}" is not a plain pinned requirement; IWOMC records it but does not model it.`,
          });
        }
        continue;
      }
      packages.push({
        ecosystem: "python",
        manager,
        name: parsed.name,
        versionSpec: parsed.versionSpec,
        scope: "direct",
        source: "declared",
        evidenceRefs: [],
        declared: true,
      });
    }
  }

  const pyprojectRaw = await files.read(PYPROJECT);
  if (pyprojectRaw !== null) {
    declaredFiles.push(PYPROJECT);
    const document = parseToml(pyprojectRaw);
    isPackage = tomlGet(document, "project.name") !== undefined;
    hasPoetry = tomlGet(document, "tool.poetry") !== undefined;
    hasUvLock = tomlGet(document, "tool.uv") !== undefined;
    requiresPython = tomlString(document, "project.requires-python") ?? null;
    for (const entry of tomlStringArray(document, "project.dependencies") ?? []) {
      const parsed = parseRequirementLine(entry);
      if (parsed === null) continue;
      if (packages.some((pkg) => pkg.name === parsed.name)) continue;
      packages.push({
        ecosystem: "python",
        manager,
        name: parsed.name,
        versionSpec: parsed.versionSpec,
        scope: "direct",
        source: "declared",
        evidenceRefs: [],
        declared: true,
      });
    }
    if (document.unparsed.length > 0) {
      gaps.push({
        area: "python.pyproject",
        reason: `${document.unparsed.length} pyproject.toml line(s) use TOML syntax IWOMC does not model; their contents are not treated as declared state.`,
        remediation: "Declare dependencies under [project] dependencies so they can be reconciled.",
      });
    }
  }

  if (await files.exists(UV_LOCK)) {
    declaredFiles.push(UV_LOCK);
    hasUvLock = true;
  }

  if (declaredFiles.length === 0) {
    gaps.push({
      area: "python.declaration",
      reason: "No requirements.txt or pyproject.toml: the repository does not declare Python dependencies.",
      remediation: "Add requirements.txt or a [project] dependencies table.",
    });
  }

  return { files: declaredFiles, packages, requiresPython, gaps, hasUvLock, hasPoetry, isPackage };
}


/** Distribution names a wheel requires, read from its dist-info METADATA. */
async function readDistributionRequirements(
  projectDir: string,
  venvDir: string,
  name: string,
  version: string,
): Promise<string[]> {
  const roots = [join(projectDir, venvDir, "Lib", "site-packages")];
  const libDir = join(projectDir, venvDir, "lib");
  try {
    for (const entry of await readdir(libDir)) roots.push(join(libDir, entry, "site-packages"));
  } catch {
    // POSIX layout absent.
  }
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    const match = entries.find(
      (entry) =>
        entry.endsWith(".dist-info") &&
        normalizePythonName(entry.slice(0, entry.lastIndexOf("-"))) === name &&
        entry.includes(`-${version}.dist-info`),
    );
    if (!match) continue;
    try {
      const metadata = await readFile(join(root, match, "METADATA"), "utf8");
      const required: string[] = [];
      for (const line of metadata.split(/\r?\n/u)) {
        if (!line.startsWith("Requires-Dist:")) continue;
        const body = line.slice("Requires-Dist:".length).trim();
        // Skip extras-gated requirements: they are not installed by default.
        if (/;\s*extra\s*==/u.test(body)) continue;
        const parsed = parseRequirementLine(body);
        if (parsed !== null) required.push(parsed.name);
      }
      return required;
    } catch {
      return [];
    }
  }
  return [];
}

function observeFromArgv(
  adapterId: string,
  manager: string,
  argv: readonly string[],
  exitCode: number | null,
): readonly ObservedEffect[] {
  const tokens = [...argv];
  const verbIndex = tokens.findIndex((token) => token === "install" || token === "add" || token === "uninstall" || token === "remove" || token === "sync");
  if (verbIndex === -1) return [];
  const verb = tokens[verbIndex] as string;
  const rest = tokens.slice(verbIndex + 1);
  const specs: { name: string; versionSpec: string }[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (token === "-r" || token === "--requirement") {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    const parsed = parseRequirementLine(token);
    if (parsed !== null) specs.push(parsed);
  }

  if (verb === "sync" || (specs.length === 0 && (verb === "install" || verb === "add"))) {
    return [
      {
        adapterId,
        kind: "environment_created",
        manager,
        packages: [],
        confidence: "high",
        summary: `${manager} ${verb} materialized the declared environment.`,
      },
    ];
  }
  if (verb === "install" || verb === "add") {
    return [
      {
        adapterId,
        kind: "package_added",
        manager,
        packages: specs,
        confidence: exitCode === 0 ? "high" : "low",
        summary: `${manager} ${verb} added ${specs.map((s) => s.name).join(", ")}.`,
      },
    ];
  }
  return [
    {
      adapterId,
      kind: "package_removed",
      manager,
      packages: specs,
      confidence: exitCode === 0 ? "high" : "low",
      summary: `${manager} ${verb} removed ${specs.map((s) => s.name).join(", ")}.`,
    },
  ];
}

abstract class PythonAdapterBase implements EnvironmentAdapter {
  abstract readonly manifest: AdapterManifest;
  protected abstract readonly managerName: "pip" | "uv";

  abstract detect(files: ProjectFiles): Promise<Detection>;

  async readDeclaredState(ctx: AdapterContext): Promise<DeclaredState> {
    const declaration = await readPythonDeclaration(ctx.files, this.managerName);
    const runtimes: RuntimeRequirement[] = [];
    if (declaration.requiresPython) {
      runtimes.push({
        runtime: "python",
        versionSpec: declaration.requiresPython,
        source: "declared",
      });
    } else {
      declaration.gaps.push({
        area: "python.runtime",
        reason: "No requires-python is declared, so the required interpreter version is unknown from source alone.",
        remediation: "Add requires-python to pyproject.toml, or let IWOMC propose one from the capturing machine.",
      });
    }
    const systemTools: SystemToolRequirement[] = [
      {
        name: this.managerName === "uv" ? "uv" : "python",
        probeArgv: this.managerName === "uv" ? ["uv", "--version"] : ["python", "--version"],
        source: "declared",
        installHint:
          this.managerName === "uv"
            ? "Install uv (https://docs.astral.sh/uv/) and make it available on PATH."
            : "Install a Python interpreter and make it available on PATH.",
      },
    ];
    const secrets: SecretRequirement[] = [];
    return {
      adapterId: this.manifest.id,
      files: declaration.files,
      runtimes,
      packages: declaration.packages,
      systemTools,
      secrets,
      gaps: declaration.gaps,
      lockedVersions: exactPins(declaration.packages),
    };
  }

  async inventory(ctx: AdapterContext): Promise<InventoryResult> {
    const installed = await readVenvDistributions(ctx.projectDir, VENV_DIR);
    if (installed === null) {
      return {
        adapterId: this.manifest.id,
        available: false,
        gaps: [
          {
            area: "python.inventory",
            reason: `No project-local ${VENV_DIR} was found, so installed distributions cannot be inventoried.`,
            remediation:
              "IWOMC inventories the project-local virtual environment only; packages installed into a global interpreter are outside its coverage.",
          },
        ],
      };
    }
    const entries = [...installed.entries()]
      .map(([name, version]) => ({ name, version }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return {
      adapterId: this.manifest.id,
      available: true,
      snapshot: {
        adapterId: this.manifest.id,
        manager: this.managerName,
        takenAt: new Date().toISOString(),
        entryCount: entries.length,
        digest: digestOf(entries),
        entries,
      },
      gaps: [],
    };
  }

  observeProcess(process: ObservedProcess): readonly ObservedEffect[] {
    const [executable] = process.argv;
    if (executable === undefined) return [];
    const base = executable.replace(/\.(exe|cmd)$/iu, "").split(/[\\/]/u).pop() ?? "";
    if (this.managerName === "uv") {
      if (base !== "uv") return [];
      return observeFromArgv(this.manifest.id, "uv", process.argv.slice(1), process.exitCode);
    }
    const isPip = base === "pip" || base === "pip3";
    const isPythonModulePip =
      (base === "python" || base === "python3") && process.argv[1] === "-m" && process.argv[2] === "pip";
    if (!isPip && !isPythonModulePip) return [];
    const rest = isPip ? process.argv.slice(1) : process.argv.slice(3);
    return observeFromArgv(this.manifest.id, "pip", rest, process.exitCode);
  }

  /**
   * Undeclared direct installs, derived from the project-local .venv alone.
   * A distribution counts only when nothing declared requires it, so ordinary
   * transitive dependencies are not mistaken for an agent's addition.
   */
  async deriveObservedEffects(ctx: AdapterContext): Promise<readonly ObservedEffect[]> {
    const declaration = await readPythonDeclaration(ctx.files, this.managerName);
    const installed = await readVenvDistributions(ctx.projectDir, VENV_DIR);
    if (installed === null) return [];

    const declared = new Set(declaration.packages.map((pkg) => pkg.name));
    const reachable = new Set<string>();
    const queue = [...declared];
    while (queue.length > 0) {
      const name = queue.pop() as string;
      if (reachable.has(name)) continue;
      reachable.add(name);
      const version = installed.get(name);
      if (version === undefined) continue;
      for (const dependency of await readDistributionRequirements(
        ctx.projectDir,
        VENV_DIR,
        name,
        version,
      )) {
        if (!reachable.has(dependency) && installed.has(dependency)) queue.push(dependency);
      }
    }

    const undeclared = [...installed.keys()]
      .filter((name) => !declared.has(name) && !reachable.has(name) && !BOOTSTRAP_DISTRIBUTIONS.has(name))
      .sort();
    if (undeclared.length === 0) return [];

    return [
      {
        adapterId: this.manifest.id,
        kind: "package_added",
        manager: this.managerName,
        packages: undeclared.map((name) => ({
          name,
          versionSpec: `==${installed.get(name) ?? "0"}`,
        })),
        confidence: "high",
        summary: `${VENV_DIR} contains ${undeclared.length} distribution(s) the repository does not declare and no declared dependency requires: ${undeclared.slice(0, 8).join(", ")}.`,
      },
    ];
  }

  compile(bundle: EvidenceBundle): CompileResult {
    const declared = bundle.declared;
    const declaredNames = new Set(declared.packages.map((pkg) => pkg.name));
    const installed = new Map(
      (bundle.inventoryAfter?.entries ?? []).map((entry) => [entry.name, entry.version]),
    );

    const coverage: CoverageGap[] = [...declared.gaps];
    const packages: PackageRequirement[] = [...declared.packages];
    const drift: ContractDrift[] = [];
    const overlay: { name: string; versionSpec: string; evidenceRefs: string[] }[] = [];

    for (const effect of bundle.observed) {
      if (effect.adapterId !== this.manifest.id || effect.kind !== "package_added") continue;
      for (const observedPackage of effect.packages) {
        const name = normalizePythonName(observedPackage.name);
        if (declaredNames.has(name)) continue;
        if (overlay.some((entry) => entry.name === name)) continue;
        const installedVersion = installed.get(name);
        const versionSpec =
          installedVersion && installedVersion.length > 0
            ? `==${pinExact(installedVersion)}`
            : observedPackage.versionSpec;
        const evidenceRefs = bundle.evidence
          .filter((item) => item.summary.includes(observedPackage.name))
          .map((item) => item.id);
        overlay.push({ name, versionSpec, evidenceRefs });
        packages.push({
          ecosystem: "python",
          manager: this.managerName,
          name,
          versionSpec,
          scope: "direct",
          source: "observed",
          evidenceRefs,
          declared: false,
        });
        drift.push({
          adapterId: this.manifest.id,
          kind: "undeclared_package",
          summary: `${name}${versionSpec.startsWith("==") ? versionSpec : `@${versionSpec}`} was installed here but the repository does not declare it.`,
          evidenceRefs,
          affectedDeclaration: declared.files.includes(REQUIREMENTS) ? REQUIREMENTS : PYPROJECT,
          proposedRepair: null,
        });
      }
    }

    // A distribution the repository *does* declare, at a version the
    // repository would not install. `pip install --no-deps other==1.0` leaves
    // exactly this: the file still says one thing, the environment is another,
    // and a teammate installing from the file gets something that differs.
    const locked = declared.lockedVersions ?? {};
    for (const [name, installedVersion] of installed) {
      if (!declaredNames.has(name)) continue;
      const lockedVersion = locked[name];
      if (lockedVersion === undefined || lockedVersion === installedVersion) continue;
      if (overlay.some((entry) => entry.name === name)) continue;

      const versionSpec = `==${pinExact(installedVersion)}`;
      const evidenceRefs = bundle.evidence
        .filter((item) => item.summary.includes(name))
        .map((item) => item.id);

      overlay.push({ name, versionSpec, evidenceRefs });

      // Replace the declared requirement rather than adding a second one for
      // the same distribution.
      const existing = packages.findIndex((entry) => entry.name === name);
      const requirement = {
        ecosystem: "python" as const,
        manager: this.managerName,
        name,
        versionSpec,
        scope: "direct" as const,
        source: "observed" as const,
        evidenceRefs,
        declared: true,
      };
      if (existing === -1) packages.push(requirement);
      else packages[existing] = requirement;
      drift.push({
        adapterId: this.manifest.id,
        kind: "version_mismatch",
        summary: `${name} is installed here at ${installedVersion}, but the repository pins ${lockedVersion}. A fresh install elsewhere would produce ${lockedVersion}.`,
        evidenceRefs,
        affectedDeclaration: declared.files.includes(REQUIREMENTS) ? REQUIREMENTS : PYPROJECT,
        proposedRepair: null,
      });
    }

    const runtimes: RuntimeRequirement[] = [...declared.runtimes];
    if (runtimes.length === 0) {
      const observed = bundle.evidence.find(
        (item) => item.kind === "runtime_fingerprint" && item.summary.startsWith("python "),
      );
      if (observed) {
        const version = observed.summary.slice("python ".length).trim();
        const [major, minor] = version.split(".");
        runtimes.push({
          runtime: "python",
          versionSpec: `>=${major ?? "3"}.${minor ?? "0"}`,
          observedVersion: version,
          source: "derived",
        });
        drift.push({
          adapterId: this.manifest.id,
          kind: "runtime_pin_missing",
          summary: `No requires-python is declared; this machine ran Python ${version}.`,
          evidenceRefs: [observed.id],
          affectedDeclaration: PYPROJECT,
          proposedRepair: null,
        });
      }
    }

    const steps = this.buildSteps(bundle, declared.files, overlay, runtimes);

    return {
      adapterId: this.manifest.id,
      support: "native",
      runtimes,
      packages,
      systemTools: declared.systemTools,
      secrets: declared.secrets,
      steps,
      coverage,
      drift,
    };
  }

  protected abstract buildSteps(
    bundle: EvidenceBundle,
    declaredFiles: readonly string[],
    overlay: readonly { name: string; versionSpec: string; evidenceRefs: string[] }[],
    runtimes: readonly RuntimeRequirement[],
  ): MaterializationStep[];

  async preflight(
    ctx: MaterializationContext,
    steps: readonly MaterializationStep[],
  ): Promise<PreflightResult> {
    const issues: PreflightIssue[] = [];
    const owned = steps.filter((step) => step.adapterId === this.manifest.id);
    if (owned.length === 0) return { adapterId: this.manifest.id, issues };

    const toolProbe = this.managerName === "uv" ? ["uv", "--version"] : ["python", "--version"];
    const probe = await ctx.probe(toolProbe, { timeoutMs: 30_000 });
    if (!probe.ok) {
      issues.push({
        code: "missing_system_tool",
        message: `${toolProbe[0]} is not available on PATH.`,
        nextAction:
          this.managerName === "uv"
            ? "Install uv and make it available on PATH, then run rescue again."
            : "Install a Python interpreter and make it available on PATH, then run rescue again.",
      });
      return { adapterId: this.manifest.id, issues };
    }

    for (const step of owned) {
      if (step.kind !== "ensure_runtime") continue;
      const runtimeProbe = await ctx.probe(step.probeArgv, { timeoutMs: 30_000 });
      if (!runtimeProbe.ok) {
        issues.push({
          code: "missing_runtime",
          message: `${step.runtime} is not available on PATH.`,
          nextAction: `Install ${step.runtime} ${step.versionSpec}.`,
        });
        continue;
      }
      const version = extractPythonVersion(`${runtimeProbe.stdout} ${runtimeProbe.stderr}`);
      if (version === null) continue;
      if (satisfies(version, step.versionSpec) === "unsatisfied") {
        issues.push({
          code: "missing_runtime",
          message: `${step.runtime} ${version} does not satisfy ${step.versionSpec}.`,
          nextAction: `Install ${step.runtime} ${step.versionSpec}.`,
        });
      }
    }
    return { adapterId: this.manifest.id, issues };
  }

  abstract planCommand(step: MaterializationStep, ctx: MaterializationContext): CommandPlan | null;

  async verifyAfterMaterialize(ctx: MaterializationContext): Promise<AdapterVerification> {
    const declaration = await readPythonDeclaration(ctx.files, this.managerName);
    const installed = await readVenvDistributions(ctx.projectDir, VENV_DIR);
    if (installed === null) {
      return {
        adapterId: this.manifest.id,
        satisfied: false,
        checks: [
          {
            name: "project-local environment present",
            passed: false,
            detail: `${VENV_DIR} was not created.`,
          },
        ],
      };
    }
    const missing = declaration.packages
      .map((pkg) => pkg.name)
      .filter((name) => !installed.has(name));
    return {
      adapterId: this.manifest.id,
      satisfied: missing.length === 0,
      checks: [
        {
          name: "declared distributions installed",
          passed: missing.length === 0,
          detail:
            missing.length === 0
              ? `${declaration.packages.length} declared distribution${
                  declaration.packages.length === 1 ? "" : "s"
                } present in ${VENV_DIR}.`
              : `missing from ${VENV_DIR}: ${missing.slice(0, 10).join(", ")}`,
        },
      ],
    };
  }

  async proposeRepair(
    bundle: EvidenceBundle,
    finding: ContractDrift,
    pending?: ReadonlyMap<string, string>,
  ): Promise<readonly ProposedFileChange[]> {
    if (finding.kind !== "undeclared_package") return [];
    const match = /^(\S+?)(==\S+|@\S+)\s/u.exec(`${finding.summary} `);
    if (!match) return [];
    const name = match[1] as string;
    const spec = (match[2] as string).startsWith("==")
      ? (match[2] as string)
      : `==${(match[2] as string).slice(1)}`;

    const target = finding.affectedDeclaration;
    let before: string | null = null;
    try {
      before = await readFile(join(bundle.projectDir, target), "utf8");
    } catch {
      before = null;
    }

    if (target === REQUIREMENTS) {
      // Build on any edit an earlier finding already proposed for this file.
      const body = pending?.get(target) ?? before ?? "";
      const lines = body.split("\n");
      const trailingBlank = lines.length > 0 && lines[lines.length - 1] === "";
      const content = trailingBlank ? lines.slice(0, -1) : lines;
      content.push(`${name}${spec}`);
      content.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
      const after = `${content.join("\n")}\n`;
      return [
        { path: target, before, after, unifiedDiff: unifiedDiff(target, before ?? "", after) },
      ];
    }
    return [];
  }
}

function extractPythonVersion(text: string): string | null {
  const match = /Python\s+(\d+\.\d+(?:\.\d+)?)/u.exec(text);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// pip
// ---------------------------------------------------------------------------

export class PipAdapter extends PythonAdapterBase {
  protected readonly managerName = "pip" as const;

  readonly manifest: AdapterManifest = {
    id: "python.pip",
    ecosystem: "python",
    manager: "pip",
    support: "native",
    declaredFiles: [REQUIREMENTS, PYPROJECT],
    capabilities: {
      detect: true,
      readDeclaredState: true,
      inventory: true,
      compile: true,
      materialize: true,
      verify: true,
    },
    conformanceTested: true,
    supportNote:
      "Reads requirements.txt and [project] dependencies, inventories the project-local .venv without running a command, creates .venv and installs with pip, and verifies the installed distributions.",
  };

  async detect(files: ProjectFiles): Promise<Detection> {
    if (await files.exists(UV_LOCK)) {
      return {
        detected: false,
        signals: [UV_LOCK],
        confidence: "low",
        note: "uv.lock is present, so the uv adapter owns this project.",
      };
    }
    const signals: string[] = [];
    if (await files.exists(REQUIREMENTS)) signals.push(REQUIREMENTS);
    if (await files.exists(PYPROJECT)) signals.push(PYPROJECT);
    if (signals.length === 0) return { detected: false, signals, confidence: "low" };

    const pyproject = await files.read(PYPROJECT);
    if (pyproject !== null) {
      const document = parseToml(pyproject);
      if (tomlGet(document, "tool.uv") !== undefined) {
        return {
          detected: false,
          signals,
          confidence: "low",
          note: "pyproject.toml configures uv, so the uv adapter owns this project.",
        };
      }
      if (tomlGet(document, "tool.poetry") !== undefined) {
        return {
          detected: false,
          signals,
          confidence: "low",
          note: "pyproject.toml configures Poetry, which IWOMC recognises but does not natively materialize.",
        };
      }
    }
    return {
      detected: true,
      signals,
      confidence: signals.includes(REQUIREMENTS) ? "high" : "medium",
    };
  }

  protected buildSteps(
    _bundle: EvidenceBundle,
    declaredFiles: readonly string[],
    overlay: readonly { name: string; versionSpec: string; evidenceRefs: string[] }[],
    runtimes: readonly RuntimeRequirement[],
  ): MaterializationStep[] {
    const steps: MaterializationStep[] = [];
    for (const runtime of runtimes) {
      steps.push({
        id: `${this.manifest.id}:runtime:${runtime.runtime}`,
        kind: "ensure_runtime",
        adapterId: this.manifest.id,
        workDir: ".",
        idempotencyKey: `py-runtime-${digestOf(runtime.versionSpec).slice(7, 23)}`,
        description: `Python ${runtime.versionSpec} must be available on PATH.`,
        runtime: runtime.runtime,
        versionSpec: runtime.versionSpec,
        strategy: "probe",
        probeArgv: ["python", "--version"],
      });
    }
    steps.push({
      id: `${this.manifest.id}:venv`,
      kind: "create_virtual_environment",
      adapterId: this.manifest.id,
      workDir: ".",
      idempotencyKey: `py-venv-${VENV_DIR}`,
      description: `Create the project-local virtual environment in ${VENV_DIR}.`,
      manager: "venv",
      path: VENV_DIR,
      runtimeSpec: runtimes[0]?.versionSpec ?? "*",
    });
    if (declaredFiles.includes(REQUIREMENTS)) {
      steps.push({
        id: `${this.manifest.id}:install`,
        kind: "install_project_dependencies",
        adapterId: this.manifest.id,
        workDir: ".",
        idempotencyKey: `pip-install-${digestOf(declaredFiles).slice(7, 27)}`,
        description: "Install the declared requirements into the project-local virtual environment.",
        manager: "pip",
        manifest: REQUIREMENTS,
        frozen: false,
        timeoutMs: 900_000,
      });
    }
    if (overlay.length > 0) {
      steps.push({
        id: `${this.manifest.id}:overlay`,
        kind: "apply_package_overlay",
        adapterId: this.manifest.id,
        workDir: ".",
        idempotencyKey: `pip-overlay-${digestOf(overlay).slice(7, 27)}`,
        description: `Install ${overlay.length} distribution${
          overlay.length === 1 ? "" : "s"
        } the evidence shows were used but the repository does not declare. No tracked file is modified.`,
        manager: "pip",
        packages: overlay.map((entry) => ({
          name: entry.name,
          versionSpec: entry.versionSpec,
          evidenceRefs: entry.evidenceRefs.length > 0 ? entry.evidenceRefs : ["observed-process"],
        })),
        timeoutMs: 900_000,
      });
    }
    return steps;
  }

  planCommand(step: MaterializationStep, ctx: MaterializationContext): CommandPlan | null {
    if (step.adapterId !== this.manifest.id) return null;
    const os = ctx.platform.os;
    const python = venvBin(VENV_DIR, "python", os);
    const env = { PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_CACHE_DIR: `${ctx.managedDir}/pip-cache` };
    if (step.kind === "create_virtual_environment") {
      return {
        argv: ["python", "-m", "venv", step.path],
        workDir: step.workDir,
        env: {},
        timeoutMs: 300_000,
        expectedExitCodes: [0],
      };
    }
    if (step.kind === "install_project_dependencies") {
      return {
        argv: [python, "-m", "pip", "install", "-r", step.manifest],
        workDir: step.workDir,
        env,
        timeoutMs: step.timeoutMs,
        expectedExitCodes: [0],
      };
    }
    if (step.kind === "apply_package_overlay") {
      return {
        argv: [
          python,
          "-m",
          "pip",
          "install",
          ...step.packages.map((pkg) =>
            pkg.versionSpec === "*" ? pkg.name : `${pkg.name}${normalizeSpec(pkg.versionSpec)}`,
          ),
        ],
        workDir: step.workDir,
        env,
        timeoutMs: step.timeoutMs,
        expectedExitCodes: [0],
      };
    }
    return null;
  }
}

function normalizeSpec(versionSpec: string): string {
  return /^[<>=!~]/u.test(versionSpec) ? versionSpec : `==${versionSpec}`;
}

// ---------------------------------------------------------------------------
// uv
// ---------------------------------------------------------------------------

export class UvAdapter extends PythonAdapterBase {
  protected readonly managerName = "uv" as const;

  readonly manifest: AdapterManifest = {
    id: "python.uv",
    ecosystem: "python",
    manager: "uv",
    support: "native",
    declaredFiles: [PYPROJECT, UV_LOCK, REQUIREMENTS],
    capabilities: {
      detect: true,
      readDeclaredState: true,
      inventory: true,
      compile: true,
      materialize: true,
      verify: true,
    },
    conformanceTested: true,
    supportNote:
      "Reads pyproject.toml and uv.lock, inventories the project-local .venv without running a command, syncs the locked environment with uv, and verifies the installed distributions.",
  };

  async detect(files: ProjectFiles): Promise<Detection> {
    const signals: string[] = [];
    if (await files.exists(UV_LOCK)) signals.push(UV_LOCK);
    const pyproject = await files.read(PYPROJECT);
    if (pyproject !== null) {
      const document = parseToml(pyproject);
      if (tomlGet(document, "tool.uv") !== undefined) signals.push(`${PYPROJECT}#tool.uv`);
      if (signals.length > 0) signals.push(PYPROJECT);
    }
    if (signals.length === 0) return { detected: false, signals, confidence: "low" };
    return { detected: true, signals, confidence: signals.includes(UV_LOCK) ? "high" : "medium" };
  }

  protected buildSteps(
    _bundle: EvidenceBundle,
    declaredFiles: readonly string[],
    overlay: readonly { name: string; versionSpec: string; evidenceRefs: string[] }[],
    runtimes: readonly RuntimeRequirement[],
  ): MaterializationStep[] {
    const steps: MaterializationStep[] = [];
    steps.push({
      id: `${this.manifest.id}:tool`,
      kind: "ensure_system_tool",
      adapterId: this.manifest.id,
      workDir: ".",
      idempotencyKey: "uv-tool-present",
      description: "uv must be available on PATH.",
      tool: "uv",
      probeArgv: ["uv", "--version"],
      installHint: "Install uv from https://docs.astral.sh/uv/ and make it available on PATH.",
    });
    const frozen = declaredFiles.includes(UV_LOCK);
    steps.push({
      id: `${this.manifest.id}:sync`,
      kind: "install_project_dependencies",
      adapterId: this.manifest.id,
      workDir: ".",
      idempotencyKey: `uv-sync-${digestOf({ declaredFiles, runtimes }).slice(7, 27)}`,
      description: frozen
        ? "Sync the project-local environment to uv.lock exactly."
        : "Resolve and sync the project-local environment with uv (no uv.lock is committed).",
      manager: "uv",
      manifest: PYPROJECT,
      ...(frozen ? { lockfile: UV_LOCK } : {}),
      frozen,
      timeoutMs: 900_000,
    });
    if (overlay.length > 0) {
      steps.push({
        id: `${this.manifest.id}:overlay`,
        kind: "apply_package_overlay",
        adapterId: this.manifest.id,
        workDir: ".",
        idempotencyKey: `uv-overlay-${digestOf(overlay).slice(7, 27)}`,
        description: `Install ${overlay.length} distribution${
          overlay.length === 1 ? "" : "s"
        } the evidence shows were used but the repository does not declare. pyproject.toml and uv.lock are not modified.`,
        manager: "uv",
        packages: overlay.map((entry) => ({
          name: entry.name,
          versionSpec: entry.versionSpec,
          evidenceRefs: entry.evidenceRefs.length > 0 ? entry.evidenceRefs : ["observed-process"],
        })),
        timeoutMs: 900_000,
      });
    }
    return steps;
  }

  planCommand(step: MaterializationStep, ctx: MaterializationContext): CommandPlan | null {
    if (step.adapterId !== this.manifest.id) return null;
    const env = { UV_CACHE_DIR: `${ctx.managedDir}/uv-cache`, UV_NO_PROGRESS: "1" };
    if (step.kind === "install_project_dependencies") {
      return {
        argv: step.frozen ? ["uv", "sync", "--frozen"] : ["uv", "sync"],
        workDir: step.workDir,
        env,
        timeoutMs: step.timeoutMs,
        expectedExitCodes: [0],
      };
    }
    if (step.kind === "apply_package_overlay") {
      return {
        // `uv pip install` writes into the project-local .venv without
        // touching pyproject.toml or uv.lock.
        argv: [
          "uv",
          "pip",
          "install",
          ...step.packages.map((pkg) =>
            pkg.versionSpec === "*" ? pkg.name : `${pkg.name}${normalizeSpec(pkg.versionSpec)}`,
          ),
        ],
        workDir: step.workDir,
        env,
        timeoutMs: step.timeoutMs,
        expectedExitCodes: [0],
      };
    }
    return null;
  }
}

export const pipAdapter = new PipAdapter();
export const uvAdapter = new UvAdapter();
export { VENV_DIR, REQUIREMENTS, PYPROJECT, UV_LOCK };

/**
 * Exact versions the repository would install, from declared pins.
 *
 * Python has no universal lockfile, but `name==1.2.3` in requirements.txt says
 * the same thing a lockfile entry does: install this and nothing else. A range
 * like `>=1.0` is deliberately excluded - it is satisfied by many versions, so
 * comparing an installed tree against it would report healthy projects as
 * broken.
 */
export function exactPins(
  packages: readonly { name: string; versionSpec: string }[],
): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const entry of packages) {
    const match = /^==\s*([^\s,;]+)$/u.exec(entry.versionSpec.trim());
    if (match) pins[entry.name] = (match[1] as string).trim();
  }
  return pins;
}

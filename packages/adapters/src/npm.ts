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
import { satisfies, pinExact } from "./semver.js";
import { unifiedDiff } from "./diff.js";

const ADAPTER_ID = "node.npm";
const MANIFEST = "package.json";
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"] as const;
/** Lockfiles owned by a different Node package manager. */
const FOREIGN_LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"] as const;

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly engines?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly packageManager?: string;
  readonly scripts?: Record<string, string>;
}

async function readManifest(files: ProjectFiles): Promise<PackageManifest | null> {
  const raw = await files.read(MANIFEST);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as PackageManifest;
  } catch {
    return null;
  }
}

function dependencyEntries(manifest: PackageManifest): Array<[string, string, boolean]> {
  const out: Array<[string, string, boolean]> = [];
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) out.push([name, spec, true]);
  for (const [name, spec] of Object.entries(manifest.devDependencies ?? {})) out.push([name, spec, true]);
  for (const [name, spec] of Object.entries(manifest.optionalDependencies ?? {})) {
    out.push([name, spec, false]);
  }
  return out;
}

/**
 * Read installed top-level packages straight from `node_modules`. This is a
 * filesystem read, not a package-manager invocation: detection and inventory
 * must never execute a command (R11.3 verification).
 */
async function readInstalled(projectDir: string): Promise<Map<string, string> | null> {
  const root = join(projectDir, "node_modules");
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return null;
  }
  const installed = new Map<string, string>();
  for (const entry of names) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      let scoped: string[];
      try {
        scoped = await readdir(join(root, entry));
      } catch {
        continue;
      }
      for (const inner of scoped) {
        const version = await readInstalledVersion(join(root, entry, inner));
        if (version !== null) installed.set(`${entry}/${inner}`, version);
      }
      continue;
    }
    const version = await readInstalledVersion(join(root, entry));
    if (version !== null) installed.set(entry, version);
  }
  return installed;
}

async function readInstalledVersion(dir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(dir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : "";
  } catch {
    return null;
  }
}


/** Direct dependency names of an installed package, for reachability. */
async function readPackageDependencies(projectDir: string, name: string): Promise<string[]> {
  try {
    const raw = await readFile(join(projectDir, "node_modules", ...name.split("/"), "package.json"), "utf8");
    const parsed = JSON.parse(raw) as PackageManifest;
    return [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.optionalDependencies ?? {}),
      ...Object.keys(parsed.peerDependencies ?? {}),
    ];
  } catch {
    return [];
  }
}

const INSTALL_VERBS = new Set(["install", "i", "add", "in", "ins", "isntall"]);
const REMOVE_VERBS = new Set(["uninstall", "remove", "rm", "r", "un"]);

export class NpmAdapter implements EnvironmentAdapter {
  readonly manifest = {
    id: ADAPTER_ID,
    ecosystem: "node",
    manager: "npm",
    support: "native" as const,
    declaredFiles: [MANIFEST, ...LOCKFILES],
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
      "Reads package.json and package-lock.json, inventories node_modules without running a command, installs project-local dependencies with npm, and verifies the result.",
  };

  async detect(files: ProjectFiles): Promise<Detection> {
    const manifest = await readManifest(files);
    if (manifest === null) {
      return { detected: false, signals: [], confidence: "low" };
    }
    const signals = [MANIFEST];
    for (const lockfile of LOCKFILES) {
      if (await files.exists(lockfile)) signals.push(lockfile);
    }
    const foreign: string[] = [];
    for (const lockfile of FOREIGN_LOCKFILES) {
      if (await files.exists(lockfile)) foreign.push(lockfile);
    }
    if (foreign.length > 0 && signals.length === 1) {
      return {
        detected: false,
        signals,
        confidence: "low",
        note: `package.json is present but ${foreign.join(", ")} indicates a different Node package manager owns this project.`,
      };
    }
    return {
      detected: true,
      signals,
      confidence: signals.length > 1 ? "high" : "medium",
      note:
        signals.length === 1
          ? "No npm lockfile: installs cannot be pinned to exact resolved versions."
          : undefined,
    };
  }

  async readDeclaredState(ctx: AdapterContext): Promise<DeclaredState> {
    const manifest = await readManifest(ctx.files);
    const gaps: CoverageGap[] = [];
    const runtimes: RuntimeRequirement[] = [];
    const packages: PackageRequirement[] = [];
    const systemTools: SystemToolRequirement[] = [];
    const secrets: SecretRequirement[] = [];
    const declaredFiles: string[] = [];

    if (manifest === null) {
      gaps.push({
        area: "node.manifest",
        reason: "package.json is missing or is not valid JSON.",
        remediation: "Fix package.json so the declared dependency set can be read.",
      });
      return { adapterId: ADAPTER_ID, files: declaredFiles, runtimes, packages, systemTools, secrets, gaps };
    }
    declaredFiles.push(MANIFEST);

    const nodeEngine = manifest.engines?.["node"];
    if (typeof nodeEngine === "string" && nodeEngine.trim().length > 0) {
      runtimes.push({ runtime: "node", versionSpec: nodeEngine, source: "declared" });
    } else {
      gaps.push({
        area: "node.runtime",
        reason: "package.json does not declare engines.node, so the required Node version is unknown from source alone.",
        remediation: "Add an engines.node range, or let IWOMC propose one from the capturing machine.",
      });
    }

    for (const [name, spec, required] of dependencyEntries(manifest)) {
      packages.push({
        ecosystem: "node",
        manager: "npm",
        name,
        versionSpec: spec,
        scope: "direct",
        source: "declared",
        evidenceRefs: [],
        declared: true,
      });
      if (!required) {
        gaps.push({
          area: `node.optional:${name}`,
          reason: `${name} is optional; its absence is not treated as drift.`,
        });
      }
    }

    let lockfile: string | null = null;
    let lockedVersions: Record<string, string> = {};
    for (const candidate of LOCKFILES) {
      if (await ctx.files.exists(candidate)) {
        lockfile = candidate;
        declaredFiles.push(candidate);
        lockedVersions = parseLockedVersions(await ctx.files.read(candidate));
        break;
      }
    }
    if (lockfile === null) {
      gaps.push({
        area: "node.lockfile",
        reason: "No package-lock.json: transitive versions are not pinned by the repository.",
        remediation: "Commit a lockfile so a rescue can install the exact resolved tree.",
      });
    }

    systemTools.push({
      name: "npm",
      probeArgv: ["npm", "--version"],
      source: "declared",
      installHint: "npm ships with Node.js. Install a Node runtime that matches the contract.",
    });

    return {
      adapterId: ADAPTER_ID,
      files: declaredFiles,
      runtimes,
      packages,
      systemTools,
      secrets,
      gaps,
      lockedVersions,
    };
  }

  async inventory(ctx: AdapterContext): Promise<InventoryResult> {
    const installed = await readInstalled(ctx.projectDir);
    if (installed === null) {
      return {
        adapterId: ADAPTER_ID,
        available: false,
        gaps: [
          {
            area: "node.inventory",
            reason: "node_modules is not present, so installed packages cannot be inventoried.",
            remediation: "Run the project's install command, then capture again.",
          },
        ],
      };
    }
    const entries = [...installed.entries()]
      .map(([name, version]) => ({ name, version }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return {
      adapterId: ADAPTER_ID,
      available: true,
      snapshot: {
        adapterId: ADAPTER_ID,
        manager: "npm",
        takenAt: new Date().toISOString(),
        entryCount: entries.length,
        digest: digestOf(entries),
        entries,
      },
      gaps: [],
    };
  }

  observeProcess(process: ObservedProcess): readonly ObservedEffect[] {
    const [executable, ...rest] = process.argv;
    if (executable === undefined) return [];
    const base = executable.replace(/\.(cmd|exe|ps1)$/iu, "").split(/[\\/]/u).pop();
    if (base !== "npm" && base !== "npx") return [];
    const verb = rest.find((token) => !token.startsWith("-"));
    if (verb === undefined) return [];

    const args = rest.slice(rest.indexOf(verb) + 1).filter((token) => !token.startsWith("-"));
    const packages = args
      .map((token) => parseSpecifier(token))
      .filter((entry): entry is { name: string; versionSpec: string } => entry !== null);

    if (INSTALL_VERBS.has(verb)) {
      if (packages.length === 0) {
        return [
          {
            adapterId: ADAPTER_ID,
            kind: "environment_created",
            manager: "npm",
            packages: [],
            confidence: "high",
            summary: "npm installed the declared dependency tree.",
          },
        ];
      }
      return [
        {
          adapterId: ADAPTER_ID,
          kind: "package_added",
          manager: "npm",
          packages,
          confidence: process.exitCode === 0 ? "high" : "low",
          summary: `npm ${verb} added ${packages.map((p) => p.name).join(", ")}.`,
        },
      ];
    }
    if (REMOVE_VERBS.has(verb) && packages.length > 0) {
      return [
        {
          adapterId: ADAPTER_ID,
          kind: "package_removed",
          manager: "npm",
          packages,
          confidence: process.exitCode === 0 ? "high" : "low",
          summary: `npm ${verb} removed ${packages.map((p) => p.name).join(", ")}.`,
        },
      ];
    }
    return [
      {
        adapterId: ADAPTER_ID,
        kind: "unknown_action",
        manager: "npm",
        packages: [],
        confidence: "low",
        summary: `npm ${verb} ran; IWOMC does not model its effect on installed packages.`,
      },
    ];
  }

  /**
   * Undeclared direct installs, derived from node_modules alone.
   *
   * A package is treated as directly installed here when it is present in
   * node_modules, absent from package.json, and reachable from no declared
   * package's dependency graph. That last condition is what stops a normal
   * transitive dependency from being mistaken for something an agent added.
   */
  async deriveObservedEffects(ctx: AdapterContext): Promise<readonly ObservedEffect[]> {
    const manifest = await readManifest(ctx.files);
    const installed = await readInstalled(ctx.projectDir);
    if (manifest === null || installed === null) return [];

    const declared = new Set(dependencyEntries(manifest).map(([name]) => name));
    for (const name of Object.keys(manifest.peerDependencies ?? {})) declared.add(name);

    const reachable = new Set<string>();
    const queue = [...declared];
    while (queue.length > 0) {
      const name = queue.pop() as string;
      if (reachable.has(name)) continue;
      reachable.add(name);
      for (const dependency of await readPackageDependencies(ctx.projectDir, name)) {
        if (!reachable.has(dependency) && installed.has(dependency)) queue.push(dependency);
      }
    }

    const undeclared = [...installed.keys()]
      .filter((name) => !declared.has(name) && !reachable.has(name))
      .sort();
    if (undeclared.length === 0) return [];

    return [
      {
        adapterId: ADAPTER_ID,
        kind: "package_added",
        manager: "npm",
        packages: undeclared.map((name) => ({
          name,
          versionSpec: installed.get(name) ?? "*",
        })),
        confidence: "high",
        summary: `node_modules contains ${undeclared.length} package(s) that package.json does not declare and no declared dependency requires: ${undeclared.slice(0, 8).join(", ")}.`,
      },
    ];
  }

  compile(bundle: EvidenceBundle): CompileResult {
    const declared = bundle.declared;
    const declaredNames = new Map(declared.packages.map((pkg) => [pkg.name, pkg]));
    const installed = new Map(
      (bundle.inventoryAfter?.entries ?? []).map((entry) => [entry.name, entry.version]),
    );

    const coverage: CoverageGap[] = [...declared.gaps];
    const packages: PackageRequirement[] = [...declared.packages];
    const drift: ContractDrift[] = [];
    const overlay: { name: string; versionSpec: string; evidenceRefs: string[] }[] = [];

    // Packages an agent actually installed here that the repository never
    // declares. Only direct, process-correlated evidence counts; a package
    // merely present in node_modules is transitive until proven otherwise.
    for (const effect of bundle.observed) {
      if (effect.adapterId !== ADAPTER_ID || effect.kind !== "package_added") continue;
      for (const observedPackage of effect.packages) {
        if (declaredNames.has(observedPackage.name)) continue;
        const installedVersion = installed.get(observedPackage.name);
        const versionSpec =
          installedVersion && installedVersion.length > 0
            ? pinExact(installedVersion)
            : observedPackage.versionSpec;
        const evidenceRefs = bundle.evidence
          .filter((item) => item.summary.includes(observedPackage.name))
          .map((item) => item.id);
        if (overlay.some((entry) => entry.name === observedPackage.name)) continue;
        overlay.push({ name: observedPackage.name, versionSpec, evidenceRefs });
        packages.push({
          ecosystem: "node",
          manager: "npm",
          name: observedPackage.name,
          versionSpec,
          scope: "direct",
          source: "observed",
          evidenceRefs,
          declared: false,
        });
        drift.push({
          adapterId: ADAPTER_ID,
          kind: "undeclared_package",
          summary: `${observedPackage.name}@${versionSpec} was installed here but package.json does not declare it.`,
          evidenceRefs,
          affectedDeclaration: MANIFEST,
          proposedRepair: null,
        });
      }
    }

    // A package the repository *does* declare, sitting at a version the
    // repository would not install. This is what `npm install --no-save x@old`
    // leaves behind, and it is the case a plain snapshot of "what is declared"
    // misses completely: the teammate's `npm ci` gives them the locked version,
    // this machine runs something else, and only one of them works.
    //
    // The comparison is against the lockfile, never the version range. A range
    // is satisfied by many versions, so comparing against it would report
    // healthy projects as broken.
    const locked = declared.lockedVersions ?? {};
    for (const [name, installedVersion] of installed) {
      if (!declaredNames.has(name)) continue;
      const lockedVersion = locked[name];
      if (lockedVersion === undefined || lockedVersion === installedVersion) continue;
      if (overlay.some((entry) => entry.name === name)) continue;

      const versionSpec = pinExact(installedVersion);
      const evidenceRefs = bundle.evidence
        .filter((item) => item.summary.includes(name))
        .map((item) => item.id);

      overlay.push({ name, versionSpec, evidenceRefs });

      // Replace the declared requirement rather than adding a second one for
      // the same package. A contract that listed both would be asking for two
      // different versions of one thing.
      const existing = packages.findIndex((entry) => entry.name === name);
      const requirement = {
        ecosystem: "node" as const,
        manager: "npm",
        name,
        versionSpec,
        scope: "direct" as const,
        source: "observed" as const,
        evidenceRefs,
        // It *is* declared - just not at this version. Saying otherwise would
        // send a promotion down the wrong path.
        declared: true,
      };
      if (existing === -1) packages.push(requirement);
      else packages[existing] = requirement;
      drift.push({
        adapterId: ADAPTER_ID,
        kind: "version_mismatch",
        summary: `${name} is installed here at ${installedVersion}, but the lockfile pins ${lockedVersion}. A fresh install elsewhere would produce ${lockedVersion}.`,
        evidenceRefs,
        affectedDeclaration: LOCKFILES[0],
        // Rewriting the lockfile by hand would produce one npm cannot verify.
        // The honest repair is to run the install and commit what npm writes.
        proposedRepair: null,
      });
    }

    const runtimes: RuntimeRequirement[] = [...declared.runtimes];
    if (runtimes.length === 0) {
      const observedNode = bundle.evidence.find(
        (item) => item.kind === "runtime_fingerprint" && item.summary.startsWith("node "),
      );
      if (observedNode) {
        const version = observedNode.summary.slice("node ".length).trim();
        runtimes.push({
          runtime: "node",
          versionSpec: `>=${majorOf(version)}.0.0`,
          observedVersion: version,
          source: "derived",
        });
        drift.push({
          adapterId: ADAPTER_ID,
          kind: "runtime_pin_missing",
          summary: `package.json does not declare engines.node; this machine ran Node ${version}.`,
          evidenceRefs: [observedNode.id],
          affectedDeclaration: MANIFEST,
          proposedRepair: null,
        });
      }
    }

    const hasLockfile = declared.files.some((file) => (LOCKFILES as readonly string[]).includes(file));
    const steps: MaterializationStep[] = [];

    for (const runtime of runtimes) {
      steps.push({
        id: `${ADAPTER_ID}:runtime:${runtime.runtime}`,
        kind: "ensure_runtime",
        adapterId: ADAPTER_ID,
        workDir: ".",
        idempotencyKey: `runtime-${runtime.runtime}-${digestOf(runtime.versionSpec).slice(7, 23)}`,
        description: `Node ${runtime.versionSpec} must be available on PATH.`,
        runtime: runtime.runtime,
        versionSpec: runtime.versionSpec,
        strategy: "probe",
        probeArgv: ["node", "--version"],
      });
    }

    if (declared.files.includes(MANIFEST)) {
      steps.push({
        id: `${ADAPTER_ID}:install`,
        kind: "install_project_dependencies",
        adapterId: ADAPTER_ID,
        workDir: ".",
        idempotencyKey: `npm-install-${digestOf({ hasLockfile, packages: declared.packages }).slice(7, 27)}`,
        description: hasLockfile
          ? "Install the exact locked dependency tree into node_modules."
          : "Install the declared dependency tree into node_modules (no lockfile is committed).",
        manager: "npm",
        manifest: MANIFEST,
        ...(hasLockfile
          ? { lockfile: declared.files.find((f) => (LOCKFILES as readonly string[]).includes(f)) as string }
          : {}),
        frozen: hasLockfile,
        timeoutMs: 600_000,
      });
    }

    if (overlay.length > 0) {
      steps.push({
        id: `${ADAPTER_ID}:overlay`,
        kind: "apply_package_overlay",
        adapterId: ADAPTER_ID,
        workDir: ".",
        idempotencyKey: `npm-overlay-${digestOf(overlay).slice(7, 27)}`,
        // The overlay now carries two different situations - a package the
        // repository never declares, and one it declares at another version -
        // so the description names what is actually being installed rather
        // than asserting one cause for both.
        description: `Install ${overlay.length} package version${
          overlay.length === 1 ? "" : "s"
        } this machine ran that a fresh install would not produce: ${overlay
          .map((entry) => `${entry.name}@${entry.versionSpec}`)
          .join(", ")}. package.json is not modified.`,
        manager: "npm",
        packages: overlay.map((entry) => ({
          name: entry.name,
          versionSpec: entry.versionSpec,
          evidenceRefs: entry.evidenceRefs.length > 0 ? entry.evidenceRefs : ["observed-process"],
        })),
        timeoutMs: 600_000,
      });
    }

    return {
      adapterId: ADAPTER_ID,
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

  async preflight(
    ctx: MaterializationContext,
    steps: readonly MaterializationStep[],
  ): Promise<PreflightResult> {
    const issues: PreflightIssue[] = [];
    const owned = steps.filter((step) => step.adapterId === ADAPTER_ID);
    if (owned.length === 0) return { adapterId: ADAPTER_ID, issues };

    if (owned.some((step) => step.kind === "install_project_dependencies")) {
      const npm = await ctx.probe(["npm", "--version"], { timeoutMs: 30_000 });
      if (!npm.ok) {
        issues.push({
          code: "missing_system_tool",
          message: "npm is not available on PATH, so project dependencies cannot be installed.",
          nextAction: "Install a Node.js runtime that provides npm, then run rescue again.",
        });
      }
      if (!(await ctx.files.exists(MANIFEST))) {
        issues.push({
          code: "manifest_missing",
          message: "package.json is missing from this checkout.",
          nextAction: "Check out the revision the contract was captured from.",
        });
      }
    }

    for (const step of owned) {
      if (step.kind !== "ensure_runtime") continue;
      const probe = await ctx.probe(step.probeArgv, { timeoutMs: 30_000 });
      if (!probe.ok) {
        issues.push({
          code: "missing_runtime",
          message: `${step.runtime} is not available on PATH.`,
          nextAction: `Install ${step.runtime} ${step.versionSpec} and make it available on PATH.`,
        });
        continue;
      }
      const version = probe.stdout.trim().replace(/^v/u, "");
      const result = satisfies(version, step.versionSpec);
      if (result === "unsatisfied") {
        issues.push({
          code: "missing_runtime",
          message: `${step.runtime} ${version} does not satisfy ${step.versionSpec}.`,
          nextAction: `Install ${step.runtime} ${step.versionSpec}.`,
        });
      }
    }
    return { adapterId: ADAPTER_ID, issues };
  }

  planCommand(step: MaterializationStep, ctx: MaterializationContext): CommandPlan | null {
    if (step.adapterId !== ADAPTER_ID) return null;
    const cacheDir = `${ctx.managedDir}/npm-cache`;
    if (step.kind === "install_project_dependencies") {
      return {
        // `ci` installs exactly the lockfile and refuses to update it, which is
        // what a rescue needs. Without a lockfile there is nothing to freeze -
        // and `--no-package-lock` stops the install from leaving one behind, so
        // a rescue does not add a file the repository chose not to keep.
        argv: step.frozen ? ["npm", "ci"] : ["npm", "install", "--no-package-lock"],
        workDir: step.workDir,
        env: { npm_config_cache: cacheDir, npm_config_fund: "false", npm_config_audit: "false" },
        timeoutMs: step.timeoutMs,
        expectedExitCodes: [0],
      };
    }
    if (step.kind === "apply_package_overlay") {
      return {
        // `--no-save` is what keeps rescue from editing a tracked file: it
        // leaves both package.json and the lockfile alone. `--no-package-lock`
        // additionally stops one being created where none exists.
        argv: [
          "npm",
          "install",
          "--no-save",
          "--no-package-lock",
          ...step.packages.map((pkg) => `${pkg.name}@${pkg.versionSpec}`),
        ],
        workDir: step.workDir,
        env: { npm_config_cache: cacheDir, npm_config_fund: "false", npm_config_audit: "false" },
        timeoutMs: step.timeoutMs,
        expectedExitCodes: [0],
      };
    }
    return null;
  }

  async verifyAfterMaterialize(ctx: MaterializationContext): Promise<AdapterVerification> {
    const manifest = await readManifest(ctx.files);
    const installed = await readInstalled(ctx.projectDir);
    const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
    if (manifest === null) {
      return {
        adapterId: ADAPTER_ID,
        satisfied: false,
        checks: [{ name: "package.json readable", passed: false, detail: "package.json is missing or invalid." }],
      };
    }
    if (installed === null) {
      return {
        adapterId: ADAPTER_ID,
        satisfied: false,
        checks: [{ name: "node_modules present", passed: false, detail: "node_modules was not created." }],
      };
    }
    const required = dependencyEntries(manifest).filter(([, , mandatory]) => mandatory);
    const missing = required.filter(([name]) => !installed.has(name)).map(([name]) => name);
    checks.push({
      name: "declared dependencies installed",
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? `${required.length} declared package${required.length === 1 ? "" : "s"} present in node_modules.`
          : `missing from node_modules: ${missing.slice(0, 10).join(", ")}`,
    });
    return { adapterId: ADAPTER_ID, satisfied: missing.length === 0, checks };
  }

  async proposeRepair(
    bundle: EvidenceBundle,
    finding: ContractDrift,
    pending?: ReadonlyMap<string, string>,
  ): Promise<readonly ProposedFileChange[]> {
    const original = await readRawManifest(bundle.projectDir);
    if (original === null) return [];
    // Build on any edit an earlier finding already proposed for this file.
    const current = pending?.get(MANIFEST) ?? original;

    let parsed: PackageManifest & Record<string, unknown>;
    try {
      parsed = JSON.parse(current) as PackageManifest & Record<string, unknown>;
    } catch {
      return [];
    }

    if (finding.kind === "undeclared_package") {
      const match = /^(\S+)@(\S+?)\s/u.exec(`${finding.summary} `);
      if (!match) return [];
      const [, name, versionSpec] = match as unknown as [string, string, string];
      const dependencies = {
        ...((parsed["dependencies"] as Record<string, string> | undefined) ?? {}),
        [name]: `^${versionSpec}`,
      };
      const sorted = Object.fromEntries(
        Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
      const after = `${JSON.stringify({ ...parsed, dependencies: sorted }, null, 2)}
`;
      return [
        { path: MANIFEST, before: original, after, unifiedDiff: unifiedDiff(MANIFEST, original, after) },
      ];
    }

    if (finding.kind === "runtime_pin_missing") {
      const match = /Node (\S+?)\.?$/u.exec(finding.summary.trim());
      if (!match) return [];
      const version = match[1] as string;
      const engines = {
        ...((parsed["engines"] as Record<string, string> | undefined) ?? {}),
        node: `>=${majorOf(version)}.0.0`,
      };
      const after = `${JSON.stringify({ ...parsed, engines }, null, 2)}
`;
      return [
        { path: MANIFEST, before: original, after, unifiedDiff: unifiedDiff(MANIFEST, original, after) },
      ];
    }

    return [];
  }
}

type ContractDrift = Omit<DriftFinding, "id" | "projectId" | "commit" | "detectedAt">;

async function readRawManifest(projectDir: string): Promise<string | null> {
  try {
    return await readFile(join(projectDir, MANIFEST), "utf8");
  } catch {
    return null;
  }
}

function majorOf(version: string): string {
  const match = /^v?(\d+)/u.exec(version.trim());
  return match?.[1] ?? "0";
}

/** `name`, `name@spec`, `@scope/name`, `@scope/name@spec`. */
export function parseSpecifier(token: string): { name: string; versionSpec: string } | null {
  if (token.length === 0) return null;
  if (/^(?:https?:|git\+|file:|github:|\.|\/)/u.test(token)) return null;
  const scoped = token.startsWith("@");
  const at = token.indexOf("@", scoped ? 1 : 0);
  if (at <= 0) return { name: token, versionSpec: "*" };
  const name = token.slice(0, at);
  const spec = token.slice(at + 1);
  return { name, versionSpec: spec.length > 0 ? spec : "*" };
}

export const npmAdapter = new NpmAdapter();

/**
 * Exact top-level versions from an npm lockfile.
 *
 * This is what `npm ci` would put on another machine, which is the only fair
 * thing to compare an installed tree against. Both lockfile layouts are read:
 * v2 and v3 key a `packages` map by path, v1 nests a `dependencies` tree.
 * Nested paths (`node_modules/a/node_modules/b`) are skipped, because the
 * inventory that this is compared with reads the top level only.
 *
 * A lockfile that cannot be parsed yields nothing rather than a guess: an
 * empty result disables the comparison, which is the safe direction.
 */
export function parseLockedVersions(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const document = parsed as { packages?: unknown; dependencies?: unknown };
  const versions: Record<string, string> = {};

  if (typeof document.packages === "object" && document.packages !== null) {
    const entries = document.packages as Record<string, unknown>;
    for (const [path, entry] of Object.entries(entries)) {
      if (!path.startsWith("node_modules/")) continue;
      const name = path.slice("node_modules/".length);
      if (name.includes("/node_modules/")) continue;
      if (typeof entry !== "object" || entry === null) continue;

      const record = entry as { version?: unknown; link?: unknown; resolved?: unknown };
      let version = record.version;

      // A `file:` or workspace dependency is recorded as a link, and its
      // version lives at the target path. These are common in monorepos, and
      // replacing the link with a real directory is a genuine mismatch worth
      // reporting - so the link is followed rather than skipped.
      if (record.link === true && typeof record.resolved === "string") {
        const target = entries[record.resolved];
        if (typeof target === "object" && target !== null) {
          version = (target as { version?: unknown }).version;
        }
      }

      if (typeof version === "string" && version.length > 0) versions[name] = version;
    }
  }

  // v1 lockfiles, still produced by npm 6 and still committed in real repos.
  if (Object.keys(versions).length === 0 && typeof document.dependencies === "object" && document.dependencies !== null) {
    for (const [name, entry] of Object.entries(document.dependencies as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const version = (entry as { version?: unknown }).version;
      if (typeof version === "string" && version.length > 0) versions[name] = version;
    }
  }

  return versions;
}

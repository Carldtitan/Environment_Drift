/**
 * pnpm, Yarn, and Bun.
 *
 * One adapter for three managers, because from IWOMC's side they differ only
 * in the command they run and the lockfile they read. All three put packages
 * in `node_modules`, all three commit a lockfile, and all three can be told to
 * install exactly what that lockfile says.
 *
 * Two rules shape everything here.
 *
 * **Nothing leaves the project folder.** Each of these managers keeps a
 * machine-wide cache by default - pnpm a content-addressable store, Yarn a
 * cache folder, Bun its own - and a rescue that filled those would be changing
 * the machine, not the project. Every command below redirects that cache into
 * the project's own `.iwomc` directory, the same way the npm adapter already
 * does. That is not a detail; it is the promise this product makes.
 *
 * **No manifest is edited.** `npm` can install a package without writing to
 * `package.json`; `pnpm add` and `yarn add` cannot. So this adapter does not
 * install a package the repository has not declared. It reports it as drift
 * instead, and `iwomc promote` turns it into a reviewable change to
 * `package.json` - which is the better outcome anyway, because the fix reaches
 * the repository rather than living on one more machine.
 */

import { digestOf } from "@iwomc/contracts";
import { readInstalledDetail } from "./npm.js";
import type {
  AdapterContext,
  AdapterManifest,
  AdapterVerification,
  CommandPlan,
  CompileResult,
  ContractFragment,
  DeclaredState,
  Detection,
  EnvironmentAdapter,
  EvidenceBundle,
  InventoryResult,
  MaterializationContext,
  ObservedEffect,
  PreflightResult,
  ProjectFiles,
} from "./types.js";
import type {
  CoverageGap,
  MaterializationStep,
  PackageRequirement,
  ProposedFileChange,
  RuntimeRequirement,
  SystemToolRequirement,
} from "@iwomc/contracts";

const MANIFEST = "package.json";

/** Lockfiles that mean npm owns the project and this adapter stands aside. */
const NPM_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"] as const;

interface ManagerProfile {
  readonly manager: string;
  readonly lockfiles: readonly string[];
  /** Install exactly the lockfile, refusing to update it. */
  readonly frozenArgs: readonly string[];
  /** Install without a committed lockfile to freeze. */
  readonly looseArgs: readonly string[];
  /** Environment that keeps this manager's cache inside the project. */
  cacheEnv(managedDir: string): Readonly<Record<string, string>>;
}

const PROFILES: readonly ManagerProfile[] = [
  {
    manager: "pnpm",
    lockfiles: ["pnpm-lock.yaml"],
    frozenArgs: ["pnpm", "install", "--frozen-lockfile"],
    looseArgs: ["pnpm", "install", "--no-frozen-lockfile"],
    cacheEnv: (managedDir) => ({
      // pnpm's store is content-addressable and shared across every project on
      // the machine unless it is told otherwise.
      npm_config_store_dir: `${managedDir}/pnpm-store`,
      npm_config_cache_dir: `${managedDir}/pnpm-cache`,
      npm_config_state_dir: `${managedDir}/pnpm-state`,
    }),
  },
  {
    manager: "yarn",
    lockfiles: ["yarn.lock"],
    // Classic Yarn. Berry is handled by `argsFor` below, which prefers
    // `--immutable` when a .yarnrc.yml is present.
    frozenArgs: ["yarn", "install", "--frozen-lockfile"],
    looseArgs: ["yarn", "install"],
    cacheEnv: (managedDir) => ({
      YARN_CACHE_FOLDER: `${managedDir}/yarn-cache`,
      // Berry otherwise reaches for a global cache in the home directory.
      YARN_ENABLE_GLOBAL_CACHE: "false",
      YARN_GLOBAL_FOLDER: `${managedDir}/yarn-global`,
    }),
  },
  {
    manager: "bun",
    lockfiles: ["bun.lockb", "bun.lock"],
    frozenArgs: ["bun", "install", "--frozen-lockfile"],
    looseArgs: ["bun", "install"],
    cacheEnv: (managedDir) => ({ BUN_INSTALL_CACHE_DIR: `${managedDir}/bun-cache` }),
  },
];

/** The lockfile this manager owns in a project, if it is there. */
async function lockfileFor(profile: ManagerProfile, files: ProjectFiles): Promise<string | null> {
  for (const lockfile of profile.lockfiles) {
    if (await files.exists(lockfile)) return lockfile;
  }
  return null;
}

interface PackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly engines?: { readonly node?: string };
  readonly packageManager?: string;
}

async function readManifest(files: ProjectFiles): Promise<PackageManifest | null> {
  const raw = await files.read(MANIFEST);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PackageManifest;
  } catch {
    return null;
  }
}

/**
 * One adapter per manager, sharing this implementation.
 *
 * They differ only in a command and a lockfile name, but each gets its own
 * identity so a contract records which manager actually installed the project
 * rather than a shared alias.
 */
function createAdapter(profile: ManagerProfile): EnvironmentAdapter {
  const ADAPTER_ID = `node.${profile.manager}`;
  return {
  manifest: {
    id: ADAPTER_ID,
    ecosystem: "node",
    manager: "pnpm/yarn/bun",
    support: "native",
    declaredFiles: [MANIFEST, "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"],
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
      "Installs exactly what the committed lockfile says, with the manager's cache redirected inside the project so nothing on the wider machine changes. It will not install a package the repository does not declare: pnpm and Yarn cannot add one without editing package.json, so that is reported as drift for `iwomc promote` instead.",
  } satisfies AdapterManifest,

  async detect(files: ProjectFiles): Promise<Detection> {
    if (!(await files.exists(MANIFEST))) {
      return { detected: false, signals: [], confidence: "high" };
    }
    for (const lockfile of NPM_LOCKFILES) {
      if (await files.exists(lockfile)) {
        return {
          detected: false,
          signals: [],
          confidence: "high",
          note: `${lockfile} is present, so the npm adapter owns this project.`,
        };
      }
    }
    const lockfile = await lockfileFor(profile, files);
    if (lockfile === null) {
      return {
        detected: false,
        signals: [],
        confidence: "medium",
        note: `No ${profile.manager} lockfile.`,
      };
    }
    return {
      detected: true,
      signals: [MANIFEST, lockfile],
      confidence: "high",
      note: `${profile.manager} project.`,
    };
  },

  async readDeclaredState(ctx: AdapterContext): Promise<DeclaredState> {
    const manifest = await readManifest(ctx.files);
    const lockfile = await lockfileFor(profile, ctx.files);
    const declaredFiles: string[] = [MANIFEST];
    const packages: PackageRequirement[] = [];
    const runtimes: RuntimeRequirement[] = [];
    const gaps: CoverageGap[] = [];

    if (manifest === null) {
      gaps.push({
        area: "node.alt.manifest",
        reason: "package.json is missing or is not valid JSON, so nothing can be read from it.",
        remediation: "Fix package.json, then capture again.",
      });
      return { adapterId: ADAPTER_ID, files: declaredFiles, runtimes, packages, systemTools: [], secrets: [], gaps };
    }

    for (const [scope, entries] of [
      ["direct", manifest.dependencies],
      ["direct", manifest.devDependencies],
      ["direct", manifest.optionalDependencies],
    ] as const) {
      for (const [name, versionSpec] of Object.entries(entries ?? {})) {
        if (packages.some((entry) => entry.name === name)) continue;
        packages.push({
          ecosystem: "node",
          manager: profile.manager,
          name,
          versionSpec,
          scope,
          source: "declared",
          evidenceRefs: [],
          declared: true,
        });
      }
    }

    if (manifest.engines?.node) {
      runtimes.push({ runtime: "node", versionSpec: manifest.engines.node, source: "declared" });
    } else {
      gaps.push({
        area: "node.runtime",
        reason: "package.json does not declare engines.node, so the required Node version is unknown from source alone.",
        remediation: "Add an engines.node range so a teammate gets the runtime you tested on.",
      });
    }

    if (lockfile !== null) {
      declaredFiles.push(lockfile);
      // The install is exact, but IWOMC cannot read these lockfile formats, so
      // it cannot tell that an installed version differs from the locked one.
      // Saying so beats letting someone assume that check happened.
      gaps.push({
        area: "node.alt.lockfile",
        reason: `IWOMC installs exactly what ${lockfile} says, but does not parse it - so it cannot tell you when an installed package differs from the version that lockfile pins.`,
        remediation: `Run ${profile.manager} install to bring this checkout back to the lockfile.`,
      });
    } else {
      gaps.push({
        area: "node.alt.lockfile",
        reason: "No lockfile is committed, so transitive versions are not pinned by the repository.",
        remediation: "Commit a lockfile so a rescue installs the exact tree you tested.",
      });
    }

    const systemTools: SystemToolRequirement[] = lockfile !== null
      ? [
          {
            name: profile.manager,
            probeArgv: [profile.manager, "--version"],
            source: "declared",
            installHint:
              manifest.packageManager !== undefined
                ? `This project sets packageManager: ${manifest.packageManager}. Enable Corepack, or install ${profile.manager} yourself.`
                : `Install ${profile.manager} and make it available on PATH.`,
          },
        ]
      : [];

    return { adapterId: ADAPTER_ID, files: declaredFiles, runtimes, packages, systemTools, secrets: [], gaps };
  },

  async inventory(ctx: AdapterContext): Promise<InventoryResult> {
    const manager = profile.manager;
    const detail = await readInstalledDetail(ctx.projectDir);
    if (detail === null) {
      return {
        adapterId: ADAPTER_ID,
        available: false,
        gaps: [
          {
            area: "node.alt.inventory",
            reason: `node_modules is not present, so ${manager} packages cannot be inventoried.`,
            remediation: `Run ${manager} install, then look again.`,
          },
        ],
      };
    }
    const entries = [...detail.versions.entries()]
      .map(([name, version]) => ({ name, version }))
      .sort((left, right) => (left.name < right.name ? -1 : 1));

    return {
      adapterId: ADAPTER_ID,
      available: true,
      ...(Object.keys(detail.constraints).length > 0 ? { platformConstraints: detail.constraints } : {}),
      snapshot: {
        adapterId: ADAPTER_ID,
        manager,
        takenAt: new Date().toISOString(),
        entryCount: entries.length,
        digest: digestOf(entries),
        entries,
      },
      gaps: [],
    };
  },

  observeProcess(): ObservedEffect[] {
    return [];
  },

  async deriveObservedEffects(): Promise<ObservedEffect[]> {
    return [];
  },

  compile(bundle: EvidenceBundle): CompileResult {
    const declared = bundle.declared;
    const manager = profile.manager;
    const lockfile = declared.files.find((file) =>
      (profile.lockfiles as readonly string[]).includes(file),
    );
    const hasLockfile = lockfile !== undefined;

    const coverage: CoverageGap[] = [...declared.gaps];
    const steps: MaterializationStep[] = [];
    const runtimes: RuntimeRequirement[] = [...declared.runtimes];
    const drift: ContractFragment["drift"][number][] = [];

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

    steps.push({
      id: `${ADAPTER_ID}:install`,
      kind: "install_project_dependencies",
      adapterId: ADAPTER_ID,
      workDir: ".",
      idempotencyKey: `${manager}-install-${digestOf({ hasLockfile, packages: declared.packages }).slice(7, 27)}`,
      description: hasLockfile
        ? `Install exactly what ${lockfile} pins, using ${manager}. Its cache is redirected inside the project, so nothing outside it changes.`
        : `Install the declared dependency tree with ${manager} (no lockfile is committed).`,
      manager,
      manifest: MANIFEST,
      ...(hasLockfile ? { lockfile } : {}),
      frozen: hasLockfile,
      timeoutMs: 900_000,
    });

    // Packages installed here that the repository never declares. These cannot
    // be installed without editing package.json, which a rescue must never do,
    // so they are reported for `iwomc promote` to turn into a reviewed change.
    const installed = new Map(
      (bundle.inventoryAfter?.entries ?? []).map((entry) => [entry.name, entry.version]),
    );
    const declaredNames = new Set(declared.packages.map((entry) => entry.name));
    const undeclared: string[] = [];
    for (const effect of bundle.observed) {
      if (effect.adapterId !== ADAPTER_ID || effect.kind !== "package_added") continue;
      for (const observedPackage of effect.packages) {
        if (declaredNames.has(observedPackage.name)) continue;
        if (undeclared.includes(observedPackage.name)) continue;
        undeclared.push(observedPackage.name);
        drift.push({
          adapterId: ADAPTER_ID,
          kind: "undeclared_package",
          summary: `${observedPackage.name}@${
            installed.get(observedPackage.name) ?? observedPackage.versionSpec
          } is installed here but package.json does not declare it.`,
          evidenceRefs: [],
          affectedDeclaration: MANIFEST,
          proposedRepair: null,
        });
      }
    }
    if (undeclared.length > 0) {
      coverage.push({
        area: "node.alt.overlay",
        reason: `${undeclared.join(", ")} ${
          undeclared.length === 1 ? "is" : "are"
        } installed here but not declared. ${manager} cannot install a package without editing package.json, and a rescue never edits a tracked file, so a rescue will not reproduce ${undeclared.length === 1 ? "it" : "them"}.`,
        remediation: "Run `iwomc promote` to add them to package.json for review.",
      });
    }

    return {
      adapterId: ADAPTER_ID,
      support: "native",
      runtimes,
      packages: declared.packages,
      systemTools: declared.systemTools,
      secrets: declared.secrets,
      steps,
      coverage,
      drift,
    };
  },

  async preflight(ctx: MaterializationContext): Promise<PreflightResult> {
    const lockfile = await lockfileFor(profile, ctx.files);
    if (lockfile === null) return { adapterId: ADAPTER_ID, issues: [] };
    const probe = await ctx.probe([profile.manager, "--version"], { timeoutMs: 30_000 });
    if (probe.notFound) {
      return {
        adapterId: ADAPTER_ID,
        issues: [
          {
            code: "missing_system_tool",
            message: `${profile.manager} is not on PATH, and this project needs it to install its dependencies.`,
            nextAction: `Install ${profile.manager}, or enable Corepack, then run rescue again.`,
          },
        ],
      };
    }
    return { adapterId: ADAPTER_ID, issues: [] };
  },

  planCommand(step: MaterializationStep, ctx: MaterializationContext): CommandPlan | null {
    if (step.adapterId !== ADAPTER_ID) return null;
    if (step.kind !== "install_project_dependencies") return null;

    // Berry reads `.yarnrc.yml` and rejects the classic flag; `--immutable` is
    // its equivalent. Checking the file is how Yarn itself decides.
    const berry = profile.manager === "yarn" && ctx.files.entries.includes(".yarnrc.yml");
    const argv = step.frozen
      ? berry
        ? ["yarn", "install", "--immutable"]
        : [...profile.frozenArgs]
      : [...profile.looseArgs];

    return {
      argv,
      workDir: step.workDir,
      // Every one of these keeps a machine-wide cache by default. Redirecting
      // it into the project is what keeps a rescue from changing the machine.
      env: { ...profile.cacheEnv(ctx.managedDir), CI: "1" },
      timeoutMs: step.timeoutMs,
      expectedExitCodes: [0],
    };
  },

  async verifyAfterMaterialize(ctx: MaterializationContext): Promise<AdapterVerification> {
    const manifest = await readManifest(ctx.files);
    const detail = await readInstalledDetail(ctx.projectDir);
    const checks: { name: string; passed: boolean; detail: string }[] = [];

    if (manifest === null) {
      return {
        adapterId: ADAPTER_ID,
        satisfied: false,
        checks: [{ name: "package.json readable", passed: false, detail: "package.json is missing or invalid." }],
      };
    }
    if (detail === null) {
      return {
        adapterId: ADAPTER_ID,
        satisfied: false,
        checks: [{ name: "node_modules present", passed: false, detail: "node_modules was not created." }],
      };
    }

    const required = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    const missing = required.filter((name) => !detail.versions.has(name));
    checks.push({
      name: "declared dependencies installed",
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? `All ${required.length} declared package(s) are present in node_modules.`
          : `Missing from node_modules: ${missing.join(", ")}.`,
    });

    return { adapterId: ADAPTER_ID, satisfied: missing.length === 0, checks };
  },

  async proposeRepair(): Promise<readonly ProposedFileChange[]> {
    // Adding an undeclared package to package.json is the npm adapter's
    // repair, and it is the same file in the same shape. Leaving it there
    // keeps one implementation of a change that edits a tracked file.
    return [];
  },
  };
}

/** pnpm, Yarn, and Bun, each as its own adapter over one implementation. */
export const [pnpmAdapter, yarnAdapter, bunAdapter] = PROFILES.map(createAdapter) as [
  EnvironmentAdapter,
  EnvironmentAdapter,
  EnvironmentAdapter,
];

export const nodeAltAdapters: readonly EnvironmentAdapter[] = [pnpmAdapter, yarnAdapter, bunAdapter];

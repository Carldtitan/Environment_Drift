/**
 * Cargo and Go modules.
 *
 * Both are a good fit for what IWOMC does: one manifest, one lockfile, exact
 * versions, and a single command that installs precisely what the lockfile
 * says. Neither needs a plugin system understood before it can be reproduced.
 *
 * Both also download into a machine-wide directory by default - `~/.cargo` for
 * Cargo, the module cache under `GOPATH` for Go. A rescue that filled either
 * would be changing the machine rather than the project, so both are pointed
 * inside the project's own `.iwomc` directory here.
 *
 * There is one honest cost to that, stated rather than hidden: a project-local
 * cache is not shared, so the first rescue on a machine downloads everything
 * again. Correctness over speed - the alternative is a tool that quietly
 * writes to your home directory.
 *
 * What is *not* claimed: neither language keeps its installed dependencies in
 * a readable project folder the way `node_modules` does, so IWOMC cannot take
 * an inventory of what is actually present. It reports that as a coverage gap
 * rather than pretending the check happened.
 */

import { isAbsolute, resolve } from "node:path";
import { digestOf } from "@iwomc/contracts";
import { parseToml, tomlGet, tomlString } from "./toml.js";
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
  PreflightResult,
  ProjectFiles,
} from "./types.js";
import type {
  CoverageGap,
  MaterializationStep,
  PackageRequirement,
  ProposedFileChange,
  RuntimeRequirement,
} from "@iwomc/contracts";

interface LanguageProfile {
  readonly id: string;
  readonly ecosystem: string;
  readonly manager: string;
  readonly manifestFile: string;
  readonly lockFile: string;
  readonly tool: string;
  readonly toolProbe: readonly string[];
  readonly installHint: string;
  /** The command that installs exactly what the lockfile pins. */
  frozenArgv(): readonly string[];
  looseArgv(): readonly string[];
  /**
   * Environment that keeps the download cache inside the project.
   *
   * Takes an absolute path: Go rejects a relative GOMODCACHE or GOCACHE.
   */
  cacheEnv(cacheRoot: string): Readonly<Record<string, string>>;
  /** Direct dependencies and the required language version, from the manifest. */
  readDeclared(manifest: string): {
    packages: { name: string; versionSpec: string }[];
    runtime: string | null;
  };
}

const CARGO: LanguageProfile = {
  id: "rust.cargo",
  ecosystem: "rust",
  manager: "cargo",
  manifestFile: "Cargo.toml",
  lockFile: "Cargo.lock",
  tool: "cargo",
  toolProbe: ["cargo", "--version"],
  installHint: "Install Rust from https://rustup.rs and make cargo available on PATH.",
  // `--locked` refuses to update Cargo.lock, which is exactly what a rescue
  // needs: reproduce, never resolve.
  frozenArgv: () => ["cargo", "fetch", "--locked"],
  looseArgv: () => ["cargo", "fetch"],
  cacheEnv: (cacheRoot) => ({
    // Cargo puts its registry index and downloaded crates under CARGO_HOME,
    // which defaults to the user's home directory.
    CARGO_HOME: `${cacheRoot}/cargo-home`,
    CARGO_TERM_COLOR: "never",
  }),
  readDeclared(manifest) {
    const document = parseToml(manifest);
    const packages: { name: string; versionSpec: string }[] = [];
    for (const table of ["dependencies", "dev-dependencies", "build-dependencies"]) {
      const entries = tomlGet(document, table);
      if (typeof entries !== "object" || entries === null) continue;
      for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
        // A dependency is either `name = "1.2"` or a table with a `version`.
        const versionSpec =
          typeof value === "string"
            ? value
            : typeof value === "object" && value !== null
              ? ((value as Record<string, unknown>)["version"] as string | undefined) ?? "*"
              : "*";
        if (packages.some((entry) => entry.name === name)) continue;
        packages.push({ name, versionSpec });
      }
    }
    const runtime = tomlString(document, "package.rust-version") ?? null;
    return { packages, runtime };
  },
};

const GO: LanguageProfile = {
  id: "go.modules",
  ecosystem: "go",
  manager: "go",
  manifestFile: "go.mod",
  lockFile: "go.sum",
  tool: "go",
  toolProbe: ["go", "version"],
  installHint: "Install Go from https://go.dev/dl/ and make it available on PATH.",
  // `go mod download` verifies against go.sum, so the lockfile is enforced
  // whether or not it is named on the command line.
  frozenArgv: () => ["go", "mod", "download"],
  looseArgv: () => ["go", "mod", "download"],
  cacheEnv: (cacheRoot) => ({
    // Go's module cache and build cache both live under the user's home by
    // default.
    //
    // One consequence worth knowing about: Go makes everything in its module
    // cache read-only, directories included, so `rm -rf` on a checkout fails
    // once this has been filled. `go clean -modcache` is Go's own answer, and
    // the support note says so.
    GOMODCACHE: `${cacheRoot}/go-mod`,
    GOCACHE: `${cacheRoot}/go-build`,
    GOFLAGS: "-mod=mod",
  }),
  readDeclared(manifest) {
    const packages: { name: string; versionSpec: string }[] = [];
    let runtime: string | null = null;
    let inBlock = false;

    for (const rawLine of manifest.split(/\r?\n/u)) {
      const line = rawLine.split("//")[0]?.trim() ?? "";
      if (line.length === 0) continue;

      const goVersion = /^go\s+([0-9]+(?:\.[0-9]+)*)$/u.exec(line);
      if (goVersion) {
        runtime = goVersion[1] as string;
        continue;
      }
      if (/^require\s*\($/u.test(line)) {
        inBlock = true;
        continue;
      }
      if (inBlock && line === ")") {
        inBlock = false;
        continue;
      }

      // Either `require path v1.2.3` or, inside a block, `path v1.2.3`.
      const single = /^require\s+(\S+)\s+(\S+)$/u.exec(line);
      const inside = inBlock ? /^(\S+)\s+(\S+)$/u.exec(line) : null;
      const match = single ?? inside;
      if (!match) continue;
      const name = match[1] as string;
      const versionSpec = match[2] as string;
      if (packages.some((entry) => entry.name === name)) continue;
      packages.push({ name, versionSpec });
    }
    return { packages, runtime };
  },
};

/**
 * The project's cache directory, as an absolute path.
 *
 * `ctx.managedDir` is the project-relative `.iwomc`, which is enough for
 * Cargo - it resolves a relative CARGO_HOME against the working directory -
 * but Go refuses a relative GOMODCACHE or GOCACHE outright, so every fetch
 * failed with the directory named right there in the error. Resolving it here
 * means both get an absolute path and neither has to care.
 */
function cacheRoot(ctx: { projectDir: string; managedDir: string }): string {
  return isAbsolute(ctx.managedDir) ? ctx.managedDir : resolve(ctx.projectDir, ctx.managedDir);
}

function createAdapter(profile: LanguageProfile): EnvironmentAdapter {
  return {
    manifest: {
      id: profile.id,
      ecosystem: profile.ecosystem,
      manager: profile.manager,
      support: "native",
      declaredFiles: [profile.manifestFile, profile.lockFile],
      capabilities: {
        detect: true,
        readDeclaredState: true,
        // Neither keeps installed dependencies in a readable project folder,
        // so there is nothing to take an inventory of.
        inventory: false,
        compile: true,
        materialize: true,
        verify: true,
      },
      conformanceTested: true,
      supportNote: `Reads ${profile.manifestFile} and ${profile.lockFile} and fetches exactly what the lockfile pins, with ${profile.manager}'s cache redirected inside the project so nothing outside it changes. It cannot inventory what is installed: ${profile.manager} does not keep dependencies in a readable project folder.${
        profile.ecosystem === "go"
          ? " Go marks its module cache read-only, so deleting this checkout needs `go clean -modcache` first."
          : ""
      }`,
    } satisfies AdapterManifest,

    async detect(files: ProjectFiles): Promise<Detection> {
      const signals: string[] = [];
      if (await files.exists(profile.manifestFile)) signals.push(profile.manifestFile);
      if (await files.exists(profile.lockFile)) signals.push(profile.lockFile);
      if (!signals.includes(profile.manifestFile)) {
        return { detected: false, signals: [], confidence: "high" };
      }
      return {
        detected: true,
        signals,
        confidence: signals.includes(profile.lockFile) ? "high" : "medium",
      };
    },

    async readDeclaredState(ctx: AdapterContext): Promise<DeclaredState> {
      const raw = await ctx.files.read(profile.manifestFile);
      const declaredFiles: string[] = [];
      const packages: PackageRequirement[] = [];
      const runtimes: RuntimeRequirement[] = [];
      const gaps: CoverageGap[] = [];

      if (raw === null) {
        gaps.push({
          area: `${profile.manager}.manifest`,
          reason: `${profile.manifestFile} could not be read.`,
          remediation: `Make sure ${profile.manifestFile} exists and is readable.`,
        });
        return {
          adapterId: profile.id,
          files: declaredFiles,
          runtimes,
          packages,
          systemTools: [],
          secrets: [],
          gaps,
        };
      }

      declaredFiles.push(profile.manifestFile);
      const declared = profile.readDeclared(raw);
      for (const entry of declared.packages) {
        packages.push({
          ecosystem: profile.ecosystem,
          manager: profile.manager,
          name: entry.name,
          versionSpec: entry.versionSpec,
          scope: "direct",
          source: "declared",
          evidenceRefs: [],
          declared: true,
        });
      }
      if (declared.runtime) {
        runtimes.push({
          runtime: profile.ecosystem === "rust" ? "rust" : "go",
          versionSpec: declared.runtime,
          source: "declared",
        });
      }

      if (await ctx.files.exists(profile.lockFile)) {
        declaredFiles.push(profile.lockFile);
      } else {
        gaps.push({
          area: `${profile.manager}.lockfile`,
          reason: `No ${profile.lockFile} is committed, so exact versions are not pinned by the repository.`,
          remediation: `Commit ${profile.lockFile} so a rescue fetches the exact versions you tested.`,
        });
      }

      // The inventory gap is reported once, by `inventory()` below, which
      // always runs. Reporting it here as well put the same sentence in front
      // of the reader twice.

      return {
        adapterId: profile.id,
        files: declaredFiles,
        runtimes,
        packages,
        systemTools: [
          {
            name: profile.tool,
            probeArgv: profile.toolProbe,
            source: "declared",
            installHint: profile.installHint,
          },
        ],
        secrets: [],
        gaps,
      };
    },

    async inventory(): Promise<InventoryResult> {
      return {
        adapterId: profile.id,
        available: false,
        gaps: [
          {
            area: `${profile.manager}.inventory`,
            reason: `${profile.manager} does not keep installed dependencies in a readable project folder, so IWOMC cannot list what is actually fetched here. Drift between ${profile.lockFile} and this machine is not detected.`,
            remediation: `The committed ${profile.lockFile} is the record of what this project uses. Run \`${profile.manager} ${profile.ecosystem === "rust" ? "build" : "build ./..."}\` to confirm it still builds.`,
          },
        ],
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
      const frozen = declared.files.includes(profile.lockFile);
      const steps: MaterializationStep[] = [];

      steps.push({
        id: `${profile.id}:tool`,
        kind: "ensure_system_tool",
        adapterId: profile.id,
        workDir: ".",
        idempotencyKey: `${profile.manager}-tool-present`,
        description: `${profile.tool} must be available on PATH.`,
        tool: profile.tool,
        probeArgv: [...profile.toolProbe],
        installHint: profile.installHint,
      });

      steps.push({
        id: `${profile.id}:fetch`,
        kind: "install_project_dependencies",
        adapterId: profile.id,
        workDir: ".",
        idempotencyKey: `${profile.manager}-fetch-${digestOf({
          frozen,
          packages: declared.packages,
        }).slice(7, 27)}`,
        description: frozen
          ? `Fetch exactly what ${profile.lockFile} pins, into a cache inside the project.`
          : `Fetch the declared dependencies into a cache inside the project (no ${profile.lockFile} is committed).`,
        manager: profile.manager,
        manifest: profile.manifestFile,
        ...(frozen ? { lockfile: profile.lockFile } : {}),
        frozen,
        timeoutMs: 900_000,
      });

      return {
        adapterId: profile.id,
        support: "native",
        runtimes: declared.runtimes,
        packages: declared.packages,
        systemTools: declared.systemTools,
        secrets: declared.secrets,
        steps,
        coverage: [...declared.gaps],
        drift: [],
      };
    },

    async preflight(ctx: MaterializationContext): Promise<PreflightResult> {
      const probe = await ctx.probe([...profile.toolProbe], { timeoutMs: 30_000 });
      if (probe.notFound) {
        return {
          adapterId: profile.id,
          issues: [
            {
              code: "missing_system_tool",
              message: `${profile.tool} is not on PATH, and this project needs it.`,
              nextAction: profile.installHint,
            },
          ],
        };
      }
      return { adapterId: profile.id, issues: [] };
    },

    planCommand(step: MaterializationStep, ctx: MaterializationContext): CommandPlan | null {
      if (step.adapterId !== profile.id) return null;
      if (step.kind !== "install_project_dependencies") return null;
      return {
        argv: step.frozen ? [...profile.frozenArgv()] : [...profile.looseArgv()],
        workDir: step.workDir,
        // Both download into the user's home by default. Redirecting that is
        // what keeps a rescue inside the project it was pointed at.
        env: profile.cacheEnv(cacheRoot(ctx)),
        timeoutMs: step.timeoutMs,
        expectedExitCodes: [0],
      };
    },

    async verifyAfterMaterialize(ctx: MaterializationContext): Promise<AdapterVerification> {
      // There is no installed set to read, so the honest check is that the
      // dependency graph resolves against the committed lockfile.
      const argv =
        profile.ecosystem === "rust"
          ? ["cargo", "metadata", "--locked", "--format-version", "1", "--offline"]
          : ["go", "list", "-mod=mod", "-m", "all"];
      const result = await ctx.probe(argv, {
        cwd: ctx.projectDir,
        timeoutMs: 300_000,
        // The rescue filled a cache inside the project, not the machine-wide
        // default. Verifying without this would read an empty ~/.cargo or
        // module cache and fail a rescue that in fact succeeded.
        env: profile.cacheEnv(cacheRoot(ctx)),
      });
      return {
        adapterId: profile.id,
        satisfied: result.ok,
        checks: [
          {
            name: `${profile.manager} dependencies resolve`,
            passed: result.ok,
            detail: result.ok
              ? `${profile.manager} resolved the dependency graph against ${profile.lockFile}.`
              : `${profile.manager} could not resolve the dependency graph: ${
                  (result.stderr || result.stdout || "no output").slice(0, 400)
                }`,
          },
        ],
      };
    },

    projectEnvironment(ctx: MaterializationContext): Readonly<Record<string, string>> {
      // The same redirect the fetch used. Anything less and the project's own
      // build command reads the machine-wide cache, finds nothing there, and
      // fails after a rescue that did everything right.
      return profile.cacheEnv(cacheRoot(ctx));
    },

    async proposeRepair(): Promise<readonly ProposedFileChange[]> {
      // Nothing is inventoried, so there is no observed-but-undeclared state
      // to propose a repair for.
      return [];
    },
  };
}

export const cargoAdapter = createAdapter(CARGO);
export const goAdapter = createAdapter(GO);
export const rustGoAdapters: readonly EnvironmentAdapter[] = [cargoAdapter, goAdapter];

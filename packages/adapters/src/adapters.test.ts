import { describe, expect, it } from "vitest";
import { defaultRegistry, ECOSYSTEM_PROBES, recognizeEcosystems } from "./registry.js";
import { npmAdapter, parseSpecifier, parseLockedVersions } from "./npm.js";
import {
  pipAdapter,
  uvAdapter,
  normalizePythonName,
  parseRequirementLine,
  exactPins,
  poetryAdapter,
} from "./python.js";
import { genericAdapter, buildReviewedRecipeStep } from "./generic.js";
import { pnpmAdapter, yarnAdapter, bunAdapter } from "./node-alt.js";
import { cargoAdapter, goAdapter } from "./rust-go.js";
import { parseToml, tomlString, tomlStringArray } from "./toml.js";
import { satisfies, parseVersion, compareVersions } from "./semver.js";
import { unifiedDiff } from "./diff.js";
import type { ProjectFiles } from "./types.js";

/** An in-memory project view, so detection tests touch no disk and no process. */
function filesOf(entries: Record<string, string>): ProjectFiles {
  return {
    entries: Object.keys(entries),
    read: async (path) => entries[path] ?? null,
    exists: async (path) => path in entries,
  };
}

describe("version ranges", () => {
  it("understands the range grammar real manifests use", () => {
    expect(satisfies("22.4.0", ">=22.0.0")).toBe("satisfied");
    expect(satisfies("20.1.0", ">=22.0.0")).toBe("unsatisfied");
    expect(satisfies("1.2.9", "^1.2.0")).toBe("satisfied");
    expect(satisfies("2.0.0", "^1.2.0")).toBe("unsatisfied");
    expect(satisfies("1.2.9", "~1.2.0")).toBe("satisfied");
    expect(satisfies("1.3.0", "~1.2.0")).toBe("unsatisfied");
    expect(satisfies("3.12.1", ">=3.9")).toBe("satisfied");
    expect(satisfies("18.0.0", "^16 || ^18")).toBe("satisfied");
    expect(satisfies("1.4.2", "1.x")).toBe("satisfied");
    expect(satisfies("1.4.2", "*")).toBe("satisfied");
  });

  it("says it does not know rather than guessing", () => {
    expect(satisfies("1.0.0", "git+https://example.invalid/repo")).toBe("unknown_range");
    expect(satisfies("not-a-version", ">=1.0.0")).toBe("unknown_range");
  });

  it("orders prereleases below their release", () => {
    const pre = parseVersion("1.0.0-rc.1");
    const release = parseVersion("1.0.0");
    expect(compareVersions(pre!, release!)).toBe(-1);
  });
});

describe("npm adapter", () => {
  it("detects a project from package.json and its lockfile", async () => {
    const detection = await npmAdapter.detect(
      filesOf({ "package.json": '{"name":"x"}', "package-lock.json": "{}" }),
    );
    expect(detection.detected).toBe(true);
    expect(detection.confidence).toBe("high");
    expect(detection.signals).toContain("package-lock.json");
  });

  it("stands down when another Node package manager owns the project", async () => {
    const detection = await npmAdapter.detect(
      filesOf({ "package.json": '{"name":"x"}', "pnpm-lock.yaml": "lockfileVersion: '9.0'" }),
    );
    expect(detection.detected).toBe(false);
    expect(detection.note).toContain("different Node package manager");
  });

  it("records a coverage gap instead of assuming a runtime", async () => {
    const declared = await npmAdapter.readDeclaredState({
      projectDir: "/nowhere",
      files: filesOf({ "package.json": '{"name":"x","dependencies":{"a":"^1.0.0"}}' }),
      platform: { os: "linux", arch: "x64" },
      probe: async () => ({ ok: false, exitCode: null, stdout: "", stderr: "", timedOut: false, notFound: true }),
    });
    expect(declared.packages.map((pkg) => pkg.name)).toEqual(["a"]);
    expect(declared.gaps.map((gap) => gap.area)).toContain("node.runtime");
    expect(declared.gaps.map((gap) => gap.area)).toContain("node.lockfile");
  });

  it("reads an install command as a package addition", () => {
    const effects = npmAdapter.observeProcess({
      argv: ["npm", "install", "left-pad@1.3.0"],
      cwd: "/project",
      startedAt: "2026-08-23T05:00:00.000Z",
      exitCode: 0,
    });
    expect(effects[0]?.kind).toBe("package_added");
    expect(effects[0]?.packages[0]).toEqual({ name: "left-pad", versionSpec: "1.3.0" });
  });

  it("does not attribute an unrelated process to itself", () => {
    expect(npmAdapter.observeProcess({ argv: ["cargo", "add", "serde"], cwd: "/p", startedAt: "", exitCode: 0 })).toEqual([]);
  });

  it("plans a frozen install when a lockfile exists and never edits package.json", () => {
    const plan = npmAdapter.planCommand(
      {
        id: "s",
        kind: "install_project_dependencies",
        adapterId: "node.npm",
        workDir: ".",
        idempotencyKey: "k".repeat(10),
        description: "install",
        manager: "npm",
        manifest: "package.json",
        frozen: true,
        timeoutMs: 60_000,
      },
      materializationContext(),
    );
    expect(plan?.argv).toEqual(["npm", "ci"]);

    const overlay = npmAdapter.planCommand(
      {
        id: "o",
        kind: "apply_package_overlay",
        adapterId: "node.npm",
        workDir: ".",
        idempotencyKey: "k".repeat(10),
        description: "overlay",
        manager: "npm",
        packages: [{ name: "a", versionSpec: "1.0.0", evidenceRefs: ["e"] }],
        timeoutMs: 60_000,
      },
      materializationContext(),
    );
    // `--no-save` is what keeps rescue from touching a tracked file.
    expect(overlay?.argv).toContain("--no-save");
  });

  it("parses every specifier shape npm accepts", () => {
    expect(parseSpecifier("left-pad")).toEqual({ name: "left-pad", versionSpec: "*" });
    expect(parseSpecifier("left-pad@1.0.0")).toEqual({ name: "left-pad", versionSpec: "1.0.0" });
    expect(parseSpecifier("@scope/name")).toEqual({ name: "@scope/name", versionSpec: "*" });
    expect(parseSpecifier("@scope/name@^2")).toEqual({ name: "@scope/name", versionSpec: "^2" });
    expect(parseSpecifier("https://example.invalid/x.tgz")).toBeNull();
  });
});

describe("python adapters", () => {
  it("normalises distribution names the way PEP 503 does", () => {
    expect(normalizePythonName("Flask_Login")).toBe("flask-login");
    expect(normalizePythonName("zope.interface")).toBe("zope-interface");
  });

  it("parses requirement lines and skips directives", () => {
    expect(parseRequirementLine("requests==2.31.0")).toEqual({ name: "requests", versionSpec: "==2.31.0" });
    expect(parseRequirementLine("flask[async]>=3 ; python_version>'3.8'")).toEqual({
      name: "flask",
      versionSpec: ">=3",
    });
    expect(parseRequirementLine("-r other.txt")).toBeNull();
    expect(parseRequirementLine("# a comment")).toBeNull();
  });

  it("hands a uv project to the uv adapter, not to pip", async () => {
    const files = filesOf({ "pyproject.toml": "[project]\nname='x'\n", "uv.lock": "version = 1\n" });
    expect((await uvAdapter.detect(files)).detected).toBe(true);
    expect((await pipAdapter.detect(files)).detected).toBe(false);
  });

  it("declines a Poetry project rather than guessing at it", async () => {
    const files = filesOf({ "pyproject.toml": "[tool.poetry]\nname='x'\n" });
    const detection = await pipAdapter.detect(files);
    expect(detection.detected).toBe(false);
    expect(detection.note).toContain("Poetry");
  });

  it("plans a frozen sync when uv.lock is committed", () => {
    const plan = uvAdapter.planCommand(
      {
        id: "s",
        kind: "install_project_dependencies",
        adapterId: "python.uv",
        workDir: ".",
        idempotencyKey: "k".repeat(10),
        description: "sync",
        manager: "uv",
        manifest: "pyproject.toml",
        lockfile: "uv.lock",
        frozen: true,
        timeoutMs: 60_000,
      },
      materializationContext(),
    );
    expect(plan?.argv).toEqual(["uv", "sync", "--frozen"]);
  });

  it("creates the virtual environment inside the project", () => {
    const plan = pipAdapter.planCommand(
      {
        id: "v",
        kind: "create_virtual_environment",
        adapterId: "python.pip",
        workDir: ".",
        idempotencyKey: "k".repeat(10),
        description: "venv",
        manager: "venv",
        path: ".venv",
        runtimeSpec: ">=3.10",
      },
      materializationContext(),
    );
    expect(plan?.argv).toEqual(["python", "-m", "venv", ".venv"]);
  });
});

describe("pyproject reading", () => {
  it("reads dependencies and requires-python", () => {
    const document = parseToml(
      [
        "[project]",
        'name = "example"',
        'requires-python = ">=3.11"',
        "dependencies = [",
        '  "requests>=2",',
        '  "rich",',
        "]",
        "",
        "[tool.uv]",
        "dev-dependencies = []",
      ].join("\n"),
    );
    expect(tomlString(document, "project.requires-python")).toBe(">=3.11");
    expect(tomlStringArray(document, "project.dependencies")).toEqual(["requests>=2", "rich"]);
    expect(document.unparsed).toEqual([]);
  });

  it("reports what it could not interpret instead of dropping it silently", () => {
    const document = parseToml("[project]\nweird = 2026-08-23T05:00:00Z\n");
    expect(document.unparsed.length).toBeGreaterThan(0);
  });
});

describe("the ecosystem registry", () => {
  it("recognises managers without running anything", async () => {
    const recognized = await recognizeEcosystems(
      filesOf({ "Cargo.toml": "[package]", "Gemfile": "source 'x'", ".tool-versions": "nodejs 22" }),
    );
    const managers = recognized.map((entry) => entry.probe.manager);
    expect(managers).toEqual(expect.arrayContaining(["cargo", "bundler", "asdf"]));
  });

  it("covers every manager the specification names", () => {
    const managers = new Set(ECOSYSTEM_PROBES.map((probe) => probe.manager));
    for (const required of [
      "npm", "pnpm", "yarn", "bun", "pip", "uv", "poetry", "conda", "cargo", "go",
      "maven", "gradle", "nuget", "bundler", "composer", "pub", "mix", "vcpkg",
      "conan", "homebrew", "apt", "chocolatey", "winget", "asdf", "mise", "volta", "sdkman",
    ]) {
      expect(managers, `${required} must be recognised`).toContain(required);
    }
  });

  it("keeps machine-wide managers observe-only", () => {
    for (const probe of ECOSYSTEM_PROBES) {
      if (["homebrew", "apt", "chocolatey", "winget", "conda", "asdf", "mise", "volta", "sdkman"].includes(probe.manager)) {
        expect(probe.support, `${probe.manager} must not claim to change machine state`).toBe("observe_only");
      }
    }
  });

  it("only calls an ecosystem native when an adapter implements the whole loop", () => {
    const registry = defaultRegistry();
    for (const probe of ECOSYSTEM_PROBES.filter((entry) => entry.support === "native")) {
      const adapter = registry.byId(probe.id);
      expect(adapter, `${probe.id} claims native support but has no adapter`).toBeDefined();
      expect(adapter?.manifest.capabilities.materialize).toBe(true);
      expect(adapter?.manifest.capabilities.verify).toBe(true);
      expect(adapter?.manifest.conformanceTested).toBe(true);
    }
  });

  it("reports the truthful support level for a project", async () => {
    const registry = defaultRegistry();
    const native = await registry.supportLevelFor(filesOf({ "package.json": '{"name":"x"}' }));
    expect(native.support).toBe("native");
    // Cargo used to be the example of a recipe here. It is native now, so the
    // example moved rather than the assertion being loosened.
    expect((await registry.supportLevelFor(filesOf({ "Cargo.toml": "[package]" }))).support).toBe("native");

    const recipe = await registry.supportLevelFor(filesOf({ "pom.xml": "<project/>" }));
    expect(recipe.support).toBe("recipe");
    expect(recipe.reason).toContain("reviewed setup recipe");

    const observed = await registry.supportLevelFor(filesOf({ "Brewfile": "brew 'x'" }));
    expect(observed.support).toBe("observe_only");

    const nothing = await registry.supportLevelFor(filesOf({ "README.md": "hello" }));
    expect(nothing.support).toBe("observe_only");
  });
});

describe("the fallback adapter", () => {
  it("compiles to observe_only rather than inventing a command", () => {
    const result = genericAdapter.compile({
      projectDir: "/p",
      platform: { os: "linux", arch: "x64" },
      declared: {
        adapterId: "generic.recipe",
        files: [],
        runtimes: [],
        packages: [],
        systemTools: [],
        secrets: [],
        gaps: [],
      },
      observed: [],
      evidence: [],
      managedDir: ".iwomc",
    });
    expect(result.support).toBe("observe_only");
  });

  it("binds a reviewed recipe to the exact command that was reviewed", () => {
    const step = buildReviewedRecipeStep({
      argv: ["make", "setup"],
      workDir: ".",
      description: "project setup",
      envAllowlist: ["PATH"],
      timeoutMs: 60_000,
      expectedExitCodes: [0],
      reviewedBy: "local:owner",
      reviewedAt: "2026-08-23T05:00:00.000Z",
    });
    expect(step.kind).toBe("run_reviewed_recipe");
    if (step.kind === "run_reviewed_recipe") {
      expect(step.review.approvedCommandDigest).toBe(step.commandDigest);
    }
  });
});

describe("unified diff", () => {
  it("produces a diff a reviewer can read", () => {
    const before = "a\nb\nc\n";
    const after = "a\nB\nc\n";
    const diff = unifiedDiff("file.txt", before, after);
    expect(diff).toContain("--- a/file.txt");
    expect(diff).toContain("+++ b/file.txt");
    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
  });

  it("is empty when nothing changed", () => {
    expect(unifiedDiff("f", "same\n", "same\n")).toBe("");
  });
});

function materializationContext() {
  return {
    projectDir: "/project",
    files: filesOf({}),
    platform: { os: "linux" as const, arch: "x64" as const },
    probe: async () => ({ ok: false, exitCode: null, stdout: "", stderr: "", timedOut: false, notFound: true }),
    managedDir: ".iwomc",
    availableSecretNames: [],
  };
}

describe("noticing a version the repository would not install", () => {
  it("reads exact versions from both npm lockfile layouts", () => {
    // npm 7+ keys a `packages` map by path.
    expect(
      parseLockedVersions(
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { left: "^1.0.0" } },
            "node_modules/left": { version: "1.4.2" },
            // Nested copies are a different package instance; the inventory
            // this is compared against reads the top level only.
            "node_modules/left/node_modules/deep": { version: "9.9.9" },
          },
        }),
      ),
    ).toEqual({ left: "1.4.2" });

    // A `file:` or workspace dependency is recorded as a link whose version
    // lives at the target path. Monorepos are full of these.
    expect(
      parseLockedVersions(
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { vend: "file:./vendor/vend" } },
            "node_modules/vend": { resolved: "vendor/vend", link: true },
            "vendor/vend": { version: "1.0.0" },
          },
        }),
      ),
    ).toEqual({ vend: "1.0.0" });

    // npm 6 nests a `dependencies` tree, and those lockfiles are still in
    // real repositories.
    expect(
      parseLockedVersions(JSON.stringify({ lockfileVersion: 1, dependencies: { old: { version: "0.3.1" } } })),
    ).toEqual({ old: "0.3.1" });
  });

  it("reads nothing from a lockfile it cannot parse, rather than guessing", () => {
    // An empty result disables the comparison, which is the safe direction:
    // no drift reported beats drift invented.
    expect(parseLockedVersions("{ this is not json")).toEqual({});
    expect(parseLockedVersions(null)).toEqual({});
    expect(parseLockedVersions("[]")).toEqual({});
  });

  it("treats a Python exact pin as a lock, and a range as no lock at all", () => {
    expect(
      exactPins([
        { name: "pinned", versionSpec: "==2.1.0" },
        { name: "ranged", versionSpec: ">=1.0" },
        { name: "unbounded", versionSpec: "*" },
        { name: "spaced", versionSpec: "== 3.4.5" },
      ]),
    ).toEqual({ pinned: "2.1.0", spaced: "3.4.5" });
  });
});

describe("pnpm, Yarn, and Bun", () => {
  const files = (present: string[]): ProjectFiles => ({
    entries: present,
    async read() {
      return null;
    },
    async exists(path: string) {
      return present.includes(path);
    },
  });

  const cases = [
    { adapter: pnpmAdapter, manager: "pnpm", lockfile: "pnpm-lock.yaml" },
    { adapter: yarnAdapter, manager: "yarn", lockfile: "yarn.lock" },
    { adapter: bunAdapter, manager: "bun", lockfile: "bun.lockb" },
  ] as const;

  it("each adapter claims only its own project", async () => {
    for (const { adapter, manager, lockfile } of cases) {
      expect((await adapter.detect(files(["package.json", lockfile]))).detected, manager).toBe(true);
      // And not another manager's.
      for (const other of cases) {
        if (other.manager === manager) continue;
        expect(
          (await adapter.detect(files(["package.json", other.lockfile]))).detected,
          `${manager} must not claim a ${other.manager} project`,
        ).toBe(false);
      }
    }
  });

  it("stands aside when npm owns the project", async () => {
    // Two adapters installing the same node_modules would fight over it.
    for (const lockfile of ["package-lock.json", "npm-shrinkwrap.json"]) {
      const detection = await pnpmAdapter.detect(files(["package.json", "pnpm-lock.yaml", lockfile]));
      expect(detection.detected, lockfile).toBe(false);
      expect(detection.note).toContain("npm adapter owns this project");
    }
  });

  it("ignores a directory that is not a Node project", async () => {
    expect((await pnpmAdapter.detect(files(["Cargo.toml"]))).detected).toBe(false);
    expect((await pnpmAdapter.detect(files(["package.json"]))).detected).toBe(false);
  });

  it("can install, and says so honestly", () => {
    for (const { adapter, manager } of cases) {
      expect(adapter.manifest.capabilities.materialize, manager).toBe(true);
      expect(adapter.manifest.capabilities.verify, manager).toBe(true);
      expect(adapter.manifest.support, manager).toBe("native");
      expect(adapter.manifest.id, manager).toBe(`node.${manager}`);
    }
  });

  const planFor = (adapter: (typeof cases)[number]["adapter"], manager: string, frozen: boolean, entries: string[] = []) =>
    adapter.planCommand(
      {
        adapterId: `node.${manager}`,
        kind: "install_project_dependencies",
        manager,
        workDir: ".",
        frozen,
        timeoutMs: 1000,
      } as never,
      { managedDir: "/work/app/.iwomc", files: { entries } } as never,
    );

  it("keeps every manager's cache inside the project", () => {
    // These all keep a machine-wide cache by default. Filling it would be
    // changing the machine, which is the one thing IWOMC promises not to do.
    for (const { adapter, manager } of cases) {
      const values = Object.values(planFor(adapter, manager, true)?.env ?? {});
      expect(
        values.filter((value) => value.startsWith("/work/app/.iwomc")).length,
        `${manager} must redirect its cache into the project`,
      ).toBeGreaterThan(0);
      expect(
        values.some((v) => v.includes("~") || v.startsWith("/home") || v.startsWith("/Users")),
        `${manager} must not reach outside the project`,
      ).toBe(false);
    }
  });

  it("installs exactly the lockfile when one is committed", () => {
    expect(planFor(pnpmAdapter, "pnpm", true)?.argv.join(" ")).toBe("pnpm install --frozen-lockfile");
    expect(planFor(yarnAdapter, "yarn", true)?.argv.join(" ")).toBe("yarn install --frozen-lockfile");
    expect(planFor(bunAdapter, "bun", true)?.argv.join(" ")).toBe("bun install --frozen-lockfile");
    // Without a lockfile there is nothing to freeze.
    expect(planFor(pnpmAdapter, "pnpm", false)?.argv.join(" ")).toBe("pnpm install --no-frozen-lockfile");
  });

  it("uses Yarn Berry's flag when the project is Berry", () => {
    // Berry rejects --frozen-lockfile outright; --immutable is its equivalent,
    // and .yarnrc.yml is how Yarn itself tells the two apart.
    expect(planFor(yarnAdapter, "yarn", true, [".yarnrc.yml"])?.argv.join(" ")).toBe(
      "yarn install --immutable",
    );
  });
});

describe("Poetry", () => {
  const files = (present: string[], contents: Record<string, string> = {}): ProjectFiles => ({
    entries: present,
    async read(path: string) {
      return contents[path] ?? null;
    },
    async exists(path: string) {
      return present.includes(path);
    },
  });

  it("claims a project with a poetry lockfile or a poetry table", async () => {
    expect((await poetryAdapter.detect(files(["poetry.lock", "pyproject.toml"]))).detected).toBe(true);
    expect(
      (
        await poetryAdapter.detect(files(["pyproject.toml"]), )
      ).detected,
    ).toBe(false);
    const withTable = files(["pyproject.toml"], {
      "pyproject.toml": '[tool.poetry]\nname = "x"\n',
    });
    expect((await poetryAdapter.detect(withTable)).detected).toBe(true);
  });

  it("keeps the virtualenv and cache inside the project", () => {
    // Poetry's default is a virtualenv under the user's home. A rescue that
    // built one there would be changing the machine, not the project.
    const plan = poetryAdapter.planCommand(
      {
        adapterId: "python.poetry",
        kind: "install_project_dependencies",
        manager: "poetry",
        workDir: ".",
        frozen: true,
        timeoutMs: 1000,
      } as never,
      { managedDir: "/work/app/.iwomc", files: { entries: [] } } as never,
    );
    expect(plan?.argv.join(" ")).toBe("poetry install --no-root");
    const env = plan?.env ?? {};
    expect(env["POETRY_VIRTUALENVS_IN_PROJECT"]).toBe("true");
    // Set as well as the flag above, because that flag is documented to be
    // ignored in some setups - and this one still lands inside the project.
    expect(env["POETRY_VIRTUALENVS_PATH"]).toContain("/work/app/.iwomc");
    expect(env["POETRY_CACHE_DIR"]).toContain("/work/app/.iwomc");
    for (const value of Object.values(env)) {
      expect(value.startsWith("/home") || value.startsWith("/Users") || value.includes("~")).toBe(false);
    }
  });

  it("installs an undeclared package without rewriting pyproject.toml", () => {
    // `poetry add` would edit the manifest, which a rescue must never do.
    const plan = poetryAdapter.planCommand(
      {
        adapterId: "python.poetry",
        kind: "apply_package_overlay",
        manager: "poetry",
        workDir: ".",
        packages: [{ name: "requests", versionSpec: "==2.32.3", evidenceRefs: ["e"] }],
        timeoutMs: 1000,
      } as never,
      { managedDir: "/m", files: { entries: [] } } as never,
    );
    expect(plan?.argv.join(" ")).toBe("poetry run pip install --no-input requests==2.32.3");
  });
});

describe("Cargo and Go", () => {
  const files = (present: string[], contents: Record<string, string> = {}): ProjectFiles => ({
    entries: present,
    async read(path: string) {
      return contents[path] ?? null;
    },
    async exists(path: string) {
      return present.includes(path);
    },
  });

  const cases = [
    { adapter: cargoAdapter, id: "rust.cargo", manifest: "Cargo.toml", lock: "Cargo.lock" },
    { adapter: goAdapter, id: "go.modules", manifest: "go.mod", lock: "go.sum" },
  ] as const;

  const ctx = (present: string[], contents: Record<string, string>) =>
    ({ projectDir: "/work/app", files: files(present, contents), managedDir: "/work/app/.iwomc" }) as never;

  it("claims a project by its manifest, not by its lockfile alone", async () => {
    for (const { adapter, manifest, lock } of cases) {
      expect((await adapter.detect(files([manifest, lock]))).detected, manifest).toBe(true);
      // A lockfile with no manifest is not a project this can reproduce.
      expect((await adapter.detect(files([lock]))).detected, lock).toBe(false);
      expect((await adapter.detect(files(["package.json"]))).detected, manifest).toBe(false);
    }
  });

  it("keeps every download inside the project", () => {
    // Cargo fills ~/.cargo and Go fills the module cache under the user's home.
    // Either would be changing the machine rather than the project.
    for (const { adapter, id } of cases) {
      const plan = adapter.planCommand(
        {
          adapterId: id,
          kind: "install_project_dependencies",
          workDir: ".",
          frozen: true,
          timeoutMs: 1000,
        } as never,
        { managedDir: "/work/app/.iwomc" } as never,
      );
      const values = Object.values(plan?.env ?? {});
      expect(
        values.filter((value) => value.startsWith("/work/app/.iwomc")).length,
        `${id} must redirect its cache into the project`,
      ).toBeGreaterThan(0);
      expect(
        values.some((v) => v.includes("~") || v.startsWith("/home") || v.startsWith("/Users")),
        `${id} must not reach outside the project`,
      ).toBe(false);
    }
  });

  it("fetches exactly what the lockfile pins", () => {
    const plan = (adapter: (typeof cases)[number]["adapter"], id: string, frozen: boolean) =>
      adapter
        .planCommand(
          { adapterId: id, kind: "install_project_dependencies", workDir: ".", frozen, timeoutMs: 1000 } as never,
          { managedDir: "/m" } as never,
        )
        ?.argv.join(" ");
    // --locked refuses to update Cargo.lock, which is the whole point: a
    // rescue reproduces a version, it never resolves a new one.
    expect(plan(cargoAdapter, "rust.cargo", true)).toBe("cargo fetch --locked");
    expect(plan(cargoAdapter, "rust.cargo", false)).toBe("cargo fetch");
    expect(plan(goAdapter, "go.modules", true)).toBe("go mod download");
  });

  it("reads the dependencies and language version out of Cargo.toml", async () => {
    const declared = await cargoAdapter.readDeclaredState(
      ctx(["Cargo.toml"], {
        "Cargo.toml": [
          "[package]",
          'name = "app"',
          'rust-version = "1.74"',
          "",
          "[dependencies]",
          'serde = "1.0.203"',
          'tokio = { version = "1.38", features = ["full"] }',
          "",
          "[dev-dependencies]",
          'criterion = "0.5"',
        ].join("\n"),
      }),
    );
    const found = Object.fromEntries(declared.packages.map((p) => [p.name, p.versionSpec]));
    expect(found["serde"]).toBe("1.0.203");
    // The table form carries the version in a field rather than inline.
    expect(found["tokio"]).toBe("1.38");
    expect(found["criterion"]).toBe("0.5");
    expect(declared.runtimes.map((r) => r.versionSpec)).toContain("1.74");
  });

  it("reads a go.mod in both the block and the single-line form", async () => {
    const declared = await goAdapter.readDeclaredState(
      ctx(["go.mod"], {
        "go.mod": [
          "module example.com/app",
          "",
          "go 1.22",
          "",
          "require (",
          "\tgithub.com/spf13/cobra v1.8.0",
          "\tgolang.org/x/sync v0.7.0 // indirect",
          ")",
          "",
          "require github.com/stretchr/testify v1.9.0",
        ].join("\n"),
      }),
    );
    const found = Object.fromEntries(declared.packages.map((p) => [p.name, p.versionSpec]));
    expect(found["github.com/spf13/cobra"]).toBe("v1.8.0");
    // The trailing `// indirect` comment must not become part of the version.
    expect(found["golang.org/x/sync"]).toBe("v0.7.0");
    expect(found["github.com/stretchr/testify"]).toBe("v1.9.0");
    expect(declared.runtimes.map((r) => r.versionSpec)).toContain("1.22");
  });

  it("says plainly that it cannot list what is installed", async () => {
    // Neither language keeps dependencies in a readable project folder, so
    // reporting a clean inventory would be reporting a check that never ran.
    for (const { adapter, id } of cases) {
      const result = await adapter.inventory(ctx([], {}));
      expect(result.available, id).toBe(false);
      expect(result.gaps.length, id).toBeGreaterThan(0);
      expect(adapter.manifest.capabilities.inventory, id).toBe(false);
      expect(adapter.manifest.supportNote, id).toContain("cannot inventory");
    }
  });

  it("verifies against the cache the rescue filled, not the machine's", async () => {
    // Probing without the redirected cache would read an empty ~/.cargo and
    // fail a rescue that actually worked.
    const seen: { argv: readonly string[]; env: Record<string, string> }[] = [];
    for (const { adapter, id } of cases) {
      const verification = await adapter.verifyAfterMaterialize({
        projectDir: "/work/app",
        managedDir: "/work/app/.iwomc",
        files: files([], {}),
        async probe(argv: readonly string[], options?: { env?: Record<string, string> }) {
          seen.push({ argv, env: options?.env ?? {} });
          return { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
        },
      } as never);
      expect(verification.satisfied, id).toBe(true);
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]?.argv).toContain("--locked");
    for (const call of seen) {
      expect(Object.values(call.env).some((v) => v.startsWith("/work/app/.iwomc"))).toBe(true);
    }
  });

  it("refuses to claim a rescue worked when the graph does not resolve", async () => {
    const verification = await cargoAdapter.verifyAfterMaterialize({
      projectDir: "/work/app",
      managedDir: "/work/app/.iwomc",
      files: files([], {}),
      async probe() {
        return {
          ok: false,
          exitCode: 101,
          stdout: "",
          stderr: "error: the lock file needs to be updated",
          timedOut: false,
          notFound: false,
        };
      },
    } as never);
    expect(verification.satisfied).toBe(false);
    expect(verification.checks[0]?.detail).toContain("lock file needs to be updated");
  });
});

describe("using what was installed, not just installing it", () => {
  it("hands back the environment Cargo and Go need to find their own cache", () => {
    // A rescue that fetches into the project and then leaves the project's own
    // build command reading the machine-wide cache has installed successfully
    // and fixed nothing. These two find their dependencies only through an
    // environment variable, so the adapter has to say which one.
    for (const adapter of [cargoAdapter, goAdapter]) {
      const environment = adapter.projectEnvironment?.({ managedDir: "/work/app/.iwomc" } as never) ?? {};
      const values = Object.values(environment);
      expect(values.length, adapter.manifest.id).toBeGreaterThan(0);
      expect(
        values.every((value) => value.startsWith("/work/app/.iwomc") || !value.includes("/")),
        `${adapter.manifest.id} must point at the project's own cache`,
      ).toBe(true);
    }
  });

  it("points at exactly the cache the install filled", () => {
    // If these two disagreed, the fetch would fill one directory and the build
    // would read another - which is the bug this exists to prevent.
    for (const adapter of [cargoAdapter, goAdapter]) {
      const install = adapter.planCommand(
        {
          adapterId: adapter.manifest.id,
          kind: "install_project_dependencies",
          workDir: ".",
          frozen: true,
          timeoutMs: 1000,
        } as never,
        { managedDir: "/m" } as never,
      );
      const usage = adapter.projectEnvironment?.({ managedDir: "/m" } as never) ?? {};
      for (const [name, value] of Object.entries(usage)) {
        expect(install?.env?.[name], `${adapter.manifest.id} ${name}`).toBe(value);
      }
    }
  });

  it("asks for nothing where the dependencies are already on a path", () => {
    // npm, pnpm, Yarn, Bun and Poetry all put what they install inside the
    // checkout, where the project's own commands already find it.
    for (const adapter of [npmAdapter, pnpmAdapter, poetryAdapter]) {
      expect(adapter.projectEnvironment, adapter.manifest.id).toBeUndefined();
    }
  });
});

import { describe, expect, it } from "vitest";
import { defaultRegistry, ECOSYSTEM_PROBES, recognizeEcosystems } from "./registry.js";
import { npmAdapter, parseSpecifier, parseLockedVersions } from "./npm.js";
import {
  pipAdapter,
  uvAdapter,
  normalizePythonName,
  parseRequirementLine,
  exactPins,
} from "./python.js";
import { genericAdapter, buildReviewedRecipeStep } from "./generic.js";
import { nodeObserverAdapter } from "./node-observer.js";
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

    const recipe = await registry.supportLevelFor(filesOf({ "Cargo.toml": "[package]" }));
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

describe("watching a Node project npm does not own", () => {
  const files = (present: string[]): ProjectFiles => ({
    entries: present,
    async read() {
      return null;
    },
    async exists(path: string) {
      return present.includes(path);
    },
  });

  it("claims a pnpm, Yarn, or Bun project", async () => {
    for (const lockfile of ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"]) {
      const detection = await nodeObserverAdapter.detect(files(["package.json", lockfile]));
      expect(detection.detected, lockfile).toBe(true);
    }
  });

  it("stands aside when npm owns the project", async () => {
    // Both adapters inventorying the same node_modules would put every
    // install in the log twice.
    for (const lockfile of ["package-lock.json", "npm-shrinkwrap.json"]) {
      const detection = await nodeObserverAdapter.detect(
        files(["package.json", "pnpm-lock.yaml", lockfile]),
      );
      expect(detection.detected, lockfile).toBe(false);
      expect(detection.note).toContain("npm adapter owns this project");
    }
  });

  it("ignores a directory that is not a Node project at all", async () => {
    expect((await nodeObserverAdapter.detect(files(["Cargo.toml"]))).detected).toBe(false);
    // A package.json with no lockfile is npm's business, not this adapter's.
    expect((await nodeObserverAdapter.detect(files(["package.json"]))).detected).toBe(false);
  });

  it("can read what is installed but never install anything", () => {
    const caps = nodeObserverAdapter.manifest.capabilities;
    expect(caps.inventory).toBe(true);
    expect(caps.detect).toBe(true);
    // The honesty that matters: it must not be able to act on a project it
    // cannot correctly repair.
    expect(caps.materialize).toBe(false);
    expect(caps.compile).toBe(false);
    expect(caps.verify).toBe(false);
    expect(nodeObserverAdapter.manifest.support).not.toBe("native");
    expect(nodeObserverAdapter.planCommand()).toBeNull();
  });

  it("says it cannot repair the project rather than trying", () => {
    const result = nodeObserverAdapter.compile({} as never);
    expect(result.support).toBe("observe_only");
    expect("reason" in result && result.reason).toContain("does not run until it has been taught");
  });
});

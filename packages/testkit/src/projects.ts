import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe, run } from "@iwomc/companion";

/**
 * Temporary-project factories (task 10.1).
 *
 * Every project is generated at test time with a randomized name and path, so
 * no production code path can quietly depend on a staged package, a fixed
 * project, or a demo directory. Nothing here is imported by the product.
 */

export interface TempProject {
  /** Absolute path of the working checkout. */
  readonly dir: string;
  /** Absolute path of the bare origin the checkouts were cloned from. */
  readonly originDir: string;
  readonly name: string;
  readonly commit: string;
  /** Clone the same revision into a second, independent checkout. */
  clone(): Promise<string>;
  cleanup(): Promise<void>;
}

export function randomName(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString("hex")}`;
}

async function git(args: readonly string[], cwd: string): Promise<void> {
  const result = await run(["git", ...args], { cwd, timeoutMs: 60_000, envAllowlist: null });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
}

async function initRepository(dir: string): Promise<void> {
  await git(["init", "--quiet", "--initial-branch", "main"], dir);
  await git(["config", "user.email", "testkit@iwomc.invalid"], dir);
  await git(["config", "user.name", "IWOMC Testkit"], dir);
  await git(["config", "commit.gpgsign", "false"], dir);
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(["add", "-A"], dir);
  await git(["commit", "--quiet", "--no-gpg-sign", "-m", message], dir);
  const head = await probe(["git", "rev-parse", "HEAD"], { cwd: dir, timeoutMs: 30_000 });
  return head.stdout.trim();
}

export interface CreateProjectOptions {
  /** Extra files written into the checkout before the first commit. */
  readonly files?: Readonly<Record<string, string>>;
  readonly root?: string;
}

/**
 * Create a repository with an origin so two independent checkouts share one
 * canonical remote fingerprint - the situation IWOMC is built for.
 */
export async function createRepository(
  prefix: string,
  files: Readonly<Record<string, string>>,
  options: { root?: string } = {},
): Promise<TempProject> {
  // When the caller supplies a root, several projects share it, so cleanup must
  // remove only what this factory created - never the shared directory itself.
  const ownsRoot = options.root === undefined;
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "iwomc-test-")));
  const name = randomName(prefix);
  const created: string[] = [];
  const originDir = join(root, `${name}.git`);
  const workDir = join(root, `${name}-a`);

  created.push(originDir, workDir);
  await mkdir(originDir, { recursive: true });
  await run(["git", "init", "--quiet", "--bare", "--initial-branch", "main", "."], {
    cwd: originDir,
    timeoutMs: 60_000,
    envAllowlist: null,
  });

  await mkdir(workDir, { recursive: true });
  await initRepository(workDir);
  for (const [path, content] of Object.entries(files)) {
    const target = join(workDir, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  const commit = await commitAll(workDir, "initial");
  await git(["remote", "add", "origin", originDir], workDir);
  await git(["push", "--quiet", "origin", "main"], workDir);

  let cloneIndex = 0;
  return {
    dir: workDir,
    originDir,
    name,
    commit,
    async clone() {
      cloneIndex += 1;
      const target = join(root, `${name}-${String.fromCharCode(98 + cloneIndex - 1)}`);
      created.push(target);
      await run(["git", "clone", "--quiet", originDir, target], {
        cwd: root,
        timeoutMs: 120_000,
        envAllowlist: null,
      });
      await git(["config", "user.email", "testkit@iwomc.invalid"], target);
      await git(["config", "user.name", "IWOMC Testkit"], target);
      return target;
    },
    async cleanup() {
      if (ownsRoot) {
        await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
        return;
      }
      for (const path of created) {
        await rm(path, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Node project
// ---------------------------------------------------------------------------

export interface NodeProjectResult extends TempProject {
  /** Name of the vendored dependency the project declares. */
  readonly declaredDependency: string;
  /** Name of a package installed here but never declared, when requested. */
  readonly undeclaredDependency: string | null;
}

/**
 * A Node project whose proof command fails until its dependencies are
 * installed. The dependency is vendored inside the repository as a `file:`
 * dependency so the whole flow runs offline and cannot be confused with a
 * hard-coded public package.
 */
export async function createNodeProject(
  options: { withUndeclared?: boolean; root?: string; engines?: string } = {},
): Promise<NodeProjectResult> {
  const declared = randomName("declared");
  const undeclared = options.withUndeclared ? randomName("undeclared") : null;

  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(
      {
        name: randomName("iwomc-fixture"),
        version: "1.0.0",
        private: true,
        ...(options.engines ? { engines: { node: options.engines } } : {}),
        scripts: { proof: "node ./scripts/proof.mjs" },
        dependencies: { [declared]: `file:./vendor/${declared}` },
      },
      null,
      2,
    )}\n`,
    [`vendor/${declared}/package.json`]: `${JSON.stringify(
      { name: declared, version: "1.0.0", main: "index.js" },
      null,
      2,
    )}\n`,
    [`vendor/${declared}/index.js`]: "module.exports = { ok: true };\n",
    "scripts/proof.mjs": [
      "import { createRequire } from 'node:module';",
      "const require = createRequire(import.meta.url);",
      `const dependency = require(${JSON.stringify(declared)});`,
      "if (!dependency.ok) {",
      "  console.error('the declared dependency did not load correctly');",
      "  process.exit(1);",
      "}",
      "console.log('proof: the project can load its dependencies');",
      "",
    ].join("\n"),
    ".gitignore": "node_modules/\n.iwomc/\n",
    "README.md": "A repository generated by the IWOMC testkit at test time.\n",
  };

  const project = await createRepository("node-fixture", files, options.root ? { root: options.root } : {});

  // Run the real install first, then commit whatever npm settled on. Capturing
  // from a clean worktree is a product requirement, so the fixture must not
  // leave npm's own edits to package.json or the lockfile uncommitted.
  await installNodeProject(project.dir);
  await run(["git", "add", "-A"], { cwd: project.dir, timeoutMs: 60_000, envAllowlist: null });
  await run(["git", "commit", "--quiet", "--no-gpg-sign", "-m", "install dependencies"], {
    cwd: project.dir,
    timeoutMs: 60_000,
    envAllowlist: null,
  });
  await run(["git", "push", "--quiet", "origin", "main"], {
    cwd: project.dir,
    timeoutMs: 120_000,
    envAllowlist: null,
  });
  const head = await probe(["git", "rev-parse", "HEAD"], { cwd: project.dir, timeoutMs: 30_000 });

  return {
    ...project,
    commit: head.stdout.trim(),
    declaredDependency: declared,
    undeclaredDependency: undeclared,
  };
}

/** Run the project's real install so the checkout genuinely works. */
export async function installNodeProject(dir: string): Promise<void> {
  const result = await run(["npm", "install", "--no-audit", "--no-fund"], {
    cwd: dir,
    timeoutMs: 600_000,
    envAllowlist: null,
  });
  if (result.exitCode !== 0) {
    throw new Error(`npm install failed in ${dir}: ${result.stderr || result.stdout}`);
  }
}

/**
 * Place a package into node_modules that the repository never declares - the
 * shape of "an agent installed something and forgot to write it down".
 */
export async function installUndeclaredPackage(dir: string, name: string, version = "2.3.4"): Promise<void> {
  const target = join(dir, "node_modules", ...name.split("/"));
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "package.json"),
    `${JSON.stringify({ name, version, main: "index.js" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(target, "index.js"), "module.exports = { ok: true };\n", "utf8");
}

// ---------------------------------------------------------------------------
// Python project
// ---------------------------------------------------------------------------

export interface PythonProjectResult extends TempProject {
  readonly moduleName: string;
}

/**
 * A Python project whose proof command needs a project-local virtual
 * environment. The dependency is a vendored source directory, so the flow does
 * not depend on a package index being reachable.
 */
export async function createPythonProject(options: { root?: string } = {}): Promise<PythonProjectResult> {
  const moduleName = randomName("fixture").replace(/-/gu, "_");
  const files: Record<string, string> = {
    "requirements.txt": `./vendor/${moduleName}\n`,
    [`vendor/${moduleName}/pyproject.toml`]: [
      "[build-system]",
      'requires = ["setuptools"]',
      'build-backend = "setuptools.build_meta"',
      "",
      "[project]",
      `name = "${moduleName}"`,
      'version = "1.0.0"',
      "",
      "[tool.setuptools]",
      `packages = ["${moduleName}"]`,
      "",
    ].join("\n"),
    [`vendor/${moduleName}/${moduleName}/__init__.py`]: "OK = True\n",
    "proof.py": [
      "import sys",
      `import ${moduleName}`,
      `if not ${moduleName}.OK:`,
      "    sys.exit(1)",
      "print('proof: the project can import its dependencies')",
      "",
    ].join("\n"),
    ".gitignore": ".venv/\n.iwomc/\n__pycache__/\n",
    "README.md": "A repository generated by the IWOMC testkit at test time.\n",
  };
  const project = await createRepository("python-fixture", files, options.root ? { root: options.root } : {});
  return { ...project, moduleName };
}

// ---------------------------------------------------------------------------
// Adapter-neutral project
// ---------------------------------------------------------------------------

/**
 * A project no native adapter owns. IWOMC must report `observe_only` for it
 * rather than inventing a setup command.
 */
export async function createRecipeProject(options: { root?: string } = {}): Promise<TempProject> {
  const files: Record<string, string> = {
    "Makefile": "setup:\n\t@echo prepared\n\ncheck:\n\t@echo ok\n",
    "src/main.txt": "an ecosystem IWOMC does not natively support\n",
    "README.md": "A repository generated by the IWOMC testkit at test time.\n",
  };
  return await createRepository("neutral-fixture", files, options.root ? { root: options.root } : {});
}

/** Copy a directory tree, used to build a second broken checkout by hand. */
export async function copyTree(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true });
}

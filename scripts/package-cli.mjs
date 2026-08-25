/**
 * Build a self-contained npm package for the IWOMC CLI.
 *
 * The development repo is a pnpm workspace. npm users must not need that
 * workspace or unpublished @iwomc/* packages, so this script copies each
 * compiled internal package into bundledDependencies. The resulting tarball
 * installs with ordinary `npm install -g iwomc`.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = join(root, "release", "iwomc");
// A feature release: the package timeline, autocapture, team contract
// selection, and cross-platform application.
const CLI_VERSION = "0.4.0";

const internal = ["contracts", "adapters", "companion", "control-plane", "integrations"];

await rm(release, { recursive: true, force: true });
await mkdir(join(release, "bin"), { recursive: true });

await cp(join(root, "apps", "cli", "dist"), join(release, "apps", "cli", "dist"), { recursive: true });
await cp(join(root, "apps", "console", "dist"), join(release, "apps", "console", "dist"), { recursive: true });

for (const name of internal) {
  const source = join(root, "packages", name);
  const target = join(release, "node_modules", "@iwomc", name);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  manifest.dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).map(([dependency, version]) => [
      dependency,
      version === "workspace:*" ? "0.1.0" : version,
    ]),
  );
  delete manifest.devDependencies;
  // Modal is loaded dynamically only for paid clean verification. Keeping it
  // out of the core CLI package prevents its native optional dependency tree
  // from breaking ordinary macOS installs.
  delete manifest.optionalDependencies;
  await mkdir(target, { recursive: true });
  await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
  await writeFile(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

await writeFile(
  join(release, "bin", "iwomc.js"),
  '#!/usr/bin/env node\nimport "../apps/cli/dist/bin.js";\n',
);

// Windows cannot preserve POSIX executable bits in an npm tarball. Restore
// the launcher's mode during install so the global `iwomc` symlink works on
// macOS and Linux as well as Windows.
await mkdir(join(release, "scripts"), { recursive: true });
await writeFile(
  join(release, "scripts", "postinstall.mjs"),
  `import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
await chmod(join(packageRoot, "bin", "iwomc.js"), 0o755).catch(() => {});
`,
);

await writeFile(
  join(release, "package.json"),
  `${JSON.stringify(
    {
      name: "iwomc",
      version: CLI_VERSION,
      description: "It Works On My Computer - find out why a teammate's checkout fails, and fix it.",
      type: "module",
      bin: { iwomc: "./bin/iwomc.js" },
      scripts: { postinstall: "node ./scripts/postinstall.mjs" },
      engines: { node: ">=22.5.0" },
      files: ["bin", "apps", "node_modules", "scripts", "README.md", "LICENSE"],
      dependencies: Object.fromEntries(internal.map((name) => [`@iwomc/${name}`, "0.1.0"])),
      bundledDependencies: internal.map((name) => `@iwomc/${name}`),
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/Carldtitan/Environment_Drift.git" },
      homepage: "https://iwomc-web-production.up.railway.app",
      bugs: { url: "https://github.com/Carldtitan/Environment_Drift/issues" },
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  join(release, "README.md"),
  [
    "# IWOMC",
    "",
    "**It Works On My Computer.** IWOMC finds out why, and fixes it.",
    "",
    "Your teammate clones the commit you just pushed. Your app runs. Theirs does not.",
    "Usually the difference is not in the code - it is on your disk. A package that got",
    "installed but never added to `package.json`. A version that had to be rolled back.",
    "A virtual environment set up by hand weeks ago.",
    "",
    "IWOMC records what your machine actually has, ties it to the exact Git commit, and",
    "uses that to make the other machine work - then proves it by running your own test",
    "command. It says `working` only when that command passes.",
    "",
    "## Install",
    "",
    "```bash",
    "npm install -g iwomc",
    "```",
    "",
    "Node.js 22.5 or newer. No Docker, no account, no server.",
    "",
    "## Use it",
    "",
    "On the checkout that works:",
    "",
    "```bash",
    'iwomc init --proof "npm test"',
    "iwomc capture",
    "iwomc verify",
    "```",
    "",
    "On the checkout that is broken:",
    "",
    "```bash",
    "iwomc rescue --approve",
    "```",
    "",
    "Then, so nobody hits it again:",
    "",
    "```bash",
    "iwomc promote          # show an ordinary diff that fixes the repository",
    "iwomc promote --apply",
    "```",
    "",
    "## Keep a history",
    "",
    "A contract describes one commit. To answer *what was installed at 2pm last Tuesday*",
    "- or to catch a downgrade, which a snapshot cannot express - leave the recorder on:",
    "",
    "```bash",
    "iwomc daemon status                       # a recorder starts by itself; this shows it",
    "iwomc timeline <commit>                   # what was installed at that commit",
    "iwomc diff <their-commit> <your-commit>   # what is different between the two",
    "```",
    "",
    "The recorder starts the first time you use IWOMC in a project and tells you it",
    "has. It reads your project's package folders and nothing else: it never runs a",
    "package manager, never looks outside the projects you registered, never edits a",
    "tracked file, and never uploads your history. `iwomc daemon disable` stops it.",
    "",
    "## For coding agents",
    "",
    "`iwomc mcp` exposes the same workflow as typed MCP tools. Anything that changes",
    "your machine refuses to run without explicit confirmation. Run `iwomc agent-docs`",
    "for the full reference offline.",
    "",
    "## Across operating systems",
    "",
    "The person whose machine works is often not on your operating system. IWOMC",
    "applies their contract anyway when nothing in it is restricted to one platform,",
    "and says it was proven elsewhere rather than implying otherwise. When something",
    "*is* restricted - a build tool's per-platform binary, say - it refuses and names",
    "the package instead of giving you a generic mismatch to diagnose.",
    "",
    "## Supported today",
    "",
    "Nine package managers are detected, recorded, repaired, and verified:",
    "",
    "| Ecosystem | Managers |",
    "| --- | --- |",
    "| Node.js | npm, pnpm, Yarn, Bun |",
    "| Python | pip, uv, Poetry |",
    "| Rust | Cargo |",
    "| Go | Go modules |",
    "",
    "Every one of them installs inside your project folder only. Each keeps a",
    "machine-wide cache by default - `~/.cargo`, `~/.npm`, Go's module cache - and IWOMC",
    "redirects every one into the project's own `.iwomc` directory, so a rescue never",
    "changes anything outside the checkout it was pointed at.",
    "",
    "Nineteen more are recognised and reported honestly as not yet repairable, rather",
    "than claimed as supported. `iwomc status` names the level for the project you are",
    "in.",
    "",
    "## More",
    "",
    "Source, documentation, and issues: https://github.com/Carldtitan/Environment_Drift",
    "",
    "MIT licensed.",
    "",
  ].join("\n"),
);

// A published package that claims MIT in its metadata must carry the licence
// text alongside it.
await cp(join(root, "LICENSE"), join(release, "LICENSE"));

// The version the CLI prints and the version being published must match, or
// a bug report names a build that does not exist.
const cliSource = await readFile(join(root, "apps", "cli", "src", "cli.ts"), "utf8");
const declared = /CLI_VERSION = "([^"]+)"/.exec(cliSource)?.[1];
if (declared !== CLI_VERSION) {
  throw new Error(
    `apps/cli/src/cli.ts says ${declared}, this script says ${CLI_VERSION}. They must agree.`,
  );
}

console.log(`npm package staged at ${release}`);

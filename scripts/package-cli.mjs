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
      version: "0.1.3",
      description: "Rescue a teammate's broken checkout from a verified environment contract.",
      type: "module",
      bin: { iwomc: "./bin/iwomc.js" },
      scripts: { postinstall: "node ./scripts/postinstall.mjs" },
      engines: { node: ">=22.5.0" },
      files: ["bin", "apps", "node_modules", "scripts", "README.md"],
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
  `# IWOMC Rescue

IWOMC makes a teammate's broken checkout runnable from a verified environment contract.

## Install

\`\`\`bash
npm install -g iwomc
\`\`\`

## Use

In a checkout that already works:

\`\`\`bash
iwomc init --proof "npm test"
iwomc capture
iwomc verify
\`\`\`

In a teammate's broken checkout:

\`\`\`bash
iwomc rescue --approve
\`\`\`

Open the hosted team console at https://iwomc-web-production.up.railway.app.
`,
);

console.log(`npm package staged at ${release}`);

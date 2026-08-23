#!/usr/bin/env node
/**
 * The no-staged-demo check (task 1.1, 1.3, 7.1).
 *
 * Production source must contain no sample workspace, no staged package, no
 * sponsor panel, no fabricated run, and no success word outside the shared
 * state vocabulary. Test fixtures may create anything they like at runtime;
 * production code may not ship it.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_STATES, RESCUE_RUN_STATES, SUPPORT_LEVELS, INTEGRATION_STATUSES } from "@iwomc/contracts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Source that ships to a user. Tests, fixtures, and scripts are excluded. */
const PRODUCTION_ROOTS = [
  "packages/contracts/src",
  "packages/adapters/src",
  "packages/companion/src",
  "packages/integrations/src",
  "packages/control-plane/src",
  "apps/cli/src",
  "apps/console/src",
];

const SKIP = /\.test\.tsx?$/u;

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly why: string;
  /** Files where the match is legitimate, with the reason. */
  readonly allow?: (path: string, line: string) => boolean;
}

const RULES: Rule[] = [
  {
    name: "retired product paths",
    pattern: /\b(fireworks|braintrust|daytona|greptile)\b/iu,
    why: "these product paths were retired from the active architecture",
  },
  {
    name: "sponsor or demo surfaces",
    pattern: /\b(sponsor|demo-run|demoRun|sampleData|mockData|fakeData|dummyData|lorem ipsum)\b/iu,
    why: "the product ships no sponsor panel and no sample records",
  },
  {
    name: "placeholder identities",
    pattern: /\b(john doe|jane doe|acme corp|example\.com\/team|foo@bar)\b/iu,
    why: "a staged teammate must not appear in production source",
  },
  {
    name: "ad hoc success vocabulary",
    // The shared vocabulary has no `success`, `ok`, or `green` state.
    pattern: /["'`](success|succeeded|green|all good|everything works)["'`]/iu,
    why: "every state must come from the shared vocabulary in packages/contracts/src/states.ts",
    allow: (path, line) =>
      // `succeeded` is a materialization-step phase, not a rescue state; it is
      // declared as such in the executor's own union. A comment that names the
      // banned words in order to ban them is also fine.
      /\bphase\b|\bjournal|outcome\.status|step\.status/u.test(line) ||
      line.trimStart().startsWith("*") ||
      line.trimStart().startsWith("//") ||
      path.endsWith("store.ts") ||
      path.endsWith("materialize.ts"),
  },
  {
    name: "hard-coded public package names",
    pattern: /["'](express|react-router|left-pad|lodash|axios|requests|flask|django)["']/u,
    why: "no ecosystem-specific package may be named in production source",
  },
];

const problems: string[] = [];
let scanned = 0;

async function walk(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (!/\.(ts|tsx|css|html)$/u.test(extname(entry.name) ? entry.name : "")) continue;
    if (SKIP.test(entry.name)) continue;

    const relativePath = relative(root, full).replace(/\\/gu, "/");
    scanned += 1;
    const body = await readFile(full, "utf8");
    const lines = body.split(/\r?\n/u);

    for (const rule of RULES) {
      lines.forEach((line, index) => {
        if (!rule.pattern.test(line)) return;
        if (rule.allow?.(relativePath, line)) return;
        problems.push(`${relativePath}:${index + 1} ${rule.name} - ${rule.why}\n    ${line.trim().slice(0, 120)}`);
      });
    }
  }
}

for (const dir of PRODUCTION_ROOTS) {
  await walk(join(root, dir));
}

// The state vocabulary must have exactly one home.
const statesPath = join(root, "packages/contracts/src/states.ts");
const states = await readFile(statesPath, "utf8");
for (const value of [...CONTRACT_STATES, ...RESCUE_RUN_STATES, ...SUPPORT_LEVELS, ...INTEGRATION_STATUSES]) {
  if (!states.includes(`"${value}"`)) {
    problems.push(`packages/contracts/src/states.ts does not declare the state "${value}"`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`honesty: ${problems.length} finding(s)\n`);
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.exit(1);
}

process.stdout.write(
  `honesty: ${scanned} production files scanned; no staged data, retired product path, or ad hoc success word found.\n`,
);

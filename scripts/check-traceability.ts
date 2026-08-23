#!/usr/bin/env node
/**
 * Requirement traceability (task 1.2).
 *
 * Fails when a requirement has no implementation reference, no test reference,
 * or points at a file that does not exist. A table that drifts from the tree is
 * worse than no table, so this runs in `pnpm run verify`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tablePath = join(root, "docs", "traceability.md");

const REQUIREMENT_COUNT = 13;

function fail(message: string): never {
  process.stderr.write(`traceability: ${message}\n`);
  process.exit(1);
}

if (!existsSync(tablePath)) fail(`${tablePath} is missing`);
const body = readFileSync(tablePath, "utf8");

interface Row {
  readonly requirement: string;
  readonly implementation: string[];
  readonly tests: string[];
}

const rows: Row[] = [];
for (const line of body.split(/\r?\n/u)) {
  const match = /^\|\s*(R\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/u.exec(line.trim());
  if (!match) continue;
  rows.push({
    requirement: match[1] as string,
    implementation: paths(match[3] as string),
    tests: paths(match[4] as string),
  });
}

function paths(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/gu)].map((entry) => entry[1] as string);
}

const problems: string[] = [];
const seen = new Set<string>();

for (const row of rows) {
  seen.add(row.requirement);
  if (row.implementation.length === 0) {
    problems.push(`${row.requirement} names no implementation module`);
  }
  if (row.tests.length === 0) {
    problems.push(`${row.requirement} names no test`);
  }
  for (const path of [...row.implementation, ...row.tests]) {
    if (!existsSync(join(root, path))) {
      problems.push(`${row.requirement} points at ${path}, which does not exist`);
    }
  }
  for (const path of row.tests) {
    if (!/\.test\.tsx?$/u.test(path)) {
      problems.push(`${row.requirement} lists ${path} as a test, but it is not a test file`);
    }
  }
}

for (let index = 1; index <= REQUIREMENT_COUNT; index += 1) {
  if (!seen.has(`R${index}`)) problems.push(`R${index} has no row in the table`);
}

// Every capability listed as credential-blocked must still have an interface.
for (const match of body.matchAll(/^\|\s*[^|]+\|\s*`([^`]+)`\s*\|/gmu)) {
  const path = match[1] as string;
  if (path.includes("/") && !existsSync(join(root, path))) {
    problems.push(`the blocked-capability table points at ${path}, which does not exist`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`traceability: ${problem}\n`);
  process.exit(1);
}

process.stdout.write(
  `traceability: ${rows.length} requirements, every one with a module and a test that exist.\n`,
);

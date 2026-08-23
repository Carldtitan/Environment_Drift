#!/usr/bin/env node
/**
 * The capability matrix (task 11.2).
 *
 * Generated from adapter metadata, never hand-written. An adapter may only be
 * listed as `native` when it implements the whole loop and has a conformance
 * test, so the documentation cannot claim more than the code does.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRegistry, ECOSYSTEM_PROBES } from "@iwomc/adapters";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "docs", "capability-matrix.md");
const check = process.argv.includes("--check");

const registry = defaultRegistry();
const problems: string[] = [];

for (const probe of ECOSYSTEM_PROBES) {
  if (probe.support !== "native") continue;
  const adapter = registry.byId(probe.id);
  if (!adapter) {
    problems.push(`${probe.id} is listed as native but no adapter implements it`);
    continue;
  }
  const capabilities = adapter.manifest.capabilities;
  for (const [name, present] of Object.entries(capabilities)) {
    if (!present) problems.push(`${probe.id} claims native support but does not implement ${name}`);
  }
  if (!adapter.manifest.conformanceTested) {
    problems.push(`${probe.id} claims native support but has no conformance test`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`capability-matrix: ${problem}\n`);
  process.exit(1);
}

const SUPPORT_WORDS: Record<string, string> = {
  native: "**native** - IWOMC compiles, materializes, and verifies this itself",
  recipe: "**recipe** - recognised; rescue needs a reviewed setup command",
  observe_only: "**observe only** - recorded, never changed by IWOMC",
};

const lines: string[] = [];
lines.push("# Capability matrix");
lines.push("");
lines.push("Generated from adapter metadata by `pnpm run capability-matrix`. Do not edit by hand.");
lines.push("");
lines.push("Recognising a package manager is not the same as supporting it. This table states");
lines.push("what this build can actually do for each one.");
lines.push("");
lines.push("| Ecosystem | Manager | Support | Detected from | Note |");
lines.push("| --- | --- | --- | --- | --- |");

for (const probe of ECOSYSTEM_PROBES) {
  lines.push(
    `| ${probe.ecosystem} | ${probe.manager} | ${SUPPORT_WORDS[probe.support] ?? probe.support} | ${probe.files
      .map((file) => `\`${file}\``)
      .join(", ")} | ${probe.note} |`,
  );
}

lines.push("");
lines.push("## What each native adapter implements");
lines.push("");
lines.push("| Adapter | detect | declared state | inventory | compile | materialize | verify | conformance test |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const adapter of registry.all) {
  const capabilities = adapter.manifest.capabilities;
  const tick = (value: boolean) => (value ? "yes" : "no");
  lines.push(
    `| \`${adapter.manifest.id}\` | ${tick(capabilities.detect)} | ${tick(capabilities.readDeclaredState)} | ${tick(
      capabilities.inventory,
    )} | ${tick(capabilities.compile)} | ${tick(capabilities.materialize)} | ${tick(capabilities.verify)} | ${tick(
      adapter.manifest.conformanceTested,
    )} |`,
  );
}

lines.push("");
lines.push("## Why some managers are deliberately observe-only");
lines.push("");
lines.push("A rescue must never silently change machine-wide state. System package managers,");
lines.push("global toolchain managers, and runtime version managers therefore stay observe-only:");
lines.push("IWOMC reports what a project needs from them and blocks with that name when it is");
lines.push("missing, rather than installing it for you.");
lines.push("");

const rendered = `${lines.join("\n")}`;

if (check) {
  let current = "";
  try {
    current = await readFile(target, "utf8");
  } catch {
    current = "";
  }
  if (current.trim() !== rendered.trim()) {
    process.stderr.write("capability-matrix: docs/capability-matrix.md is out of date. Run `pnpm run capability-matrix`.\n");
    process.exit(1);
  }
  process.stdout.write("capability-matrix: up to date.\n");
} else {
  await writeFile(target, rendered, "utf8");
  process.stdout.write(`capability-matrix: wrote ${target}\n`);
}

#!/usr/bin/env node
/**
 * Repository secret scan (task 11.3).
 *
 * Runs the product's own redaction classifier over every tracked source file.
 * If the thing that guards outbound payloads finds credential-shaped material
 * in the repository, that is a finding - the same rule, applied inward.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Redactor } from "@iwomc/contracts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".git",
  "artifacts",
  "coverage",
  ".turbo",
]);

const SCANNED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".css",
  ".html",
  ".yaml",
  ".yml",
  ".toml",
  ".example",
  "",
]);

/**
 * Files that legitimately contain credential *shapes*: the classifier's own
 * patterns, and the tests that prove the classifier catches them.
 */
const ALLOWED = new Set([
  "packages/contracts/src/redaction.ts",
  "packages/contracts/src/contracts.test.ts",
  "packages/integrations/src/claude-mem.test.ts",
  "packages/companion/src/companion.test.ts",
  "packages/companion/src/windows-shim.ts",
  "scripts/secret-scan.ts",
]);

/**
 * Categories that identify a credential *value*. The classifier also flags
 * name-shaped things such as `authorization:` headers and `token:` fields,
 * which is correct for an outbound payload and wrong for source code - source
 * code is full of those identifiers by design. A repository scan therefore
 * looks only for material that could be an actual secret.
 */
const VALUE_SHAPED = new Set([
  "private_key_block",
  "vendor_token",
  "json_web_token",
  "url_credentials",
  "high_entropy_blob",
]);

/** A quoted literal long and mixed enough to be a generated credential. */
const SUSPICIOUS_LITERAL = /["'`]([A-Za-z0-9+/=_-]{40,})["'`]/gu;

function looksGenerated(value: string): boolean {
  const classes =
    Number(/[a-z]/u.test(value)) +
    Number(/[A-Z]/u.test(value)) +
    Number(/[0-9]/u.test(value)) +
    Number(/[_+/=-]/u.test(value));
  if (classes < 3) return false;
  if (/^(?:sha256:)?[0-9a-f]+$/u.test(value)) return false; // a digest
  if (/^[a-z]+(?:-[a-z]+)+$/u.test(value)) return false; // kebab-case words
  if (repeatsAToken(value)) return false; // structured text, not entropy
  return new Set(value).size >= 16;
}

/**
 * A generated credential does not say the same four letters three times. A
 * long identifier - `github_user_secrets_user_id_users_id_fk` - does.
 */
function repeatsAToken(value: string): boolean {
  for (let size = 4; size <= 10 && size * 3 <= value.length; size += 1) {
    const counts = new Map<string, number>();
    for (let index = 0; index + size <= value.length; index += 1) {
      const token = value.slice(index, index + size);
      const next = (counts.get(token) ?? 0) + 1;
      if (next >= 3) return true;
      counts.set(token, next);
    }
  }
  return false;
}

const redactor = new Redactor();
const findings: string[] = [];
let scanned = 0;

async function walk(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example" && entry.name !== ".gitignore") {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await walk(full);
      continue;
    }
    const relativePath = relative(root, full).replace(/\\/gu, "/");
    if (ALLOWED.has(relativePath)) continue;
    if (!SCANNED_EXTENSIONS.has(extname(entry.name))) continue;

    const info = await stat(full);
    if (info.size > 2 * 1024 * 1024) continue;

    scanned += 1;
    const body = await readFile(full, "utf8");

    const result = redactor.redactText(body, relativePath);
    for (const finding of result.findings) {
      if (!VALUE_SHAPED.has(finding.category)) continue;
      findings.push(`${relativePath}: ${finding.category} (${finding.length} characters)`);
    }

    for (const match of body.matchAll(SUSPICIOUS_LITERAL)) {
      const literal = match[1] as string;
      if (!looksGenerated(literal)) continue;
      findings.push(
        `${relativePath}: a ${literal.length}-character generated-looking literal is committed`,
      );
    }
  }
}

await walk(root);

// An environment template must name variables and supply no values.
const templatePath = join(root, ".env.example");
try {
  const template = await readFile(templatePath, "utf8");
  for (const line of template.split(/\r?\n/u)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.+)$/u.exec(line);
    if (match && (match[2] ?? "").trim().length > 0) {
      findings.push(`.env.example: ${match[1]} has a value; a template names variables only`);
    }
  }
} catch {
  findings.push(".env.example is missing; there is no template to check");
}

if (findings.length > 0) {
  process.stderr.write(`secret-scan: ${findings.length} finding(s)\n`);
  for (const finding of findings) process.stderr.write(`  ${finding}\n`);
  process.exit(1);
}

process.stdout.write(
  `secret-scan: ${scanned} files scanned with the product's own classifier, no credential-shaped material found.\n`,
);

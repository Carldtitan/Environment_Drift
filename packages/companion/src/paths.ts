import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Project-relative directory IWOMC is allowed to create and write into. */
export const MANAGED_DIR = ".iwomc";

/**
 * Everything IWOMC keeps on a developer machine lives under one root so it can
 * be inspected, backed up, or deleted as a unit.
 *
 * `IWOMC_HOME` overrides it, which is what the tests use to keep runs isolated
 * from the developer's real device identity.
 */
/**
 * Keep `.iwomc` out of the person's `git status` without touching a tracked
 * file.
 *
 * The directory holds this project's package caches, so on a Rust or Go or
 * pnpm project it is large. Left unignored it is untracked noise at best and
 * an accidental commit of a whole dependency cache at worst. Editing the
 * repository's `.gitignore` would be changing a tracked file on someone's
 * behalf, which IWOMC does not do; `.git/info/exclude` is the local,
 * uncommitted equivalent and is the right place for a tool's own directory.
 *
 * Returns true when the line was added, false when it was already there or
 * when there is no `.git` directory to write into. Never throws: failing to
 * tidy a `git status` is not a reason to fail a command.
 */
export async function excludeManagedDirLocally(projectDir: string): Promise<boolean> {
  const infoDir = join(projectDir, ".git", "info");
  const excludeFile = join(infoDir, "exclude");
  const line = `/${MANAGED_DIR}/`;
  try {
    // A worktree or submodule has a `.git` file rather than a directory. There
    // is nothing to write in that case, and guessing at the real git directory
    // would be reaching outside the folder we were pointed at.
    const gitPath = join(projectDir, ".git");
    const gitStat = await stat(gitPath).catch(() => null);
    if (!gitStat?.isDirectory()) return false;

    let current = "";
    try {
      current = await readFile(excludeFile, "utf8");
    } catch {
      current = "";
    }
    const present = current
      .split(/\r?\n/u)
      .some((entry) => entry.trim() === line || entry.trim() === MANAGED_DIR || entry.trim() === `${MANAGED_DIR}/`);
    if (present) return false;

    await mkdir(infoDir, { recursive: true });
    const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    await appendFile(
      excludeFile,
      `${prefix}# Added by IWOMC: its working directory, including this project's package caches.\n${line}\n`,
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

export function iwomcHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["IWOMC_HOME"];
  if (override && override.trim().length > 0) return resolve(override);
  return join(homedir(), ".iwomc");
}

export function storePath(env?: NodeJS.ProcessEnv): string {
  return join(iwomcHome(env), "companion.sqlite");
}

export function keyFilePath(env?: NodeJS.ProcessEnv): string {
  return join(iwomcHome(env), "device.key");
}

export function configPath(env?: NodeJS.ProcessEnv): string {
  return join(iwomcHome(env), "config.json");
}

export function logsDir(env?: NodeJS.ProcessEnv): string {
  return join(iwomcHome(env), "logs");
}

export function verificationWorkDir(env?: NodeJS.ProcessEnv): string {
  return join(iwomcHome(env), "verifications");
}

/** Absolute path of the project-local managed directory. */
export function managedDirFor(projectDir: string): string {
  return join(projectDir, MANAGED_DIR);
}

/**
 * Resolve a project-relative path and refuse anything that escapes the project
 * root. Used before every filesystem write a contract asks for (task 3.3).
 */
export function resolveInsideProject(projectDir: string, relative: string): string | null {
  if (relative.includes("\0")) return null;
  const root = resolve(projectDir);
  const target = resolve(root, relative);
  const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
  const targetKey = process.platform === "win32" ? target.toLowerCase() : target;
  if (targetKey !== rootKey && !targetKey.startsWith(rootKey + (process.platform === "win32" ? "\\" : "/"))) {
    return null;
  }
  return target;
}

/** Same as above, but additionally requires the path to be managed by IWOMC. */
export function resolveInsideManagedDir(projectDir: string, relative: string): string | null {
  const target = resolveInsideProject(projectDir, relative);
  if (target === null) return null;
  const managed = resolve(managedDirFor(projectDir));
  const managedKey = process.platform === "win32" ? managed.toLowerCase() : managed;
  const targetKey = process.platform === "win32" ? target.toLowerCase() : target;
  if (targetKey !== managedKey && !targetKey.startsWith(managedKey + (process.platform === "win32" ? "\\" : "/"))) {
    return null;
  }
  return target;
}

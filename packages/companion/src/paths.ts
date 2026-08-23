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

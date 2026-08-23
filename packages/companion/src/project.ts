import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { blocked, digestBytes } from "@iwomc/contracts";
import type { FileDigest, PlatformTarget, SourceReference } from "@iwomc/contracts";
import type { ProjectFiles } from "@iwomc/adapters";
import { readGitBlob, readGitFacts, subdirectoryOf, type GitFacts } from "./git.js";
import type { CompanionStore, ProjectBinding } from "./store.js";
import { MANAGED_DIR } from "./paths.js";

/**
 * Project binding (task 3.1).
 *
 * A binding maps a project id to a local checkout only after the checkout's
 * canonical remote fingerprint and subdirectory match. The absolute path lives
 * on the device; a control-plane job carries the project id and nothing else.
 */

export class FileSystemProjectFiles implements ProjectFiles {
  readonly #root: string;
  #entries: string[] | null = null;

  constructor(root: string) {
    this.#root = root;
  }

  get entries(): readonly string[] {
    return this.#entries ?? [];
  }

  async load(): Promise<this> {
    try {
      const names = await readdir(this.#root, { withFileTypes: true });
      this.#entries = names.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
    } catch {
      this.#entries = [];
    }
    return this;
  }

  async read(path: string): Promise<string | null> {
    const target = safeJoin(this.#root, path);
    if (target === null) return null;
    try {
      return await readFile(target, "utf8");
    } catch {
      return null;
    }
  }

  async exists(path: string): Promise<boolean> {
    const target = safeJoin(this.#root, path);
    if (target === null) return false;
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  }
}

function safeJoin(root: string, relativePath: string): string | null {
  if (relativePath.includes("\0")) return null;
  const target = resolve(root, relativePath);
  const rootResolved = resolve(root);
  const rootKey = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved;
  const targetKey = process.platform === "win32" ? target.toLowerCase() : target;
  if (targetKey !== rootKey && !targetKey.startsWith(rootKey + (process.platform === "win32" ? "\\" : "/"))) {
    return null;
  }
  return target;
}

export interface ProjectContext {
  readonly binding: ProjectBinding;
  readonly git: GitFacts;
  readonly projectDir: string;
  readonly files: FileSystemProjectFiles;
  readonly platform: PlatformTarget;
}

export interface BindOptions {
  readonly workspaceId?: string | null;
  readonly projectName?: string;
  readonly now?: () => string;
}

/**
 * Create or return the binding for the checkout that contains `dir`.
 * Refuses when an existing binding for the same identity points elsewhere.
 */
export async function bindProject(
  store: CompanionStore,
  dir: string,
  platform: PlatformTarget,
  options: BindOptions = {},
): Promise<ProjectContext> {
  const projectDir = resolve(dir);
  const git = await readGitFacts(projectDir);
  const subdirectory = subdirectoryOf(git.repositoryRoot, projectDir);
  const workspaceId = options.workspaceId ?? null;
  const now = options.now ?? (() => new Date().toISOString());

  let binding = store.findBindingByIdentity(git.canonicalRemoteDigest, subdirectory, workspaceId);
  if (binding && !samePath(binding.checkoutPath, projectDir)) {
    // The same project identity is already bound to a different local path.
    // Re-point it: a developer may legitimately move or re-clone a checkout.
    binding = { ...binding, checkoutPath: projectDir };
    store.saveBinding(binding);
  }
  if (!binding) {
    binding = {
      projectId: randomUUID(),
      workspaceId,
      projectName: options.projectName ?? basename(projectDir),
      canonicalRemoteDigest: git.canonicalRemoteDigest,
      subdirectory,
      checkoutPath: projectDir,
      createdAt: now(),
    };
    store.saveBinding(binding);
  }

  const files = await new FileSystemProjectFiles(projectDir).load();
  return { binding, git, projectDir, files, platform };
}

/** Resolve an already-registered binding for the checkout containing `dir`. */
export async function resolveBoundProject(
  store: CompanionStore,
  dir: string,
  platform: PlatformTarget,
  workspaceId: string | null = null,
): Promise<ProjectContext | null> {
  const projectDir = resolve(dir);
  const git = await readGitFacts(projectDir);
  const subdirectory = subdirectoryOf(git.repositoryRoot, projectDir);
  const binding = store.findBindingByIdentity(git.canonicalRemoteDigest, subdirectory, workspaceId);
  if (!binding) return null;
  const files = await new FileSystemProjectFiles(projectDir).load();
  return { binding, git, projectDir, files, platform };
}

/**
 * Map a control-plane job's project id to a local checkout. The job never
 * carries a path, so this is the only way a remote request reaches a directory,
 * and a mismatch is blocked rather than rerouted (R10.4).
 */
export async function resolveBindingForJob(
  store: CompanionStore,
  projectId: string,
  platform: PlatformTarget,
): Promise<ProjectContext> {
  const binding = store.findBindingById(projectId);
  if (!binding) {
    blocked(
      "no_project_binding",
      `This device has no checkout registered for project ${projectId}.`,
      "Open the project checkout on this machine and run `iwomc init`.",
    );
  }
  const git = await readGitFacts(binding.checkoutPath).catch(() => null);
  if (git === null) {
    blocked(
      "no_project_binding",
      `The registered checkout for project ${projectId} is no longer a Git repository.`,
      "Re-run `iwomc init` from the current checkout.",
    );
  }
  if (git.canonicalRemoteDigest !== binding.canonicalRemoteDigest) {
    blocked(
      "remote_mismatch",
      "The registered checkout now points at a different Git remote.",
      "Re-run `iwomc init` from the correct checkout.",
    );
  }
  const subdirectory = subdirectoryOf(git.repositoryRoot, binding.checkoutPath);
  if (subdirectory !== binding.subdirectory) {
    blocked(
      "subdirectory_mismatch",
      "The registered checkout no longer resolves to the same repository subdirectory.",
      "Re-run `iwomc init` from the correct project directory.",
    );
  }
  const files = await new FileSystemProjectFiles(binding.checkoutPath).load();
  return { binding, git, projectDir: binding.checkoutPath, files, platform };
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export interface DigestOptions {
  /** Revision whose canonical blob content should be digested. */
  readonly commit?: string;
  /** Repository-relative paths that differ from the commit in this worktree. */
  readonly dirtyPaths?: ReadonlySet<string>;
  /** Repository-relative prefix of the project inside the repository. */
  readonly subdirectory?: string;
}

/**
 * Files whose contents define the declared environment. Their digests are what
 * a rescue checks to confirm the checkout matches the captured source.
 *
 * For a tracked, unmodified file the digest is taken over Git's canonical blob
 * content, not the bytes on disk. Checkout filters such as `core.autocrlf`
 * rewrite working-tree bytes per machine, so digesting them would make two
 * correct checkouts of the same commit disagree. A modified or untracked file
 * is digested from disk, which is the only content that exists for it.
 */
export async function digestDeclaredFiles(
  projectDir: string,
  paths: readonly string[],
  options: DigestOptions = {},
): Promise<FileDigest[]> {
  const out: FileDigest[] = [];
  const prefix =
    options.subdirectory && options.subdirectory !== "." ? `${options.subdirectory}/` : "";

  for (const path of [...new Set(paths)].sort()) {
    const repositoryPath = `${prefix}${path}`;
    if (options.commit && !options.dirtyPaths?.has(repositoryPath)) {
      const blob = await readGitBlob(projectDir, options.commit, repositoryPath);
      if (blob !== null) {
        out.push({ path, digest: digestBytes(blob), bytes: blob.byteLength });
        continue;
      }
    }
    const target = safeJoin(projectDir, path);
    if (target === null) continue;
    try {
      const body = await readFile(target);
      out.push({ path, digest: digestBytes(body), bytes: body.byteLength });
    } catch {
      // A declared file that is absent here is a real difference, so it simply
      // does not appear; the comparison reports the missing entry.
    }
  }
  return out;
}

export function buildSourceReference(
  git: GitFacts,
  subdirectory: string,
  declaredFileDigests: readonly FileDigest[],
): SourceReference {
  return {
    commit: git.commit,
    canonicalRemoteDigest: git.canonicalRemoteDigest,
    subdirectory,
    declaredFileDigests: [...declaredFileDigests],
    worktreeDirty: git.worktreeDirty,
    ...(git.branch ? { branch: git.branch } : {}),
  };
}

/** Project-relative POSIX path of the IWOMC-managed directory. */
export function managedDirRelative(): string {
  return MANAGED_DIR;
}

export function toPosixRelative(root: string, target: string): string {
  return relative(root, target).replace(/\\/gu, "/");
}

export { join as joinPath };

import { spawn } from "node:child_process";
import { digestBytes } from "@iwomc/contracts";
import { probe, resolveExecutable } from "./exec.js";

/**
 * Git facts IWOMC needs. Every call is read-only: capture and rescue must never
 * change the user's Git state (R4.1).
 */

export interface GitFacts {
  readonly repositoryRoot: string;
  readonly commit: string;
  readonly branch: string | null;
  readonly remoteUrl: string | null;
  readonly canonicalRemote: string | null;
  /**
   * Fingerprint of the repository this checkout belongs to.
   *
   * Named for the remote because that is what identifies a repository once one
   * exists. Without a remote it falls back to the root commit, which is just
   * as stable and, unlike "no remote", is actually different between two
   * different repositories.
   */
  readonly canonicalRemoteDigest: string;
  /** First commit in this history, or null in a repository with no commits. */
  readonly rootCommit: string | null;
  readonly worktreeDirty: boolean;
  readonly dirtyPaths: readonly string[];
}

export class NotAGitRepositoryError extends Error {
  constructor(dir: string) {
    super(`${dir} is not inside a Git repository`);
    this.name = "NotAGitRepositoryError";
  }
}

async function git(args: readonly string[], cwd: string, timeoutMs = 30_000) {
  return await probe(["git", ...args], { cwd, timeoutMs });
}

/**
 * Normalize a remote URL so `git@host:org/repo.git`, `https://host/org/repo`,
 * and `ssh://git@host/org/repo.git` all fingerprint identically, while
 * credentials embedded in the URL are dropped rather than hashed.
 */
export function canonicalizeRemote(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  let host: string;
  let path: string;

  const scpLike = /^(?:([^@/]+)@)?([^:/]+):(.+)$/u.exec(trimmed);
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed);

  if (hasScheme) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname;
  } else if (scpLike) {
    host = (scpLike[2] as string).toLowerCase();
    path = scpLike[3] as string;
  } else if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(trimmed)) {
    // A local path remote: normalize separators and case-fold on Windows.
    const normalized = trimmed.replace(/\\/gu, "/").replace(/\/+$/u, "");
    return `file:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
  } else {
    return null;
  }

  path = path.replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (path.toLowerCase().endsWith(".git")) path = path.slice(0, -4);
  if (path.length === 0) return null;
  return `${host}/${path.toLowerCase()}`;
}

/**
 * A stable identity for the repository a checkout belongs to.
 *
 * A shared remote is the right answer whenever there is one: two clones of the
 * same repository are the same project, wherever they sit on disk.
 *
 * Without a remote, the old answer was a single constant - which made *every*
 * local-only repository on a machine the same project, so one project's
 * contracts could be offered for another's code. The root commit is the
 * natural replacement: stable across moves and re-clones, and genuinely
 * different between different repositories.
 *
 * A repository with no commits at all has neither, so it falls back to its
 * path. Identity then changes on the first commit, which `bindProject` handles
 * by adopting the existing binding rather than orphaning it.
 */
export function remoteDigest(
  canonical: string | null,
  fallback: { rootCommit?: string | null; projectDir?: string } = {},
): string {
  if (canonical !== null) return digestBytes(`iwomc:remote:${canonical}`);
  if (fallback.rootCommit) return digestBytes(`iwomc:root-commit:${fallback.rootCommit}`);
  if (fallback.projectDir) {
    const normalized = fallback.projectDir.replace(/\\/gu, "/").replace(/\/+$/u, "");
    return digestBytes(
      `iwomc:local-path:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`,
    );
  }
  return digestBytes("iwomc:no-remote");
}

/**
 * The first commit in this history.
 *
 * A grafted or merged history can have several roots; the smallest is taken so
 * two checkouts of the same repository always agree.
 */
export async function readRootCommit(dir: string): Promise<string | null> {
  const result = await git(["rev-list", "--max-parents=0", "HEAD"], dir, 15_000);
  if (!result.ok) return null;
  const roots = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{40}$/u.test(line))
    .sort();
  return roots[0] ?? null;
}

export async function readGitFacts(dir: string): Promise<GitFacts> {
  const root = await git(["rev-parse", "--show-toplevel"], dir);
  if (!root.ok) throw new NotAGitRepositoryError(dir);
  const repositoryRoot = root.stdout.trim().replace(/\\/gu, "/");

  const head = await git(["rev-parse", "HEAD"], dir);
  const commit = head.ok ? head.stdout.trim() : "";

  const branchResult = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  const branchName = branchResult.ok ? branchResult.stdout.trim() : "";
  const branch = branchName.length > 0 && branchName !== "HEAD" ? branchName : null;

  let remoteUrl: string | null = null;
  const origin = await git(["remote", "get-url", "origin"], dir);
  if (origin.ok && origin.stdout.trim().length > 0) {
    remoteUrl = origin.stdout.trim();
  } else {
    const remotes = await git(["remote"], dir);
    const first = remotes.stdout.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean)[0];
    if (first) {
      const url = await git(["remote", "get-url", first], dir);
      if (url.ok) remoteUrl = url.stdout.trim();
    }
  }

  const canonicalRemote = remoteUrl === null ? null : canonicalizeRemote(remoteUrl);
  const rootCommit = canonicalRemote === null ? await readRootCommit(dir) : null;

  const status = await git(["status", "--porcelain=v1", "--untracked-files=normal"], dir);
  const dirtyPaths = status.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(2).trim().replace(/^"|"$/gu, ""));

  return {
    repositoryRoot,
    commit,
    branch,
    remoteUrl,
    canonicalRemote,
    canonicalRemoteDigest: remoteDigest(canonicalRemote, { rootCommit, projectDir: dir }),
    rootCommit,
    worktreeDirty: dirtyPaths.length > 0,
    dirtyPaths,
  };
}

export interface HeadState {
  readonly commit: string | null;
  readonly branch: string | null;
}

/**
 * Just the revision and branch.
 *
 * `readGitFacts` also runs `git status`, which walks the whole worktree. The
 * watcher asks for the revision on every sweep and for the dirty flag only
 * when something actually changed, so a large repository does not pay for a
 * full status scan once a minute.
 */
export async function readHeadState(dir: string): Promise<HeadState> {
  const head = await git(["rev-parse", "HEAD"], dir, 10_000);
  if (!head.ok) return { commit: null, branch: null };
  const branchResult = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir, 10_000);
  const branchName = branchResult.ok ? branchResult.stdout.trim() : "";
  return {
    commit: head.stdout.trim() || null,
    branch: branchName.length > 0 && branchName !== "HEAD" ? branchName : null,
  };
}

/** True when the worktree has uncommitted or untracked changes. */
export async function readWorktreeDirty(dir: string): Promise<boolean> {
  const status = await git(["status", "--porcelain=v1", "--untracked-files=normal"], dir);
  if (!status.ok) return false;
  return status.stdout.split("\n").some((line) => line.trim().length > 0);
}

/** Repository-relative POSIX path of `dir` inside its repository. */
export function subdirectoryOf(repositoryRoot: string, dir: string): string {
  const root = repositoryRoot.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const target = dir.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
  const targetKey = process.platform === "win32" ? target.toLowerCase() : target;
  if (targetKey === rootKey) return ".";
  if (!targetKey.startsWith(`${rootKey}/`)) return ".";
  return target.slice(root.length + 1);
}

/**
 * Turn anything Git understands into a full commit sha.
 *
 * People type what `git log --oneline` shows them - a short hash - and they
 * also reasonably type `HEAD~1`, a branch name, or a tag. Requiring a full
 * forty-character sha would be technically defensible and practically useless.
 * Returns null when the checkout does not know the reference.
 */
export async function expandCommit(dir: string, reference: string): Promise<string | null> {
  const trimmed = reference.trim();
  if (trimmed.length === 0) return null;
  // `^{commit}` makes this fail on a tree or a blob rather than returning one.
  const result = await git(["rev-parse", "--verify", "--quiet", `${trimmed}^{commit}`], dir, 10_000);
  if (!result.ok) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/u.test(sha) ? sha : null;
}

/** True when a commit exists in this checkout. */
export async function hasCommit(dir: string, commit: string): Promise<boolean> {
  const result = await git(["cat-file", "-e", `${commit}^{commit}`], dir);
  return result.ok;
}

/**
 * Read a file's canonical Git content at a revision, as raw bytes.
 *
 * Working-tree bytes are not comparable across machines: `core.autocrlf`,
 * `.gitattributes`, and filter drivers all rewrite them on checkout. Two
 * checkouts of the same commit therefore hold different bytes for the same
 * file, which would make a declared-file digest comparison fail for a reason
 * that has nothing to do with the environment. The blob content is what "the
 * same revision" actually means, so that is what IWOMC digests.
 */
export async function readGitBlob(
  dir: string,
  commit: string,
  path: string,
): Promise<Buffer | null> {
  const executable = await resolveExecutable("git", dir);
  if (executable === null) return null;
  return await new Promise<Buffer | null>((resolvePromise) => {
    const child = spawn(executable, ["show", `${commit}:${path}`], {
      cwd: dir,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      // A declared file larger than this is not a manifest; refuse rather than
      // buffer it.
      if (bytes <= 8 * 1024 * 1024) chunks.push(chunk);
    });
    child.on("error", () => resolvePromise(null));
    child.on("close", (code) => {
      resolvePromise(code === 0 ? Buffer.concat(chunks) : null);
    });
  });
}

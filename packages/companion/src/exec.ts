import { spawn } from "node:child_process";
import { access, constants, readdir, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { boundLog, defaultRedactor, type Redactor } from "@iwomc/contracts";
import { planSpawn } from "./windows-shim.js";

/**
 * Bounded process execution.
 *
 * Every command IWOMC runs - probes, materialization steps, and the proof
 * command - goes through here. There is no `shell: true` anywhere: argv arrays
 * are passed to the resolved executable directly, so a contract value can never
 * become shell syntax.
 */

export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Extra environment entries merged over the allowlisted base environment. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Names of the caller's environment variables the child may inherit.
   * `null` means inherit everything (used for probes that need a real PATH).
   */
  readonly envAllowlist?: readonly string[] | null;
  readonly maxOutputBytes?: number;
  readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  readonly signal?: AbortSignal;
  readonly redactor?: Redactor;
}

export interface RunResult {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly notFound: boolean;
  readonly durationMs: number;
  readonly truncated: boolean;
}

const DEFAULT_MAX_OUTPUT = 512 * 1024;

/**
 * Variables a child always needs in order to run at all. Everything else must
 * be named by the contract's environment allowlist.
 */
const BASE_ENV_NAMES = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "windir",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "SHELL",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "SYSTEMDRIVE",
];

export function buildEnvironment(
  allowlist: readonly string[] | null | undefined,
  extra: Readonly<Record<string, string>> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (allowlist === null) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) out[key] = value;
    }
  } else {
    const names = new Set([...BASE_ENV_NAMES, ...(allowlist ?? [])]);
    for (const name of names) {
      const value = source[name];
      if (value !== undefined) out[name] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) out[key] = value;
  return out;
}

const executableCache = new Map<string, string | null>();

/**
 * Resolve an executable name against PATH, including Windows `.cmd`/`.exe`
 * wrappers. Resolving explicitly is what lets IWOMC avoid `shell: true`.
 */
export async function resolveExecutable(
  name: string,
  cwd: string,
  env: Record<string, string> = process.env as Record<string, string>,
): Promise<string | null> {
  if (name.includes("/") || name.includes("\\")) {
    const candidate = isAbsolute(name) ? name : resolve(cwd, name);
    return (await isExecutableFile(candidate)) ? candidate : await withExtensions(candidate);
  }

  const pathValue = env["PATH"] ?? env["Path"] ?? "";
  const cacheKey = `${process.platform}:${pathValue}:${name}`;
  const cached = executableCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const extensions =
    process.platform === "win32"
      ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];

  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext.toLowerCase()}`);
      if (await isExecutableFile(candidate)) {
        executableCache.set(cacheKey, candidate);
        return candidate;
      }
    }
    if (process.platform === "win32") {
      // PATHEXT casing varies; fall back to a directory listing match.
      const found = await findCaseInsensitive(dir, name, extensions);
      if (found) {
        executableCache.set(cacheKey, found);
        return found;
      }
    }
  }
  executableCache.set(cacheKey, null);
  return null;
}

async function withExtensions(candidate: string): Promise<string | null> {
  if (process.platform !== "win32") return null;
  for (const ext of [".cmd", ".exe", ".bat", ".com"]) {
    if (await isExecutableFile(candidate + ext)) return candidate + ext;
  }
  return null;
}

async function findCaseInsensitive(
  dir: string,
  name: string,
  extensions: readonly string[],
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const wanted = new Set(extensions.map((ext) => `${name}${ext}`.toLowerCase()));
  for (const entry of entries) {
    if (wanted.has(entry.toLowerCase())) return join(dir, entry);
  }
  return null;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    if (process.platform === "win32") return true;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function run(argv: readonly string[], options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const [name, ...args] = argv;
  if (name === undefined) {
    throw new Error("run() requires at least an executable name");
  }
  const env = buildEnvironment(options.envAllowlist, options.env ?? {});
  const executable = await resolveExecutable(name, options.cwd, env);
  if (executable === null) {
    return {
      argv,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: `${name} was not found on PATH`,
      timedOut: false,
      notFound: true,
      durationMs: Date.now() - started,
      truncated: false,
    };
  }

  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const redactor = options.redactor ?? defaultRedactor;

  // Windows batch shims cannot be spawned directly; see windows-shim.ts.
  const plan = planSpawn(executable, args);

  return await new Promise<RunResult>((resolvePromise) => {
    const child = spawn(plan.executable, [...plan.args], {
      cwd: options.cwd,
      env,
      windowsHide: true,
      // Never `shell: true`: argv must reach the process verbatim.
      shell: false,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Give the child a moment to exit cleanly before forcing it.
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, options.timeoutMs);
    timer.unref();

    const onAbort = () => {
      timedOut = true;
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const safe = redactor.redactText(text).value;
      options.onOutput?.(stream, safe);
      if (stream === "stdout") {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes <= maxOutput) stdout += safe;
        else truncated = true;
      } else {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= maxOutput) stderr += safe;
        else truncated = true;
      }
    };

    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));

    const finish = (exitCode: number | null, signalName: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        argv,
        exitCode,
        signal: signalName,
        stdout: boundLog(stdout, maxOutput, redactor).text,
        stderr: boundLog(error ? `${stderr}\n${error.message}` : stderr, maxOutput, redactor).text,
        timedOut,
        notFound: false,
        durationMs: Date.now() - started,
        truncated,
      });
    };

    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signalName) => finish(code, signalName));
  });
}

/** A probe: short, read-only, and inherits the caller's real environment. */
export async function probe(
  argv: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
}> {
  const result = await run(argv, {
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? 30_000,
    envAllowlist: null,
    maxOutputBytes: 64 * 1024,
  });
  return {
    ok: result.exitCode === 0 && !result.notFound && !result.timedOut,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    notFound: result.notFound,
  };
}

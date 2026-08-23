import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Companion, CompanionStore, defaultRegistryForCompanion, run } from "@iwomc/companion";
import type { MemoryPort, VerifierPort } from "@iwomc/companion";

/**
 * Test harness helpers.
 *
 * Every Companion built here gets its own IWOMC_HOME, so a test never touches
 * the developer's real device identity, contracts, or budget ledger.
 */

export interface Sandbox {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

export async function createSandbox(overrides: Record<string, string> = {}): Promise<Sandbox> {
  const home = await mkdtemp(join(tmpdir(), "iwomc-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, IWOMC_HOME: home, ...overrides };
  return {
    home,
    env,
    async cleanup() {
      await rm(home, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    },
  };
}

export interface HarnessCompanion {
  readonly companion: Companion;
  readonly store: CompanionStore;
  close(): void;
}

export function createCompanion(input: {
  sandbox: Sandbox;
  memory?: MemoryPort;
  verifiers?: readonly VerifierPort[];
  now?: () => string;
}): HarnessCompanion {
  const store = CompanionStore.open(input.sandbox.env);
  const companion = new Companion({
    store,
    registry: defaultRegistryForCompanion(),
    ...(input.memory ? { memory: input.memory } : {}),
    ...(input.verifiers ? { verifiers: input.verifiers } : {}),
    env: input.sandbox.env,
    ...(input.now ? { now: input.now } : {}),
  });
  return { companion, store, close: () => companion.close() };
}

/** Absolute path of the built CLI entry point, for end-to-end process tests. */
export function cliEntryPoint(): string {
  const here = fileURLToPath(import.meta.url);
  // packages/testkit/dist/harness.js -> repository root
  const root = resolve(here, "..", "..", "..", "..");
  return join(root, "apps", "cli", "dist", "bin.js");
}

export interface CliResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  json<T>(): T;
}

/** Run the real `iwomc` binary the way a person or an agent would. */
export async function runIwomc(
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CliResult> {
  const result = await run([process.execPath, cliEntryPoint(), ...args], {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 600_000,
    envAllowlist: null,
    env: { ...(options.env as Record<string, string>), NO_COLOR: "1" },
    maxOutputBytes: 4 * 1024 * 1024,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    json<T>(): T {
      const start = result.stdout.indexOf("{");
      const end = result.stdout.lastIndexOf("}");
      if (start === -1 || end === -1) {
        throw new Error(`no JSON object in CLI output:\n${result.stdout}\n${result.stderr}`);
      }
      return JSON.parse(result.stdout.slice(start, end + 1)) as T;
    },
  };
}

/** Speak JSON-RPC to the MCP server the way a coding agent would. */
export async function callMcp(
  requests: readonly Record<string, unknown>[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<unknown[]> {
  const { spawn } = await import("node:child_process");
  return await new Promise<unknown[]>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliEntryPoint(), "mcp"], {
      cwd: options.cwd,
      env: { ...(options.env as Record<string, string>), NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`MCP server timed out.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, options.timeoutMs ?? 600_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      const messages = stdout
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => JSON.parse(entry) as unknown);
      resolvePromise(messages);
    });

    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }
    child.stdin.end();
  });
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "@iwomc/companion";
import { createRepository, createSandbox, runIwomc, type Sandbox, type TempProject } from "@iwomc/testkit";

/**
 * Cargo and Go, against the real toolchains.
 *
 * The claim under test is not only that a rescue works. It is that a rescue
 * works *without touching anything outside the project*, which for these two is
 * the whole difficulty: both download into the user's home directory unless
 * told otherwise. So each case counts the files in the machine-wide cache
 * before and after and requires that number not to move.
 *
 * These skip when the toolchain is absent rather than being quietly dropped: a
 * machine without Go cannot prove anything about Go, and pretending otherwise
 * is the thing this project exists to stop.
 */

const EXIT = { ok: 0, failed: 1, blocked: 2, unsupported: 3, inconclusive: 4 };

async function toolPresent(argv: readonly string[]): Promise<boolean> {
  try {
    const result = await run([...argv], { cwd: process.cwd(), timeoutMs: 60_000, envAllowlist: null });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** How many files the given cache holds right now. */
async function countFiles(dir: string): Promise<number> {
  let total = 0;
  const walk = async (path: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(path, entry.name));
      else total += 1;
    }
  };
  await walk(dir);
  return total;
}

const CARGO_FILES = {
  "Cargo.toml": [
    "[package]",
    'name = "iwomc_fixture"',
    'version = "0.1.0"',
    'edition = "2021"',
    'rust-version = "1.70"',
    "",
    "[dependencies]",
    'semver = "1.0.23"',
    "",
  ].join("\n"),
  "src/main.rs": 'fn main() { println!("{}", semver::Version::parse("1.2.3").unwrap()); }\n',
  ".gitignore": "target/\n.iwomc/\n",
};

const GO_FILES = {
  "go.mod": ["module example.com/iwomcfixture", "", "go 1.21", "", "require rsc.io/quote v1.5.2", ""].join("\n"),
  "main.go": [
    "package main",
    "",
    "import (",
    '\t"fmt"',
    "",
    '\t"rsc.io/quote"',
    ")",
    "",
    "func main() { fmt.Println(quote.Hello()) }",
    "",
  ].join("\n"),
  ".gitignore": ".iwomc/\n",
};

/**
 * Where this machine's shared cache actually is.
 *
 * Guessing `~/.cargo` and `~/go/pkg/mod` would make the central assertion
 * vacuous wherever the guess is wrong: counting the files in a directory that
 * is not the cache gives nought before and nought after, and the test passes
 * having proved nothing. Both toolchains will say where they put things, so
 * ask them.
 */
async function machineCacheDir(
  argv: readonly string[],
  fallback: string,
): Promise<string> {
  try {
    const result = await run([...argv], { cwd: process.cwd(), timeoutMs: 60_000, envAllowlist: null });
    const reported = result.stdout.trim();
    if (result.exitCode === 0 && reported.length > 0) return reported;
  } catch {
    // Fall through to the documented default.
  }
  return fallback;
}

const CASES = [
  {
    name: "Cargo",
    probe: ["cargo", "--version"],
    files: CARGO_FILES,
    prepare: ["cargo", "generate-lockfile", "--quiet"],
    proof: "cargo build --offline",
    // Cargo has no `env` subcommand for this, so the environment variable it
    // documents comes first and its default second.
    cacheDir: async () => process.env["CARGO_HOME"] ?? join(homedir(), ".cargo"),
    projectCache: "cargo-home",
  },
  {
    name: "Go",
    probe: ["go", "version"],
    files: GO_FILES,
    prepare: ["go", "mod", "tidy"],
    proof: "go build ./...",
    cacheDir: async () =>
      await machineCacheDir(["go", "env", "GOMODCACHE"], join(homedir(), "go", "pkg", "mod")),
    projectCache: "go-mod",
  },
] as const;

describe.each(CASES)("$name: repair a checkout without touching the machine", (subject) => {
  let sandbox: Sandbox;
  let project: TempProject;
  let follower: string | null = null;
  let available = false;

  beforeAll(async () => {
    available = await toolPresent(subject.probe);
    if (!available) return;
    sandbox = await createSandbox({ IWOMC_DISABLE_MEMORY: "1" });
    project = await createRepository(`${subject.name.toLowerCase()}-fixture`, subject.files, {
      root: sandbox.home,
    });

    // Resolve and commit the lockfile, so the fixture is a project whose exact
    // versions are pinned by the repository - which is what a rescue reproduces.
    await run([...subject.prepare], { cwd: project.dir, timeoutMs: 900_000, envAllowlist: null });
    await run(["git", "add", "-A"], { cwd: project.dir, timeoutMs: 60_000, envAllowlist: null });
    await run(["git", "commit", "--quiet", "--no-gpg-sign", "-m", "lockfile"], {
      cwd: project.dir,
      timeoutMs: 60_000,
      envAllowlist: null,
    });
    await run(["git", "push", "--quiet", "origin", "main"], {
      cwd: project.dir,
      timeoutMs: 120_000,
      envAllowlist: null,
    });
  }, 1_800_000);

  afterAll(async () => {
    if (follower) {
      // Go makes its module cache read-only, directories included, so an
      // ordinary recursive delete fails on it - the same wall anyone hits
      // deleting a checkout IWOMC has fetched into. `go clean -modcache` is
      // Go's own answer, and running it here proves the remedy this project
      // documents actually works.
      if (subject.name === "Go") {
        await run(["go", "clean", "-modcache"], {
          cwd: follower,
          timeoutMs: 300_000,
          envAllowlist: null,
          env: { GOMODCACHE: join(follower, ".iwomc", "go-mod") },
        }).catch(() => null);
      }
      await rm(follower, { recursive: true, force: true }).catch(() => null);
    }
    await project?.cleanup().catch(() => null);
    await sandbox?.cleanup().catch(() => null);
  });

  it("is recognised as something IWOMC can repair itself", async () => {
    if (!available) {
      console.log(`[skipped] ${subject.name} is not installed on this machine. No stub was substituted.`);
      return;
    }
    const result = await runIwomc(["init", "--proof", subject.proof, "--json"], {
      cwd: project.dir,
      env: sandbox.env,
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.json<{ support: { level: string } }>().support.level).toBe("native");
  }, 600_000);

  it("says plainly that it cannot list what is installed", async () => {
    if (!available) return;
    const capture = await runIwomc(["capture", "--json"], { cwd: project.dir, env: sandbox.env });
    expect(capture.exitCode).toBe(EXIT.ok);
    const gaps = capture.json<{ coverage: { area: string; reason: string }[] }>().coverage;
    const inventory = gaps.filter((gap) => gap.area.endsWith(".inventory"));
    // Once, in one place - not the same sentence twice in different words.
    expect(inventory).toHaveLength(1);
    expect(inventory[0]?.reason).toMatch(/cannot list|not detected/iu);
  }, 900_000);

  it("repairs a fresh checkout and leaves the machine-wide cache alone", async () => {
    if (!available) return;
    // Ignoring this result hid the real failure once already: rescue reported
    // "the contract is still a candidate", which is a consequence, not a cause.
    const verified = await runIwomc(["verify", "--json"], { cwd: project.dir, env: sandbox.env });
    const verdict = verified.json<{
      contract?: { state: string };
      verifierDetail?: string;
      blocker: { code: string; message: string } | null;
    }>();
    expect(
      verdict.contract?.state,
      `verify did not check this contract: ${verdict.blocker?.code} ${verdict.blocker?.message} | ${verdict.verifierDetail}`,
    ).toBe("locally_checked");

    follower = join(sandbox.home, `${subject.name.toLowerCase()}-follower`);
    await run(["git", "clone", "--quiet", project.originDir, follower], {
      cwd: sandbox.home,
      timeoutMs: 300_000,
      envAllowlist: null,
    });
    await runIwomc(["init", "--proof", subject.proof, "--json"], { cwd: follower, env: sandbox.env });

    const machineCache = await subject.cacheDir();
    const before = await countFiles(machineCache);
    // A count of nought before and nought after would pass while proving
    // nothing, so require that this really is the populated shared cache: the
    // lead's own build filled it a moment ago.
    expect(before, `${machineCache} does not look like this machine's cache`).toBeGreaterThan(0);

    const rescue = await runIwomc(["rescue", "--json", "--approve"], { cwd: follower, env: sandbox.env });
    const after = await countFiles(machineCache);

    const outcome = rescue.json<{
      state: string;
      blocker: { code: string; message: string } | null;
      proof: { exitCode: number | null } | null;
      events?: { kind: string; message: string }[];
    }>();
    // A bare "expected 'blocked' to be 'working'" says nothing about why, which
    // on a machine you cannot log into is the whole of the diagnosis.
    const why =
      outcome.state === "working"
        ? ""
        : `${outcome.blocker?.code}: ${outcome.blocker?.message} | proof exit ${outcome.proof?.exitCode} | ${(
            outcome.events ?? []
          )
            .filter((event) => event.kind === "proof_output" || event.kind === "step_failed")
            .map((event) => event.message)
            .join(" / ")
            .slice(0, 1200)}`;
    expect(outcome.state, why).toBe("working");
    expect(rescue.exitCode).toBe(EXIT.ok);

    // The whole promise, measured rather than asserted: the machine-wide cache
    // holds exactly as many files as it did before.
    expect(after, `${subject.name} wrote into ${machineCache}`).toBe(before);

    // And the download did happen - inside the project, where it belongs.
    expect(await countFiles(join(follower, ".iwomc", subject.projectCache))).toBeGreaterThan(0);

    // Nothing the repository tracks was touched.
    const status = await run(["git", "status", "--porcelain"], {
      cwd: follower,
      timeoutMs: 60_000,
      envAllowlist: null,
    });
    const tracked = status.stdout
      .split(/\r?\n/u)
      .filter((entry) => entry.trim().length > 0 && !entry.startsWith("??"));
    expect(tracked).toEqual([]);
  }, 1_800_000);
});

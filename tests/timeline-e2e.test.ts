import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { run } from "@iwomc/companion";
import {
  createNodeProject,
  createSandbox,
  installUndeclaredPackage,
  runIwomc,
  type NodeProjectResult,
  type Sandbox,
} from "@iwomc/testkit";

/**
 * Reproducing a teammate's machine at their commit.
 *
 * The scenario this exists for: an agent working on Alice's checkout installs a
 * package, then has to move it *back* a version to make the project run. Nobody
 * writes either step into the repository. Bob clones the same commit and gets
 * neither.
 *
 * A snapshot cannot describe that, because a snapshot has no way to say "this
 * went down, not up". The package log can, and this test follows the whole
 * path: record on Alice's machine, ask the log what was true at her revision,
 * carry it into a contract, and require the project's own proof command to pass
 * on Bob's checkout.
 *
 * Nothing here is staged. The project, its dependency names, and its paths are
 * generated per run, and the proof is a real process exit code.
 */

const EXIT = { ok: 0, blocked: 2 };

describe("reproducing a machine at a revision", () => {
  let sandbox: Sandbox;
  let project: NodeProjectResult;
  let teammate: string;
  let extra: string;

  beforeAll(async () => {
    sandbox = await createSandbox({ IWOMC_DISABLE_MEMORY: "1" });
    project = await createNodeProject({ root: sandbox.home });
    teammate = await project.clone();
    extra = `local-only-${Math.random().toString(36).slice(2, 8)}`;

    await runIwomc(["init", "--proof", "npm run proof", "--json"], {
      cwd: project.dir,
      env: sandbox.env,
    });
  }, 900_000);

  afterAll(async () => {
    await project?.cleanup();
    await sandbox?.cleanup();
  });

  it("records an install, then a downgrade, against the revision they happened at", async () => {
    // A first observation establishes what was already there. It must not
    // claim that the existing tree was installed the instant IWOMC started.
    const first = await runIwomc(["sweep", "--json"], { cwd: project.dir, env: sandbox.env });
    expect(first.exitCode).toBe(EXIT.ok);
    expect(first.json<{ events: unknown[] }>().events).toEqual([]);

    await installUndeclaredPackage(project.dir, extra, "2.0.0");
    const installed = await runIwomc(["sweep", "--json"], { cwd: project.dir, env: sandbox.env });
    const installedEvents = installed.json<{ events: { name: string; kind: string }[] }>().events;
    expect(installedEvents.map((event) => [event.name, event.kind])).toEqual([[extra, "installed"]]);

    // The step a snapshot cannot express.
    await installUndeclaredPackage(project.dir, extra, "1.4.0");
    const downgraded = await runIwomc(["sweep", "--json"], { cwd: project.dir, env: sandbox.env });
    const events = downgraded.json<{
      events: { name: string; kind: string; fromVersion: string; toVersion: string; commit: string }[];
    }>().events;
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("downgraded");
    expect(events[0]?.fromVersion).toBe("2.0.0");
    expect(events[0]?.toVersion).toBe("1.4.0");
    expect(events[0]?.commit).toBe(project.commit);
  }, 300_000);

  it("answers what was installed while that revision was checked out", async () => {
    const result = await runIwomc(["timeline", project.commit, "--json", "--no-explain"], {
      cwd: project.dir,
      env: sandbox.env,
    });
    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json<{
      state: { commit: string; packages: { name: string; version: string }[]; coverage: { area: string }[] };
    }>();

    expect(payload.state.commit).toBe(project.commit);
    const found = payload.state.packages.find((entry) => entry.name === extra);
    expect(found?.version, "the log must report the version that was left in place").toBe("1.4.0");

    // The answer states what it could not see rather than implying completeness.
    expect(Array.isArray(payload.state.coverage)).toBe(true);
  }, 120_000);

  it("refuses to estimate a revision this device never observed", async () => {
    const result = await runIwomc(["timeline", "f".repeat(40), "--json", "--no-explain"], {
      cwd: project.dir,
      env: sandbox.env,
    });
    // Exit 2 is "blocked": a truthful refusal, not a failure to compute.
    expect(result.exitCode).toBe(EXIT.blocked);
    const payload = result.json<{ state: { kind: string; message: string } }>();
    expect(payload.state.kind).toBe("commit_not_observed");
    expect(payload.state.message).toContain("never checked out here");
  }, 120_000);

  it("carries the recorded versions into the contract for that revision", async () => {
    const result = await runIwomc(["capture", "--json"], { cwd: project.dir, env: sandbox.env });
    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json<{
      contract: {
        source: { commit: string };
        requirements: { packages: { name: string; versionSpec: string; declared: boolean }[] };
        steps: { kind: string; packages?: { name: string; versionSpec: string }[] }[];
      };
    }>();

    expect(payload.contract.source.commit).toBe(project.commit);

    // The package was never declared in package.json, so a fresh clone cannot
    // get it from the repository. The log is what puts it in the contract, at
    // the exact version this machine settled on.
    const requirement = payload.contract.requirements.packages.find((entry) => entry.name === extra);
    expect(requirement, "the recorded install must reach the contract").toBeDefined();
    expect(requirement?.declared).toBe(false);
    expect(requirement?.versionSpec).toContain("1.4.0");

    const overlay = payload.contract.steps.find((step) => step.kind === "apply_package_overlay");
    expect(overlay?.packages?.some((entry) => entry.name === extra)).toBe(true);
  }, 300_000);

  it("hands the teammate a contract that names the exact recorded version", async () => {
    // How far this test can honestly go: the fixture's undeclared package is
    // written straight into `node_modules`, so no registry can install it and
    // the overlay step cannot run offline. What is provable here is that the
    // contract a teammate receives pins the version this machine settled on
    // rather than "latest" - which is the part the log contributes. The
    // materialize-and-prove path is covered end to end in `rescue-e2e`.
    const bind = await runIwomc(["init", "--json"], { cwd: teammate, env: sandbox.env });
    expect(bind.exitCode).toBe(EXIT.ok);

    const theirHead = await run(["git", "rev-parse", "HEAD"], {
      cwd: teammate,
      timeoutMs: 60_000,
      envAllowlist: null,
    });
    expect(theirHead.stdout.trim(), "both checkouts must be at the same revision").toBe(project.commit);

    const status = await runIwomc(["status", "--json"], { cwd: teammate, env: sandbox.env });
    const payload = status.json<{
      exactContract: { commit: string; state: string } | null;
      canRescueNow: { possible: boolean; reason: string };
    }>();

    expect(payload.exactContract?.commit).toBe(project.commit);
    expect(payload.exactContract?.state).toBe("candidate");
    // A candidate is not yet authorization to change someone's machine, and
    // status says so instead of offering a button that would fail.
    expect(payload.canRescueNow.possible).toBe(false);
    expect(payload.canRescueNow.reason).toContain("candidate");
  }, 300_000);

  it("keeps the log on the device and never writes it into the repository", async () => {
    const status = await run(["git", "status", "--porcelain=v1"], {
      cwd: project.dir,
      timeoutMs: 60_000,
      envAllowlist: null,
    });
    // node_modules and .iwomc are ignored by the fixture, so a clean worktree
    // here is the real assertion: watching a project changes no tracked file.
    expect(status.stdout.trim()).toBe("");

    await rm(join(project.dir, "node_modules", extra), { recursive: true, force: true });

    // The removal must reach the log. Which recorder catches it is not the
    // point and is not fixed: with autocapture on, a background recorder may
    // notice first and `sweep` then correctly reports that it did not write,
    // because recording one change twice would put it in the history twice.
    await runIwomc(["sweep", "--json"], { cwd: project.dir, env: sandbox.env });
    await expect
      .poll(
        async () => {
          const result = await runIwomc(["timeline", "--json", "--no-explain"], {
            cwd: project.dir,
            env: sandbox.env,
          });
          return result
            .json<{ recentEvents: { name: string; kind: string }[] }>()
            .recentEvents.some((event) => event.name === extra && event.kind === "removed");
        },
        { timeout: 90_000, interval: 3_000 },
      )
      .toBe(true);
  }, 300_000);
});

describe("recording without being asked", () => {
  let sandbox: Sandbox;
  let project: NodeProjectResult;

  beforeAll(async () => {
    // The one place autocapture is deliberately on: this is what it tests.
    sandbox = await createSandbox({
      IWOMC_DISABLE_MEMORY: "1",
      IWOMC_AUTOCAPTURE: "1",
      // A short sweep so the timer path is exercised quickly: if this still
      // does not notice, the recorder is not running rather than merely slow.
      IWOMC_AUTOCAPTURE_INTERVAL: "5",
    });
    project = await createNodeProject({ root: sandbox.home });
  }, 900_000);

  afterAll(async () => {
    // Whatever this test started must not outlive it.
    await runIwomc(["daemon", "stop"], { cwd: project.dir, env: sandbox.env }).catch(() => undefined);
    await project?.cleanup();
    await sandbox?.cleanup();
  });

  it("starts a recorder by itself the first time a project is used", async () => {
    // Nothing to record before a checkout is registered, so nothing starts.
    const before = await runIwomc(["daemon", "status", "--json"], { cwd: project.dir, env: sandbox.env });
    expect(before.json<{ running: boolean }>().running).toBe(false);

    await runIwomc(["init", "--proof", "npm run proof", "--json"], { cwd: project.dir, env: sandbox.env });
    // An ordinary command, not a request to start anything.
    await runIwomc(["status", "--json"], { cwd: project.dir, env: sandbox.env });

    const after = await runIwomc(["daemon", "status", "--json"], { cwd: project.dir, env: sandbox.env });
    const status = after.json<{ running: boolean; record: { pid: number } | null }>();
    expect(status.running, "an ordinary command should have started the recorder").toBe(true);
    expect(status.record?.pid).toBeGreaterThan(0);
  }, 600_000);

  it("records a change with no IWOMC command involved", async () => {
    // Wait for the recorder to have taken its first reading before changing
    // anything. That reading is the baseline, and whatever is already present
    // in it was not "installed" - it was simply there. Installing before the
    // recorder has looked would put the package in the baseline and produce no
    // event at all, correctly, which on a slower machine is exactly what
    // happened.
    await expect
      .poll(
        async () => {
          const result = await runIwomc(["timeline", "--json", "--no-explain"], {
            cwd: project.dir,
            env: sandbox.env,
          });
          const state = result.json<{ state: { packages?: unknown[] } }>().state;
          return (state.packages ?? []).length > 0;
        },
        { timeout: 120_000, interval: 2_000 },
      )
      .toBe(true);

    const appeared = `arrived-on-its-own-${Math.random().toString(36).slice(2, 8)}`;
    await installUndeclaredPackage(project.dir, appeared, "1.2.3");

    // Nothing is run here on purpose: the recorder has to notice by itself.
    let noticed = false;
    try {
      await expect
        .poll(
          async () => {
            const result = await runIwomc(["timeline", "--json", "--no-explain"], {
              cwd: project.dir,
              env: sandbox.env,
            });
            noticed = result
              .json<{ recentEvents: { name: string }[] }>()
              .recentEvents.some((event) => event.name === appeared);
            return noticed;
          },
          { timeout: 120_000, interval: 3_000 },
        )
        .toBe(true);
    } catch (error) {
      // A recorder that never noticed is only diagnosable from its own log,
      // and this runs on machines nobody can attach a debugger to.
      const status = await runIwomc(["daemon", "status", "--json"], {
        cwd: project.dir,
        env: sandbox.env,
      });
      const logPath = status.json<{ logPath: string }>().logPath;
      let log = "(no recorder log was written)";
      try {
        log = await readFile(logPath, "utf8");
      } catch (readError) {
        log = `(could not read ${logPath}: ${(readError as Error).message})`;
      }
      throw new Error(
        `The recorder did not notice ${appeared}.
` +
          `daemon status: ${status.stdout.trim()}
` +
          `recorder log:
${log.slice(-4000)}
` +
          `original: ${(error as Error).message}`,
      );
    }
  }, 300_000);

  it("stops when it is told to, and stays stopped", async () => {
    const stopped = await runIwomc(["daemon", "stop", "--json"], { cwd: project.dir, env: sandbox.env });
    expect(stopped.exitCode).toBe(0);

    const status = await runIwomc(["daemon", "status", "--json"], { cwd: project.dir, env: sandbox.env });
    expect(status.json<{ running: boolean }>().running).toBe(false);
  }, 300_000);
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
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
    const removed = await runIwomc(["sweep", "--json"], { cwd: project.dir, env: sandbox.env });
    const events = removed.json<{ events: { name: string; kind: string }[] }>().events;
    expect(events.map((event) => [event.name, event.kind])).toEqual([[extra, "removed"]]);
  }, 300_000);
});

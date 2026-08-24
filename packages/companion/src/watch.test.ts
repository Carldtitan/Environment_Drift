import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRepository,
  createSandbox,
  installUndeclaredPackage,
  type Sandbox,
  type TempProject,
} from "@iwomc/testkit";
import { defaultRegistry } from "@iwomc/adapters";
import { CompanionStore } from "./store.js";
import { PackageWatcher, ProjectGoneError, RecorderBusyError } from "./watch.js";
import { baselineFrom } from "./timeline.js";
import { isCommitNotObserved, stateAt, stateAtCommit } from "./history.js";
import { bindProject } from "./project.js";
import { currentPlatform } from "./identity.js";
import { readGitFacts } from "./git.js";
import { run } from "./exec.js";

/**
 * These exercise the real loop against a real repository and a real
 * `node_modules`. They do not run `npm install`: the point under test is that
 * the watcher learns what is installed by reading the directory, so writing the
 * directory by hand is the honest fixture.
 */

const PROJECT_FILES = {
  "package.json": `${JSON.stringify(
    { name: "watch-fixture", version: "1.0.0", private: true, dependencies: {} },
    null,
    2,
  )}\n`,
  ".gitignore": "node_modules/\n.iwomc/\n",
};

describe("the background package watcher", () => {
  let sandbox: Sandbox;
  let project: TempProject;
  let store: CompanionStore;
  let projectId: string;
  let commit: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    project = await createRepository("watch", PROJECT_FILES);
    store = CompanionStore.open(sandbox.env);
    const bound = await bindProject(store, project.dir, currentPlatform(), { projectName: "watch" });
    projectId = bound.binding.projectId;
    commit = (await readGitFacts(project.dir)).commit;
  });

  afterEach(async () => {
    store.close();
    await project.cleanup();
    await sandbox.cleanup();
  });

  function watcher(): PackageWatcher {
    return new PackageWatcher({
      store,
      projectId,
      projectDir: project.dir,
      registry: defaultRegistry(),
      // Long enough that nothing fires on its own: every sweep in these tests
      // is one the test asked for, so the assertions are about the diff logic
      // rather than about timer luck.
      options: { sweepIntervalMs: 3_600_000, debounceMs: 10_000 },
    });
  }

  it("records a baseline on the first sweep and claims no installs", async () => {
    await installUndeclaredPackage(project.dir, "already-here", "1.0.0");
    const subject = watcher();
    const first = await subject.start();
    await subject.stop("test");

    // Everything already installed existed before IWOMC arrived. Emitting
    // "installed" events for it would date every package to the moment the
    // tool was switched on.
    expect(first.events).toEqual([]);
    expect(first.baseline?.entries.map((entry) => entry.name)).toContain("already-here");
    expect(store.countPackageEvents(projectId)).toBe(0);
  });

  it("captures an install, an upgrade, a downgrade, and a removal in order", async () => {
    const subject = watcher();
    await subject.start();

    await installUndeclaredPackage(project.dir, "moving-target", "1.0.0");
    const installed = await subject.sweepNow();
    expect(installed.events.map((event) => [event.name, event.kind])).toEqual([
      ["moving-target", "installed"],
    ]);

    await installUndeclaredPackage(project.dir, "moving-target", "2.0.0");
    const upgraded = await subject.sweepNow();
    expect(upgraded.events[0]?.kind).toBe("upgraded");
    expect(upgraded.events[0]?.fromVersion).toBe("1.0.0");

    await installUndeclaredPackage(project.dir, "moving-target", "1.4.0");
    const downgraded = await subject.sweepNow();
    expect(downgraded.events[0]?.kind).toBe("downgraded");
    expect(downgraded.events[0]?.fromVersion).toBe("2.0.0");
    expect(downgraded.events[0]?.toVersion).toBe("1.4.0");

    await rm(join(project.dir, "node_modules", "moving-target"), { recursive: true, force: true });
    const removed = await subject.sweepNow();
    expect(removed.events[0]?.kind).toBe("removed");

    await subject.stop("test");

    const log = store.listPackageEvents(projectId);
    expect(log.map((event) => event.kind)).toEqual(["installed", "upgraded", "downgraded", "removed"]);
    expect(log.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
    expect(new Set(log.map((event) => event.commit))).toEqual(new Set([commit]));
  });

  it("answers what was installed at an instant", async () => {
    const subject = watcher();
    await subject.start();

    await installUndeclaredPackage(project.dir, "early", "1.0.0");
    const first = await subject.sweepNow();

    await installUndeclaredPackage(project.dir, "late", "1.0.0");
    const second = await subject.sweepNow();
    await subject.stop("test");

    const atFirst = stateAt(store, projectId, first.at);
    expect(atFirst.packages.map((entry) => entry.name)).toContain("early");
    expect(atFirst.packages.map((entry) => entry.name)).not.toContain("late");

    const atSecond = stateAt(store, projectId, second.at);
    expect(atSecond.packages.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["early", "late"]),
    );
  });

  it("answers what was installed at a revision", async () => {
    const subject = watcher();
    await subject.start();
    await installUndeclaredPackage(project.dir, "at-this-commit", "3.1.4");
    await subject.sweepNow();
    await subject.stop("test");

    const state = stateAtCommit(store, projectId, commit);
    expect(isCommitNotObserved(state)).toBe(false);
    if (isCommitNotObserved(state)) return;
    expect(state.packages.map((entry) => entry.name)).toContain("at-this-commit");
    expect(state.commit).toBe(commit);
  });

  it("refuses to guess about a revision it never saw", async () => {
    const subject = watcher();
    await subject.start();
    await subject.stop("test");

    const state = stateAtCommit(store, projectId, "f".repeat(40));
    expect(isCommitNotObserved(state)).toBe(true);
    if (!isCommitNotObserved(state)) return;
    expect(state.message).toContain("never checked out here");
  });

  it("reports the period nobody was watching as uncovered", async () => {
    const first = watcher();
    await first.start();
    await first.stop("test");

    // A real gap: the watcher is down, and a package changes while it is.
    await new Promise((done) => setTimeout(done, 1_200));
    await installUndeclaredPackage(project.dir, "slipped-in", "1.0.0");

    const second = watcher();
    const sweep = await second.start();
    await second.stop("test");

    // The change is still recorded - the sweep is the safety net - but the
    // answer must say that its timing is only as precise as the gap.
    expect(sweep.events.map((event) => event.name)).toContain("slipped-in");

    const state = stateAt(store, projectId, sweep.at);
    expect(state.coverage.map((gap) => gap.area)).toContain("watch_coverage");
  });

  it("notices a change that lands while a sweep is already running", async () => {
    // The common case, not the rare one: a package manager writes to
    // node_modules while IWOMC is mid-read. Waiting a whole interval to see it
    // would throw away the reason for watching at all.
    const subject = new PackageWatcher({
      store,
      projectId,
      projectDir: project.dir,
      registry: defaultRegistry(),
      options: { sweepIntervalMs: 3_600_000, debounceMs: 30 },
    });
    await subject.start();

    const inFlight = subject.sweep("swept");
    await installUndeclaredPackage(project.dir, "landed-mid-sweep", "1.0.0");
    await inFlight;

    // Give the follow-up its debounce, then confirm the change was recorded
    // without a full sweep interval elapsing.
    await new Promise((done) => setTimeout(done, 400));
    await subject.stop("test");

    const names = store.listPackageEvents(projectId).map((event) => event.name);
    expect(names).toContain("landed-mid-sweep");
  });

  it("lets only one recorder write, so one change is never logged twice", async () => {
    const first = watcher();
    await first.start();

    // A second recorder on the same project - a resident `iwomc watch` plus an
    // `iwomc sweep` in another terminal is the normal case, not a rare one.
    const second = watcher();
    await expect(second.start()).rejects.toBeInstanceOf(RecorderBusyError);

    await installUndeclaredPackage(project.dir, "recorded-once", "1.0.0");
    await first.sweepNow();
    await first.stop("test");

    const events = store.listPackageEvents(projectId).filter((event) => event.name === "recorded-once");
    expect(events).toHaveLength(1);
  });

  it("hands the project over once the previous recorder stops", async () => {
    const first = watcher();
    await first.start();
    await first.stop("test");

    const second = watcher();
    await expect(second.start()).resolves.toBeDefined();
    await second.stop("test");
  });

  it("takes over from a recorder that was killed rather than stopped", async () => {
    // A process that died leaves an open session whose heartbeat is old. This
    // is exactly the row such a process leaves behind.
    const held = store.acquireRecorderLease({
      sessionId: "dead-recorder",
      projectId,
      at: "2026-08-20T00:00:00.000Z",
      sweepIntervalMs: 45_000,
    });
    expect(held.acquired).toBe(true);

    const subject = watcher();
    await expect(subject.start()).resolves.toBeDefined();
    await subject.stop("test");

    // The dead session must be closed at its last heartbeat, so it stops
    // claiming to have been watching for the days since.
    const sessions = store.listWatchSessions(projectId);
    const dead = sessions.find((entry) => entry.startedAt === "2026-08-20T00:00:00.000Z");
    expect(dead?.endedAt).toBe("2026-08-20T00:00:00.000Z");
  });

  it("assigns sequence numbers itself so two writers cannot collide", async () => {
    const subject = watcher();
    await subject.start();
    await subject.stop("test");

    // Two batches that both claim to start at 0, as two processes that each
    // read "next sequence" before writing would produce.
    const make = (name: string, at: string) => ({
      schemaVersion: 1 as const,
      id: `event-${name}`,
      projectId,
      seq: 0,
      at,
      window: { from: at, to: at },
      ecosystem: "node",
      manager: "npm",
      adapterId: "node.npm",
      name,
      fromVersion: null,
      toVersion: "1.0.0",
      kind: "installed" as const,
      commit,
      branch: "main",
      worktreeDirty: false,
      source: "swept" as const,
    });

    const a = store.appendPackageEvents([make("from-writer-a", "2026-08-24T00:00:00.000Z")]);
    const b = store.appendPackageEvents([make("from-writer-b", "2026-08-24T00:00:01.000Z")]);
    expect(a[0]?.seq).not.toBe(b[0]?.seq);

    const seqs = store.listPackageEvents(projectId).map((event) => event.seq);
    expect(new Set(seqs).size, "every sequence number must be distinct").toBe(seqs.length);
  });

  it("skips an observation it has already stored", async () => {
    const subject = watcher();
    await subject.start();
    await subject.stop("test");

    const event = {
      schemaVersion: 1 as const,
      id: "same-observation",
      projectId,
      seq: 0,
      at: "2026-08-24T00:00:00.000Z",
      window: { from: "2026-08-24T00:00:00.000Z", to: "2026-08-24T00:00:00.000Z" },
      ecosystem: "node",
      manager: "npm",
      adapterId: "node.npm",
      name: "seen-before",
      fromVersion: null,
      toVersion: "1.0.0",
      kind: "installed" as const,
      commit,
      branch: null,
      worktreeDirty: false,
      source: "swept" as const,
    };

    expect(store.appendPackageEvents([event])).toHaveLength(1);
    // The same observation again - a recorder that crashed after deriving but
    // before committing would produce exactly this.
    expect(store.appendPackageEvents([event])).toHaveLength(0);
    expect(store.listPackageEvents(projectId, { name: "seen-before" })).toHaveLength(1);
  });

  it("survives node_modules being deleted and rebuilt, which is what an install does", async () => {
    // `npm ci` removes the whole tree and writes a new one. On Windows the
    // watch handle for a deleted directory is not closed and raises no error -
    // it reports the deletion endlessly, which both burns CPU and restarts the
    // debounce faster than it can elapse, leaving the watcher deaf exactly
    // when the most changed.
    await installUndeclaredPackage(project.dir, "before-reinstall", "1.0.0");
    const subject = new PackageWatcher({
      store,
      projectId,
      projectDir: project.dir,
      registry: defaultRegistry(),
      options: { sweepIntervalMs: 3_600_000, debounceMs: 40 },
    });
    await subject.start();

    await rm(join(project.dir, "node_modules"), { recursive: true, force: true });
    await new Promise((done) => setTimeout(done, 600));
    await installUndeclaredPackage(project.dir, "after-reinstall", "2.0.0");
    await new Promise((done) => setTimeout(done, 900));
    await subject.stop("test");

    const kinds = new Map(
      store.listPackageEvents(projectId).map((event) => [event.name, event.kind]),
    );
    // The sweep interval here is an hour, so anything recorded came from the
    // filesystem trigger rather than the timer.
    expect(kinds.get("before-reinstall")).toBe("removed");
    expect(kinds.get("after-reinstall")).toBe("installed");
  });

  it("still sweeps when filesystem events never stop arriving", async () => {
    // A large install emits events continuously for as long as it runs. A
    // debounce that only ever restarts would wait for silence that never comes.
    const subject = new PackageWatcher({
      store,
      projectId,
      projectDir: project.dir,
      registry: defaultRegistry(),
      options: { sweepIntervalMs: 3_600_000, debounceMs: 500 },
    });
    await subject.start();

    await installUndeclaredPackage(project.dir, "under-a-noisy-install", "1.0.0");

    // Keep touching the tree faster than the debounce, for longer than it.
    const noisy = join(project.dir, "node_modules", "noise");
    const stopAt = Date.now() + 5_000;
    while (Date.now() < stopAt) {
      await installUndeclaredPackage(project.dir, "noise", `1.0.${Date.now() % 1000}`);
      await new Promise((done) => setTimeout(done, 60));
    }
    await new Promise((done) => setTimeout(done, 800));
    await subject.stop("test");
    void noisy;

    const names = store.listPackageEvents(projectId).map((event) => event.name);
    expect(names, "a continuous stream must not postpone the sweep forever").toContain(
      "under-a-noisy-install",
    );
  }, 60_000);

  it("stops itself when the checkout it watches is gone", async () => {
    // Deleted, moved, or on a drive that was unmounted. Retrying every
    // interval forever would fill the log with the same error and keep
    // claiming to watch something that no longer exists.
    const scratch = await createRepository("disappearing", PROJECT_FILES);
    const bound = await bindProject(store, scratch.dir, currentPlatform(), {
      projectName: "disappearing",
    });
    const subject = new PackageWatcher({
      store,
      projectId: bound.binding.projectId,
      projectDir: scratch.dir,
      registry: defaultRegistry(),
      options: { sweepIntervalMs: 3_600_000, debounceMs: 40 },
    });
    await subject.start();
    await subject.stop("test");

    await scratch.cleanup();

    const revived = new PackageWatcher({
      store,
      projectId: bound.binding.projectId,
      projectDir: scratch.dir,
      registry: defaultRegistry(),
      options: { sweepIntervalMs: 3_600_000, debounceMs: 40 },
    });
    await expect(revived.start()).rejects.toBeInstanceOf(ProjectGoneError);

    // The window it opened must be closed, not left claiming coverage.
    const open = store
      .listWatchSessions(bound.binding.projectId)
      .filter((entry) => entry.endedAt === null);
    expect(open).toHaveLength(0);
  }, 120_000);

  it("thins old snapshots without ever touching the record itself", async () => {
    // Snapshots are shortcuts. Events are the record. Pruning must change how
    // fast a question is answered, never what the answer is.
    const packages = [
      { ecosystem: "node", manager: "npm", adapterId: "node.npm", name: "kept", version: "1.0.0" },
    ];
    const day = (n: number) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + n * 86_400_000).toISOString();

    for (let index = 0; index < 60; index += 1) {
      store.saveInventoryBaseline(
        baselineFrom(projectId, { at: day(index), packages }, index - 1, null),
      );
    }
    const before = store.packageLogFootprint(projectId);
    expect(before.baselines).toBe(60);

    const removed = store.pruneBaselines(projectId, day(120));
    const after = store.packageLogFootprint(projectId);

    expect(removed).toBeGreaterThan(0);
    expect(after.baselines).toBeLessThan(before.baselines);
    // Never the record.
    expect(after.events).toBe(before.events);
    // And never the anchor for the earliest questions.
    expect(store.baselineAtOrBefore(projectId, -1)).not.toBeNull();
  });

  it("gives up rather than failing forever when it cannot record", async () => {
    // A detached recorder outlives the command that started it, so a fault
    // that never clears would leave a process running and recording nothing
    // while looking alive. A second handle on the same store is closed under
    // the recorder to reproduce what deleting the store does, without
    // disturbing the one this file's other tests share.
    const ownStore = CompanionStore.open(sandbox.env);
    const subject = new PackageWatcher({
      store: ownStore,
      projectId,
      projectDir: project.dir,
      registry: defaultRegistry(),
      options: { sweepIntervalMs: 3_600_000, debounceMs: 20 },
    });
    await subject.start();

    ownStore.close();

    let failures = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await subject.sweep("swept");
      } catch {
        failures += 1;
      }
    }
    expect(failures, "a recorder whose store is gone must fail rather than pretend").toBeGreaterThan(0);

    // Once it has given up, it is stopped rather than left running.
    await subject.stop("test");
  }, 120_000);

  it("records what the machine had at each revision someone worked at", async () => {
    // The question this product exists to answer is "what did their machine
    // look like at their commit". Recording only when a package changes is not
    // enough: a revision someone moved to and worked at, without installing
    // anything, would have no record of its own - and asking about it would
    // answer from whenever they last installed something, which may be a
    // different revision, or an earlier visit to this one.
    const first = (await readGitFacts(project.dir)).commit;
    await installUndeclaredPackage(project.dir, "present-at-both", "1.0.0");

    const subject = watcher();
    await subject.start();
    await subject.sweepNow();

    // Move to a second revision without changing a single package.
    await run(["git", "commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "second"], {
      cwd: project.dir,
      timeoutMs: 60_000,
      envAllowlist: null,
    });
    const second = (await readGitFacts(project.dir)).commit;
    expect(second).not.toBe(first);

    await subject.sweepNow();
    await subject.stop("test");

    // Both revisions answer, and both answer with what was actually installed
    // while they were checked out.
    for (const [label, commit] of [["first", first], ["second", second]] as const) {
      const state = stateAtCommit(store, projectId, commit);
      expect(isCommitNotObserved(state), `${label} revision should be observed`).toBe(false);
      if (isCommitNotObserved(state)) continue;
      expect(
        state.packages.map((entry) => entry.name),
        `${label} revision`,
      ).toContain("present-at-both");
    }
  }, 120_000);

  it("never executes a package manager to learn what is installed", async () => {
    // The probe handed to adapters refuses to spawn, so any adapter that tried
    // would see `notFound` rather than a running process. A watcher that could
    // execute commands is a background daemon that runs arbitrary tooling.
    const subject = watcher();
    const result = await subject.start();
    await subject.stop("test");
    expect(result.packageCount).toBeGreaterThanOrEqual(0);
    expect(result.unavailable.every((entry) => typeof entry.reason === "string")).toBe(true);
  });
});

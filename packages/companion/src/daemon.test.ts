import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearDaemonRecord, daemonRecordPath, daemonStatus, startDaemon, stopDaemon, writeDaemonRecord } from "./daemon.js";

/**
 * The recorder has to outlive the command that started it, and a record of it
 * has to survive a machine being switched off mid-recording. Both of those go
 * wrong quietly, so both are checked against real processes.
 */

describe("the background recorder", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "daemon-"));
    env = { ...process.env, IWOMC_HOME: home };
  });

  afterEach(async () => {
    stopDaemon(env);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it("reports nothing running before anything starts", () => {
    const status = daemonStatus(env);
    expect(status.running).toBe(false);
    expect(status.record).toBeNull();
  });

  it("does not believe a record left by a process that is gone", () => {
    // A machine switched off mid-recording leaves exactly this behind. Trusting
    // it would mean never starting a recorder again on that machine.
    writeDaemonRecord({ pid: 0x7ffffffe, startedAt: "2026-08-01T00:00:00.000Z", entry: "/x" }, env);
    const status = daemonStatus(env);
    expect(status.running).toBe(false);
    expect(status.record?.pid).toBe(0x7ffffffe);
    expect(status.detail).toContain("no longer running");
  });

  it("survives a record that is not readable", async () => {
    await writeFile(daemonRecordPath(env), "{ this is not json", "utf8");
    expect(daemonStatus(env).running).toBe(false);
  });

  it("starts a real process that outlives this call, and stops it again", async () => {
    // A script that simply waits. The point under test is `detached` plus
    // `unref`: without both, the child dies with the command that spawned it.
    const script = join(home, "long-running.mjs");
    await writeFile(script, "setInterval(() => {}, 1000);\n", "utf8");

    const started = startDaemon({ entry: script, env });
    expect(started.started, started.detail).toBe(true);
    expect(started.pid).toBeGreaterThan(0);

    const status = daemonStatus(env);
    expect(status.running).toBe(true);
    expect(status.record?.pid).toBe(started.pid);

    // A second start must not spawn a rival recorder.
    const again = startDaemon({ entry: script, env });
    expect(again.started).toBe(false);
    expect(again.alreadyRunning).toBe(true);
    expect(again.pid).toBe(started.pid);

    const stopped = stopDaemon(env);
    expect(stopped.stopped).toBe(true);
    expect(daemonStatus(env).running).toBe(false);
    // The record must go with it, or the next command reads a dead process.
    expect(existsSync(daemonRecordPath(env))).toBe(false);
  }, 30_000);

  it("clears a record for a recorder that was never running", () => {
    writeDaemonRecord({ pid: 0x7ffffffd, startedAt: "2026-08-01T00:00:00.000Z", entry: "/x" }, env);
    const stopped = stopDaemon(env);
    expect(stopped.stopped).toBe(false);
    expect(existsSync(daemonRecordPath(env))).toBe(false);
  });

  it("puts its log somewhere a person can read it", async () => {
    await mkdir(home, { recursive: true });
    clearDaemonRecord(env);
    expect(daemonStatus(env).logPath).toContain("recorder.log");
  });
});

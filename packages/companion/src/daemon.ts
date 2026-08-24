/**
 * The recorder that runs without being asked.
 *
 * A package log only helps if it was already running when the interesting
 * thing happened. Asking people to remember `iwomc watch` guarantees the log
 * is missing exactly when it matters - nobody starts a recorder *before* the
 * install that breaks their teammate, because nobody knows which install that
 * is until later.
 *
 * So IWOMC starts one itself. The first time it does, it says so; it can be
 * switched off with one command; and `iwomc doctor` always shows whether it is
 * running. A background process that appeared on someone's machine without
 * telling them would be the kind of thing this product exists not to do.
 *
 * One daemon per IWOMC home, watching every registered checkout. The recorder
 * lease in the store still applies underneath, so a `iwomc watch` someone runs
 * by hand and this daemon can never both record the same change.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { iwomcHome, logsDir } from "./paths.js";

export interface DaemonRecord {
  readonly pid: number;
  readonly startedAt: string;
  /** Absolute path of the entry point, so a stale record is recognisable. */
  readonly entry: string;
}

export interface DaemonStatus {
  readonly running: boolean;
  readonly record: DaemonRecord | null;
  /** Why it is not running, when it is not. */
  readonly detail: string;
  readonly logPath: string;
}

export function daemonRecordPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(iwomcHome(env), "recorder.json");
}

export function daemonLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(logsDir(env), "recorder.log");
}

function readRecord(env: NodeJS.ProcessEnv): DaemonRecord | null {
  const path = daemonRecordPath(env);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt, entry: parsed.entry ?? "" };
  } catch {
    return null;
  }
}

/**
 * Whether a process id belongs to something still alive.
 *
 * Signal 0 checks existence and permission without delivering anything.
 * `EPERM` means it exists but belongs to another user, which still counts.
 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function daemonStatus(env: NodeJS.ProcessEnv = process.env): DaemonStatus {
  const record = readRecord(env);
  const logPath = daemonLogPath(env);
  if (!record) {
    return { running: false, record: null, detail: "No background recorder is registered.", logPath };
  }
  if (!processAlive(record.pid)) {
    return {
      running: false,
      record,
      // A machine that was switched off mid-record leaves this behind. It is
      // information, not an error.
      detail: `The recorder started at ${record.startedAt} is no longer running.`,
      logPath,
    };
  }
  return {
    running: true,
    record,
    detail: `Recording since ${record.startedAt} (process ${record.pid}).`,
    logPath,
  };
}

export function clearDaemonRecord(env: NodeJS.ProcessEnv = process.env): void {
  try {
    rmSync(daemonRecordPath(env), { force: true });
  } catch {
    // Nothing registered, which is the state we wanted anyway.
  }
}

export function writeDaemonRecord(record: DaemonRecord, env: NodeJS.ProcessEnv = process.env): void {
  const path = daemonRecordPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export interface StartDaemonResult {
  readonly started: boolean;
  readonly alreadyRunning: boolean;
  readonly pid: number | null;
  readonly detail: string;
}

/**
 * Start a detached recorder, or report that one is already going.
 *
 * `detached` plus `unref` is what lets the process outlive the command that
 * spawned it: without both, the recorder would die the moment `iwomc status`
 * returned, which is the whole thing this is for. Output goes to a file
 * because a detached process has no terminal to write to.
 */
export function startDaemon(
  input: { entry: string; env?: NodeJS.ProcessEnv; now?: () => string },
): StartDaemonResult {
  const env = input.env ?? process.env;
  const existing = daemonStatus(env);
  if (existing.running) {
    return {
      started: false,
      alreadyRunning: true,
      pid: existing.record?.pid ?? null,
      detail: existing.detail,
    };
  }
  clearDaemonRecord(env);

  const logPath = daemonLogPath(env);
  mkdirSync(dirname(logPath), { recursive: true });

  let child;
  try {
    child = spawn(process.execPath, [input.entry, "watch", "--all", "--daemon"], {
      detached: true,
      // The recorder must not inherit this command's terminal, or closing the
      // terminal takes it with it.
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...env, IWOMC_RECORDER_LOG: logPath } as NodeJS.ProcessEnv,
    });
  } catch (error) {
    return {
      started: false,
      alreadyRunning: false,
      pid: null,
      detail: `The background recorder could not be started: ${(error as Error).message}`,
    };
  }

  if (typeof child.pid !== "number") {
    return {
      started: false,
      alreadyRunning: false,
      pid: null,
      detail: "The background recorder could not be started: the process reported no id.",
    };
  }

  child.unref();
  const now = input.now ?? (() => new Date().toISOString());
  writeDaemonRecord({ pid: child.pid, startedAt: now(), entry: input.entry }, env);
  return {
    started: true,
    alreadyRunning: false,
    pid: child.pid,
    detail: `Recording started in the background (process ${child.pid}).`,
  };
}

export interface StopDaemonResult {
  readonly stopped: boolean;
  readonly detail: string;
}

/**
 * Ask the recorder to stop, and confirm it did.
 *
 * A polite signal first, so it closes its observation window honestly rather
 * than leaving one open that later folds would read as "might still have been
 * watching". Only if it ignores that is it ended outright.
 */
export function stopDaemon(env: NodeJS.ProcessEnv = process.env): StopDaemonResult {
  const status = daemonStatus(env);
  if (!status.running || !status.record) {
    clearDaemonRecord(env);
    return { stopped: false, detail: "No background recorder was running." };
  }

  const pid = status.record.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    clearDaemonRecord(env);
    return { stopped: false, detail: `The recorder (process ${pid}) had already ended.` };
  }

  // Give it a moment to close its window, then insist.
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline && processAlive(pid)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (processAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It ended between the check and the signal.
    }
  }
  clearDaemonRecord(env);
  return { stopped: true, detail: `The background recorder (process ${pid}) has stopped.` };
}

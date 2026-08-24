/**
 * The background capture loop.
 *
 * Design in one line: **watch as the trigger, sweep as the truth.**
 *
 * A filesystem watch is fast but not trustworthy. It misses events under load,
 * behaves differently on every platform, and reports a directory changed
 * without saying how. A periodic full read of the installed set is trustworthy
 * but slow to notice anything. Using both gives the useful properties of each:
 * the watch collapses the observation window from a whole sweep interval down
 * to a debounce, and the sweep guarantees that nothing is silently missed even
 * if every watch handle fails.
 *
 * Two constraints shape everything here.
 *
 * The loop never executes a command to learn what is installed. It reads
 * `node_modules` and the project-local virtual environment directly. The probe
 * runner handed to adapters refuses to spawn anything, so a future adapter
 * cannot quietly turn a background daemon into a command runner.
 *
 * The loop only ever looks inside bound project directories. It does not read
 * the home directory, the global package cache, the process table, or any
 * other project. "A lot of information about a developer's machine" is exactly
 * how a tool like this loses the right to run in the background, and IWOMC
 * cannot claim exhaustive host capture without lying about its coverage.
 */

import { watch as fsWatch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { randomId } from "@iwomc/contracts";
import type { InventoryBaselineV1, ObservedCause, PackageEventV1 } from "@iwomc/contracts";
import type { AdapterContext, AdapterRegistry, ProbeResult } from "@iwomc/adapters";
import { readHeadState, readWorktreeDirty } from "./git.js";
import { currentPlatform } from "./identity.js";
import { FileSystemProjectFiles } from "./project.js";
import type { CompanionStore } from "./store.js";
import {
  baselineFrom,
  deriveEvents,
  fold,
  type InventoryReading,
  type ObservedPackage,
} from "./timeline.js";

/** Directories a change to which is worth an immediate sweep. */
const WATCH_TARGETS = ["node_modules", ".venv", "venv", ".", "node_modules/.bin"] as const;

const DEFAULTS = {
  sweepIntervalMs: 45_000,
  debounceMs: 900,
  baselineEveryEvents: 250,
  baselineEveryMs: 6 * 60 * 60 * 1000,
} as const;

/**
 * How long a stream of filesystem events may postpone a sweep.
 *
 * A debounce that only ever restarts can be starved forever by a continuous
 * stream, and a large install is exactly that. Past this point the sweep runs
 * whether or not the noise has stopped.
 */
const MAX_DEBOUNCE_MS = 4_000;

/**
 * Events one handle may report before it is treated as broken.
 *
 * Deleting a watched directory on Windows does not close its handle or raise
 * an error - it makes the handle report the deletion endlessly, thousands of
 * times a second, naming its own path instead of a child. That storm burns CPU
 * and, worse, restarts the debounce faster than it can ever elapse, so the
 * watcher goes deaf at exactly the moment something big changed. `npm ci`
 * deletes node_modules, so this is a routine event, not a rare one.
 */
const HANDLE_EVENT_BUDGET = 64;
const HANDLE_BUDGET_WINDOW_MS = 1_000;

/**
 * Supplies an explanation for a change when one is genuinely known.
 *
 * IWOMC does not scrape the process table. Attribution comes from a coding
 * agent telling IWOMC what it is about to run, through the MCP tool or the
 * CLI. When nothing reported a command for the window, the event carries no
 * cause - which is the truthful outcome, not a gap to be filled with a guess.
 */
export type CauseResolver = (window: {
  from: string;
  to: string;
}) => Promise<ObservedCause | null> | ObservedCause | null;

export interface WatchOptions {
  readonly sweepIntervalMs?: number;
  readonly debounceMs?: number;
  readonly baselineEveryEvents?: number;
  readonly baselineEveryMs?: number;
  readonly now?: () => string;
  readonly resolveCause?: CauseResolver;
  readonly onSweep?: (result: SweepResult) => void;
  readonly onError?: (error: Error) => void;
  /**
   * Called once when this recorder stops, including when it stops itself
   * because the checkout disappeared. A resident caller needs this to know it
   * has nothing left to wait for.
   */
  readonly onStopped?: (reason: string) => void;
}

export interface SweepResult {
  readonly at: string;
  readonly source: "watched" | "swept";
  readonly events: readonly PackageEventV1[];
  readonly baseline: InventoryBaselineV1 | null;
  readonly packageCount: number;
  readonly commit: string | null;
  /** Managers that could not be read this sweep, with the reason. */
  readonly unavailable: readonly { manager: string; reason: string }[];
}

export interface WatcherInput {
  readonly store: CompanionStore;
  readonly projectId: string;
  readonly projectDir: string;
  readonly registry: AdapterRegistry;
  readonly options?: WatchOptions;
}

/**
 * A probe that refuses to run anything.
 *
 * Handed to adapters during a sweep. `notFound` is the honest answer: from the
 * loop's point of view there is no executable available, and the adapter's own
 * coverage gap explains what it could not determine as a result.
 */
const REFUSING_PROBE = async (argv: readonly string[]): Promise<ProbeResult> => ({
  ok: false,
  exitCode: null,
  stdout: "",
  stderr: `The background watcher does not execute commands, so \`${argv[0] ?? ""}\` was not run. Inventory comes from reading project-local directories.`,
  timedOut: false,
  notFound: true,
});

/**
 * Raised when another recorder already holds this project on this device.
 *
 * Not a failure: it means the log is already being kept. The caller reads
 * instead of writing, and says which recorder holds it.
 */
export class RecorderBusyError extends Error {
  readonly projectId: string;
  readonly heldBy: { startedAt: string; lastSeenAt: string } | undefined;

  constructor(projectId: string, heldBy?: { startedAt: string; lastSeenAt: string }) {
    super(
      `Another IWOMC recorder is already watching this project${
        heldBy ? ` (running since ${heldBy.startedAt})` : ""
      }.`,
    );
    this.name = "RecorderBusyError";
    this.projectId = projectId;
    this.heldBy = heldBy;
  }
}

/** Raised when the watched checkout no longer exists on disk. */
export class ProjectGoneError extends Error {
  readonly projectDir: string;
  constructor(projectDir: string) {
    super(`The checkout at ${projectDir} no longer exists, so recording has stopped.`);
    this.name = "ProjectGoneError";
    this.projectDir = projectDir;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export class PackageWatcher {
  readonly #input: WatcherInput;
  readonly #options: Required<
    Omit<WatchOptions, "resolveCause" | "onSweep" | "onError" | "onStopped">
  > &
    Pick<WatchOptions, "resolveCause" | "onSweep" | "onError" | "onStopped">;
  readonly #watchers = new Map<string, FSWatcher>();

  #sessionId: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #debounce: NodeJS.Timeout | null = null;
  #debounceStartedAt = 0;
  #running = false;
  #stopped = false;
  #pendingTrigger: "watched" | null = null;
  #previous: InventoryReading | null = null;
  #eventsSinceBaseline = 0;
  #lastBaselineAt = 0;
  #inFlight: Promise<SweepResult | null> = Promise.resolve(null);

  constructor(input: WatcherInput) {
    this.#input = input;
    const options = input.options ?? {};
    this.#options = {
      sweepIntervalMs: options.sweepIntervalMs ?? DEFAULTS.sweepIntervalMs,
      debounceMs: options.debounceMs ?? DEFAULTS.debounceMs,
      baselineEveryEvents: options.baselineEveryEvents ?? DEFAULTS.baselineEveryEvents,
      baselineEveryMs: options.baselineEveryMs ?? DEFAULTS.baselineEveryMs,
      now: options.now ?? (() => new Date().toISOString()),
      ...(options.resolveCause ? { resolveCause: options.resolveCause } : {}),
      ...(options.onSweep ? { onSweep: options.onSweep } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
      ...(options.onStopped ? { onStopped: options.onStopped } : {}),
    };
  }

  /**
   * Begin watching.
   *
   * The first sweep records a baseline and produces no events: claiming that
   * every already-installed package was installed the instant IWOMC started
   * would be false, and would corrupt every later fold.
   */
  async start(): Promise<SweepResult> {
    const sessionId = randomId(8);
    const lease = this.#input.store.acquireRecorderLease({
      sessionId,
      projectId: this.#input.projectId,
      at: this.#options.now(),
      sweepIntervalMs: this.#options.sweepIntervalMs,
    });
    if (!lease.acquired) {
      throw new RecorderBusyError(this.#input.projectId, lease.heldBy);
    }
    this.#sessionId = sessionId;

    this.#previous = this.#lastKnownReading();
    const first = await this.sweep("swept");
    await this.#attachWatchers();
    // Deliberately not unref'd: the sweep timer is what keeps `iwomc watch`
    // resident. `stop` clears it, so nothing outlives an explicit stop.
    this.#timer = setInterval(() => {
      void this.#trigger("swept");
    }, this.#options.sweepIntervalMs);
    return first;
  }

  async stop(reason = "stopped"): Promise<void> {
    if (this.#stopped) return;
    this.#shutdown(reason);
    // Only a caller outside the sweep may wait for it. `#shutdown` is used
    // from inside one, where awaiting this promise would wait on itself.
    await this.#inFlight.catch(() => null);
  }

  /**
   * Release everything and close the observation window, without waiting for
   * an in-flight sweep. Safe to call from inside that sweep.
   */
  #shutdown(reason: string): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#debounce) clearTimeout(this.#debounce);
    for (const watcher of this.#watchers.values()) {
      try {
        watcher.close();
      } catch {
        // A handle for a directory that has since been deleted.
      }
    }
    this.#watchers.clear();
    if (this.#sessionId) {
      this.#input.store.endWatchSession(this.#sessionId, this.#options.now(), reason);
      this.#sessionId = null;
    }
    this.#options.onStopped?.(reason);
  }

  /**
   * Read the installed set without recording anything.
   *
   * Used when another recorder holds this project: the answer is still true,
   * it just is not this process's job to write it down.
   */
  async observe(): Promise<SweepResult> {
    const reading = await readInventory(this.#input.projectDir, this.#input.registry);
    const head = await readHeadState(this.#input.projectDir);
    return {
      at: reading.at,
      source: "swept",
      events: [],
      baseline: null,
      packageCount: reading.packages.length,
      commit: head.commit,
      unavailable: reading.unavailable,
    };
  }

  /** Force a sweep now and wait for it. Used by `iwomc sweep` and by tests. */
  async sweepNow(): Promise<SweepResult> {
    return await this.sweep(this.#pendingTrigger ?? "swept");
  }

  #trigger(source: "watched" | "swept"): void {
    if (this.#stopped) return;
    if (source === "watched") this.#pendingTrigger = "watched";
    if (this.#running) return;
    this.#inFlight = this.sweep(this.#pendingTrigger ?? source)
      .then((result) => result)
      .catch((error: unknown) => {
        this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
        return null;
      });
  }

  #onFilesystemEvent(): void {
    if (this.#stopped) return;
    this.#pendingTrigger = "watched";

    const now = Date.now();
    if (this.#debounce === null) this.#debounceStartedAt = now;

    // Coalesce a burst, but never let an unbroken stream postpone the sweep
    // indefinitely. A large install produces events continuously for as long
    // as it runs; a broken handle produces them forever.
    if (now - this.#debounceStartedAt >= MAX_DEBOUNCE_MS) {
      if (this.#debounce) clearTimeout(this.#debounce);
      this.#debounce = null;
      this.#debounceStartedAt = 0;
      this.#trigger("watched");
      return;
    }

    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      this.#debounceStartedAt = 0;
      this.#trigger("watched");
    }, this.#options.debounceMs);
    this.#debounce.unref?.();
  }

  /**
   * One full observation: read, diff against the previous read, persist.
   *
   * Serialized against itself. A sweep that arrives while one is running is
   * not run concurrently - two interleaved reads could produce a diff that
   * never existed on disk. It is not simply dropped either: a package manager
   * writing while a sweep is in flight is the common case, not the rare one,
   * and waiting a whole interval to notice it would throw away the entire
   * point of watching. The pending trigger is honoured as soon as the current
   * sweep finishes.
   */
  async sweep(source: "watched" | "swept"): Promise<SweepResult> {
    if (this.#running) {
      const existing = await this.#inFlight;
      if (existing) return existing;
    }
    this.#running = true;
    this.#pendingTrigger = null;
    try {
      return await this.#sweepOnce(source);
    } finally {
      this.#running = false;
      if (this.#pendingTrigger !== null && !this.#stopped) {
        // Something changed while this sweep was reading. Go again rather
        // than leaving it for the interval.
        this.#onFilesystemEvent();
      }
    }
  }

  async #sweepOnce(source: "watched" | "swept"): Promise<SweepResult> {
    const { store, projectId, projectDir, registry } = this.#input;

    // A project can go away underneath a long-lived recorder: deleted, moved,
    // or on a drive that was unmounted. Retrying every interval forever would
    // fill the log with the same error and claim to be watching something that
    // no longer exists.
    if (!(await directoryExists(projectDir))) {
      this.#shutdown("project directory is gone");
      throw new ProjectGoneError(projectDir);
    }
    const previous = this.#previous;
    const from = previous?.at ?? this.#options.now();
    const reading = await readInventory(projectDir, registry);
    const at = reading.at;

    const head = await readHeadState(projectDir);
    const startSeq = store.nextPackageEventSeq(projectId);
    const dirty =
      previous === null ? await readWorktreeDirty(projectDir) : undefined;

    let events = deriveEvents(previous, reading, {
      projectId,
      from,
      to: at,
      commit: head.commit,
      branch: head.branch,
      // Recomputed below when there is actually something to attribute; a
      // status scan on every quiet sweep is not worth its cost.
      worktreeDirty: dirty ?? false,
      source,
    }, startSeq);

    if (events.length > 0) {
      const worktreeDirty = await readWorktreeDirty(projectDir);
      const cause = await this.#resolveCause(from, at);
      // The store assigns the real sequence numbers and tells us which events
      // it actually kept, so a change another process already recorded is not
      // reported twice.
      events = store.appendPackageEvents(
        events.map((event) => ({ ...event, worktreeDirty, ...(cause ? { cause } : {}) })),
      );
      this.#eventsSinceBaseline += events.length;
    }

    this.#previous = reading;
    // The heartbeat is what separates "still watching" from "was killed" when
    // a later fold asks which periods were actually observed.
    if (this.#sessionId) store.touchWatchSession(this.#sessionId, at);

    const baseline = this.#maybeBaseline(reading, head.commit);
    const result: SweepResult = {
      at,
      source,
      events,
      baseline,
      packageCount: reading.packages.length,
      commit: head.commit,
      unavailable: reading.unavailable,
    };
    this.#options.onSweep?.(result);

    // Directories appear and disappear; reattach so a project that had no
    // node_modules when the watcher started still gets fast triggers later.
    if (!this.#stopped) await this.#attachWatchers();
    return result;
  }

  /**
   * The last state IWOMC recorded, folded back out of the log.
   *
   * Without this, every process start would see no previous reading and could
   * only write another baseline - so `iwomc sweep`, which is a fresh process
   * each time, would never record a single event, and a restarted watcher
   * would lose everything that happened while it was down. Seeding from the
   * log means the first sweep after a restart correctly reports what changed
   * in the meantime, inside a window that starts at the last observation.
   */
  #lastKnownReading(): InventoryReading | null {
    const { store, projectId } = this.#input;
    const seq = store.nextPackageEventSeq(projectId) - 1;
    const baseline = store.baselineAtOrBefore(projectId, seq);
    if (!baseline) return null;

    const events = store.listPackageEvents(projectId, { fromSeq: baseline.seq + 1, toSeq: seq });
    const state = fold({ at: baseline.at, commit: baseline.commit, baseline, events, coverage: [] });
    const at = events[events.length - 1]?.at ?? baseline.at;

    // Adopt the stored baseline's position too, so a process that restarts
    // every few seconds does not rewrite a baseline on each start.
    this.#lastBaselineAt = Date.parse(baseline.at);
    this.#eventsSinceBaseline = events.length;

    return {
      at,
      packages: state.packages.map((entry) => ({
        ecosystem: entry.ecosystem,
        manager: entry.manager,
        adapterId: entry.adapterId,
        name: entry.name,
        version: entry.version,
      })),
    };
  }

  async #resolveCause(from: string, to: string): Promise<ObservedCause | null> {
    if (!this.#options.resolveCause) return null;
    try {
      return (await this.#options.resolveCause({ from, to })) ?? null;
    } catch (error) {
      this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  #maybeBaseline(reading: InventoryReading, commit: string | null): InventoryBaselineV1 | null {
    const elapsed = Date.parse(reading.at) - this.#lastBaselineAt;
    const first = this.#lastBaselineAt === 0;
    const due =
      first ||
      this.#eventsSinceBaseline >= this.#options.baselineEveryEvents ||
      elapsed >= this.#options.baselineEveryMs;
    if (!due) return null;

    // A baseline at sequence S means "the state after event S has been
    // applied", so a fold replays S+1 onward. On the very first sweep no event
    // exists yet and the baseline sits at -1.
    //
    // The position is read from the store now rather than carried down from
    // before the append: the reading describes the disk as it is, so the
    // baseline must claim the newest sequence the log actually holds.
    const lastSeq = this.#input.store.nextPackageEventSeq(this.#input.projectId) - 1;
    const baseline = baselineFrom(this.#input.projectId, reading, lastSeq, commit);
    this.#input.store.saveInventoryBaseline(baseline);
    this.#eventsSinceBaseline = 0;
    this.#lastBaselineAt = Date.parse(reading.at);

    // A baseline of a large project is a quarter of a megabyte, and one is
    // written every few hundred changes. Thinning the old ones here keeps the
    // store from growing without bound; the events, which are the actual
    // record, are never touched.
    try {
      this.#input.store.pruneBaselines(this.#input.projectId, reading.at);
    } catch (error) {
      this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
    return baseline;
  }

  async #attachWatchers(): Promise<void> {
    for (const target of WATCH_TARGETS) {
      const absolute = target === "." ? this.#input.projectDir : join(this.#input.projectDir, target);
      if (this.#watchers.has(absolute)) continue;
      let isDirectory = false;
      try {
        isDirectory = (await stat(absolute)).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory) continue;
      try {
        let windowStartedAt = 0;
        let eventsInWindow = 0;

        const retire = (): void => {
          try {
            watcher.close();
          } catch {
            // Already gone.
          }
          this.#watchers.delete(absolute);
        };

        const watcher = fsWatch(absolute, { persistent: false }, () => {
          // A handle whose directory has been deleted reports the deletion
          // without pause. Retiring it here is what stops the storm; the
          // change itself is still picked up by the sweep this schedules, and
          // the handle is re-attached once the directory exists again.
          const now = Date.now();
          if (now - windowStartedAt > HANDLE_BUDGET_WINDOW_MS) {
            windowStartedAt = now;
            eventsInWindow = 0;
          }
          eventsInWindow += 1;
          if (eventsInWindow > HANDLE_EVENT_BUDGET) {
            retire();
            this.#onFilesystemEvent();
            return;
          }
          this.#onFilesystemEvent();
        });

        watcher.on("error", () => {
          // The directory was replaced wholesale, which several package
          // managers do. Drop the handle; the next sweep reattaches.
          retire();
          this.#onFilesystemEvent();
        });
        this.#watchers.set(absolute, watcher);
      } catch {
        // Watch handles are a finite resource and some filesystems refuse
        // them entirely. The sweep still runs, so this degrades latency, not
        // correctness.
      }
    }
  }
}

export interface InventoryReadingWithGaps extends InventoryReading {
  readonly unavailable: readonly { manager: string; reason: string }[];
}

/**
 * Read every installed package this machine can see for the project, without
 * running anything.
 */
export async function readInventory(
  projectDir: string,
  registry: AdapterRegistry,
): Promise<InventoryReadingWithGaps> {
  const files = new FileSystemProjectFiles(projectDir);
  const ctx: AdapterContext = {
    projectDir,
    files,
    platform: currentPlatform(),
    probe: REFUSING_PROBE,
  };

  const packages: ObservedPackage[] = [];
  const unavailable: { manager: string; reason: string }[] = [];
  const adapters = await registry.detectAll(files);

  for (const adapter of adapters) {
    if (!adapter.manifest.capabilities.inventory) continue;
    let result;
    try {
      result = await adapter.inventory(ctx);
    } catch (error) {
      unavailable.push({
        manager: adapter.manifest.manager,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!result.available || !result.snapshot) {
      unavailable.push({
        manager: adapter.manifest.manager,
        reason: result.gaps[0]?.reason ?? "The installed set could not be read.",
      });
      continue;
    }
    for (const entry of result.snapshot.entries) {
      packages.push({
        ecosystem: adapter.manifest.ecosystem,
        manager: result.snapshot.manager,
        adapterId: adapter.manifest.id,
        name: entry.name,
        version: entry.version,
      });
    }
  }

  return { at: new Date().toISOString(), packages, unavailable };
}

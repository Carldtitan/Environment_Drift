/**
 * The temporal package log: derivation, folding, and honest coverage.
 *
 * A contract answers "what does this revision need". The log answers a
 * different question: "what did this machine actually have installed at 14:32
 * last Tuesday, and what changed between then and the commit you are looking
 * at". Those are not the same question, and a snapshot cannot answer the
 * second one - a snapshot cannot even express a downgrade.
 *
 * Three properties hold here and are worth stating plainly, because the value
 * of the log is entirely in whether they are true:
 *
 * 1. The log is append-only. A correction is a new event. Replaying the same
 *    sequence range twice always produces the same state.
 * 2. Every event carries an observation window, not just an instant. IWOMC
 *    learns that a package changed by comparing two reads; the change happened
 *    somewhere between them. Reporting the later read as the moment of change
 *    would be a small lie repeated thousands of times.
 * 3. A fold reports what it could not see. If the watcher was not running for
 *    six hours, `stateAt` says so rather than implying the log is complete.
 */

import { digestOf } from "@iwomc/contracts";
import type {
  CoverageGap,
  InventoryBaselineV1,
  ObservedCause,
  PackageEventKind,
  PackageEventSource,
  PackageEventV1,
  PointInTimeState,
} from "@iwomc/contracts";

/** One package as observed on disk. */
export interface ObservedPackage {
  readonly ecosystem: string;
  readonly manager: string;
  readonly adapterId: string;
  readonly name: string;
  readonly version: string;
}

/** A full read of one project's installed packages at one instant. */
export interface InventoryReading {
  readonly at: string;
  readonly packages: readonly ObservedPackage[];
}

export interface EventContext {
  readonly projectId: string;
  /** The window the change must have happened in: previous read to this read. */
  readonly from: string;
  readonly to: string;
  readonly commit: string | null;
  readonly branch: string | null;
  readonly worktreeDirty: boolean;
  readonly source: PackageEventSource;
  readonly cause?: ObservedCause;
}

export function packageKey(manager: string, name: string): string {
  return `${manager}|${name}`;
}

/**
 * Compare an ordering-independent version pair.
 *
 * This deliberately does not import a semver comparator. The log records what
 * the manager reported, and plenty of managers report versions semver cannot
 * order (`2023.4`, `1.0.0.post1`, a git sha). When the two versions cannot be
 * ordered the event is recorded as an upgrade with the honest caveat that the
 * direction is unknown - a wrong ordering claim is worse than an unspecific
 * one. `compareLoose` returns null when it will not guess.
 */
export function compareLoose(a: string, b: string): number | null {
  const partsA = a.split(/[.+-]/u).filter((part) => part.length > 0);
  const partsB = b.split(/[.+-]/u).filter((part) => part.length > 0);
  const length = Math.max(partsA.length, partsB.length);
  let decided: number | null = null;
  for (let index = 0; index < length; index += 1) {
    const left = partsA[index];
    const right = partsB[index];
    if (left === right) continue;
    // One version ran out of parts. `1.2` before `1.2.1` is safe. `1.0.0`
    // against `1.0.0-rc1` is not: a prerelease suffix reverses the order in
    // some ecosystems and not others, so the honest answer is that IWOMC does
    // not know.
    if (left === undefined) return /^[0-9]+$/u.test(right as string) ? -1 : null;
    if (right === undefined) return /^[0-9]+$/u.test(left) ? 1 : null;
    const numericLeft = /^[0-9]+$/u.test(left);
    const numericRight = /^[0-9]+$/u.test(right);
    if (numericLeft && numericRight) {
      decided = Number(left) < Number(right) ? -1 : 1;
      return decided;
    }
    // A prerelease tag against a number, or two unlike tags: not orderable
    // without guessing at the manager's own rules.
    return null;
  }
  return 0;
}

export function classifyChange(from: string | null, to: string | null): PackageEventKind {
  if (from === null) return "installed";
  if (to === null) return "removed";
  const order = compareLoose(from, to);
  return order === -1 || order === null ? "upgraded" : "downgraded";
}

/**
 * Derive events from two readings.
 *
 * `previous` may be null, which means this is the first reading of the project.
 * A first reading produces a baseline rather than a wall of fake "installed"
 * events - claiming that four hundred packages were installed at the instant
 * IWOMC started watching would be false, and would poison every later fold.
 */
export function deriveEvents(
  previous: InventoryReading | null,
  current: InventoryReading,
  context: EventContext,
  startSeq: number,
): PackageEventV1[] {
  if (previous === null) return [];

  const before = new Map<string, ObservedPackage>();
  for (const entry of previous.packages) before.set(packageKey(entry.manager, entry.name), entry);
  const after = new Map<string, ObservedPackage>();
  for (const entry of current.packages) after.set(packageKey(entry.manager, entry.name), entry);

  const changes: { key: string; from: ObservedPackage | null; to: ObservedPackage | null }[] = [];
  for (const [key, entry] of after) {
    const prior = before.get(key);
    if (!prior) changes.push({ key, from: null, to: entry });
    else if (prior.version !== entry.version) changes.push({ key, from: prior, to: entry });
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) changes.push({ key, from: entry, to: null });
  }

  // Stable ordering so the same pair of readings always yields the same
  // sequence numbers, on any machine.
  changes.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));

  return changes.map((change, index) => {
    const shape = change.to ?? change.from;
    if (!shape) throw new Error("a change must have a before or an after");
    const fromVersion = change.from?.version ?? null;
    const toVersion = change.to?.version ?? null;
    const event: PackageEventV1 = {
      schemaVersion: 1,
      id: eventId(context.projectId, shape.manager, shape.name, fromVersion, toVersion, context.to),
      projectId: context.projectId,
      seq: startSeq + index,
      at: context.to,
      window: { from: context.from, to: context.to },
      ecosystem: shape.ecosystem,
      manager: shape.manager,
      adapterId: shape.adapterId,
      name: shape.name,
      fromVersion,
      toVersion,
      kind: classifyChange(fromVersion, toVersion),
      commit: context.commit,
      branch: context.branch,
      worktreeDirty: context.worktreeDirty,
      source: context.source,
      ...(context.cause ? { cause: context.cause } : {}),
    };
    return event;
  });
}

function eventId(
  projectId: string,
  manager: string,
  name: string,
  fromVersion: string | null,
  toVersion: string | null,
  at: string,
): string {
  // Deterministic and independent of the sequence number, so re-deriving the
  // same observation after a crash collides with the stored row instead of
  // duplicating it.
  return digestOf({ projectId, manager, name, fromVersion, toVersion, at }).slice(7, 39);
}

export function baselineFrom(
  projectId: string,
  reading: InventoryReading,
  seq: number,
  commit: string | null,
): InventoryBaselineV1 {
  const entries = reading.packages
    .map((entry) => ({
      ecosystem: entry.ecosystem,
      manager: entry.manager,
      adapterId: entry.adapterId,
      name: entry.name,
      version: entry.version,
    }))
    .sort((left, right) => {
      const a = packageKey(left.manager, left.name);
      const b = packageKey(right.manager, right.name);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return {
    schemaVersion: 1,
    id: digestOf({ projectId, seq, at: reading.at }).slice(7, 39),
    projectId,
    seq,
    at: reading.at,
    commit,
    entries,
    digest: digestOf(entries),
  };
}

// ------------------------------------------------------------------ fold --

export interface FoldInput {
  readonly at: string;
  readonly commit: string | null;
  readonly baseline: InventoryBaselineV1 | null;
  readonly events: readonly PackageEventV1[];
  readonly coverage: readonly CoverageGap[];
}

/**
 * Replay a baseline plus its following events into the state at one instant.
 *
 * Pure, so it is testable without a store and identical on every machine.
 */
export function fold(input: FoldInput): PointInTimeState {
  const state = new Map<
    string,
    {
      ecosystem: string;
      manager: string;
      adapterId: string;
      name: string;
      version: string;
      since?: string;
    }
  >();

  if (input.baseline) {
    for (const entry of input.baseline.entries) {
      state.set(packageKey(entry.manager, entry.name), {
        ecosystem: entry.ecosystem,
        manager: entry.manager,
        adapterId: entry.adapterId,
        name: entry.name,
        version: entry.version,
        since: input.baseline.at,
      });
    }
  }

  let replayed = 0;
  for (const event of input.events) {
    const key = packageKey(event.manager, event.name);
    replayed += 1;
    if (event.toVersion === null) {
      state.delete(key);
      continue;
    }
    state.set(key, {
      ecosystem: event.ecosystem,
      manager: event.manager,
      adapterId: event.adapterId,
      name: event.name,
      version: event.toVersion,
      since: event.at,
    });
  }

  const coverage: CoverageGap[] = [...input.coverage];
  if (!input.baseline) {
    coverage.push({
      area: "baseline",
      reason:
        "No inventory baseline was recorded at or before this point, so the state is reconstructed from events alone and omits anything installed before watching began.",
      remediation: "Run `iwomc watch` on this project to record a baseline.",
    });
  }

  const packages = [...state.values()].sort((left, right) => {
    const a = packageKey(left.manager, left.name);
    const b = packageKey(right.manager, right.name);
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return { at: input.at, commit: input.commit, packages, replayedEvents: replayed, coverage };
}

// -------------------------------------------------------------- coverage --

export interface Interval {
  readonly startedAt: string;
  /** Updated after every sweep, so a killed watcher stops covering time. */
  readonly lastSeenAt: string;
  readonly sweepIntervalMs: number;
  readonly endedAt: string | null;
}

/**
 * Periods inside `[from, to]` that no watch session covered.
 *
 * A session that ended covers exactly its own span. A session that never
 * ended is either running now or was killed, and the two are indistinguishable
 * from the row alone - so it covers up to one grace period past its last
 * heartbeat and no further. A live watcher therefore covers right up to the
 * present, while one that died overnight stops covering when it died instead
 * of silently vouching for eight hours it never saw.
 */
export function uncoveredIntervals(
  sessions: readonly Interval[],
  from: string,
  to: string,
): { from: string; to: string }[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const spans = sessions
    .map((session) => ({
      start: Math.max(start, Date.parse(session.startedAt)),
      end: Math.min(end, sessionEnd(session)),
    }))
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
    .sort((left, right) => left.start - right.start);

  const merged: { start: number; end: number }[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  const gaps: { from: string; to: string }[] = [];
  let cursor = start;
  for (const span of merged) {
    if (span.start > cursor) gaps.push({ from: new Date(cursor).toISOString(), to: new Date(span.start).toISOString() });
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < end) gaps.push({ from: new Date(cursor).toISOString(), to: new Date(end).toISOString() });
  return gaps;
}

function sessionEnd(session: Interval): number {
  if (session.endedAt !== null) return Date.parse(session.endedAt);
  const lastSeen = Date.parse(session.lastSeenAt);
  if (!Number.isFinite(lastSeen)) return Date.parse(session.startedAt);
  // Two intervals of slack: one for the sweep that is due, one for a slow one.
  return lastSeen + Math.max(session.sweepIntervalMs, 1000) * 2;
}

export function describeCoverage(gaps: readonly { from: string; to: string }[]): CoverageGap[] {
  if (gaps.length === 0) return [];
  const totalMs = gaps.reduce((sum, gap) => sum + (Date.parse(gap.to) - Date.parse(gap.from)), 0);
  return [
    {
      area: "watch_coverage",
      reason: `The watcher was not running for ${formatDuration(totalMs)} of this period, across ${gaps.length} ${
        gaps.length === 1 ? "gap" : "gaps"
      }. Changes made during that time were only detected by the next sweep, so their timing is approximate and a change that was later undone may be missing entirely.`,
      remediation: "Keep `iwomc watch` running, or start it from your shell profile.",
    },
  ];
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

// ------------------------------------------------------------------ diff --

export interface StateDiffEntry {
  readonly ecosystem: string;
  readonly manager: string;
  readonly adapterId: string;
  readonly name: string;
  readonly fromVersion: string | null;
  readonly toVersion: string | null;
  readonly kind: PackageEventKind;
}

export interface StateDiff {
  readonly entries: readonly StateDiffEntry[];
  readonly coverage: readonly CoverageGap[];
}

/** What would have to change to turn state `a` into state `b`. */
export function diffStates(a: PointInTimeState, b: PointInTimeState): StateDiff {
  const before = new Map(a.packages.map((entry) => [packageKey(entry.manager, entry.name), entry]));
  const after = new Map(b.packages.map((entry) => [packageKey(entry.manager, entry.name), entry]));
  const entries: StateDiffEntry[] = [];

  for (const [key, entry] of after) {
    const prior = before.get(key);
    if (prior && prior.version === entry.version) continue;
    entries.push({
      ecosystem: entry.ecosystem,
      manager: entry.manager,
      adapterId: entry.adapterId,
      name: entry.name,
      fromVersion: prior?.version ?? null,
      toVersion: entry.version,
      kind: classifyChange(prior?.version ?? null, entry.version),
    });
  }
  for (const [key, entry] of before) {
    if (after.has(key)) continue;
    entries.push({
      ecosystem: entry.ecosystem,
      manager: entry.manager,
      adapterId: entry.adapterId,
      name: entry.name,
      fromVersion: entry.version,
      toVersion: null,
      kind: "removed",
    });
  }

  entries.sort((left, right) => {
    const x = packageKey(left.manager, left.name);
    const y = packageKey(right.manager, right.name);
    return x < y ? -1 : x > y ? 1 : 0;
  });

  // Both sides' blind spots apply to the difference between them.
  const coverage = dedupeCoverage([...a.coverage, ...b.coverage]);
  return { entries, coverage };
}

function dedupeCoverage(gaps: readonly CoverageGap[]): CoverageGap[] {
  const seen = new Set<string>();
  const out: CoverageGap[] = [];
  for (const gap of gaps) {
    const key = `${gap.area}|${gap.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gap);
  }
  return out;
}

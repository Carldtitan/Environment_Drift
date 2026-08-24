/**
 * Point-in-time queries over the stored package log.
 *
 * This is the thin layer that turns "what did Alice's machine look like at her
 * commit" into a baseline lookup plus a bounded event replay. The replay
 * itself lives in `timeline.ts` and is pure; everything here is about reading
 * the right rows and being honest about which ones do not exist.
 */

import type { CoverageGap, PointInTimeState } from "@iwomc/contracts";
import type { CompanionStore } from "./store.js";
import { describeCoverage, diffStates, fold, uncoveredIntervals, type StateDiff } from "./timeline.js";

/** How many events a single fold will replay before it refuses to guess. */
const MAX_REPLAY = 20000;

export interface HistoryQuery {
  /** ISO instant. Defaults to now. */
  readonly at?: string;
  /** Exact Git revision. Takes precedence over `at`. */
  readonly commit?: string;
}

export interface CommitNotObserved {
  readonly kind: "commit_not_observed";
  readonly commit: string;
  readonly message: string;
}

export type HistoryResult = PointInTimeState | CommitNotObserved;

export function isCommitNotObserved(result: HistoryResult): result is CommitNotObserved {
  return (result as CommitNotObserved).kind === "commit_not_observed";
}

/**
 * The state of a project's installed packages at an instant.
 *
 * `at` in the future is not an error - it simply returns the current state,
 * which is what "now" means for a log that only records the past.
 */
export function stateAt(store: CompanionStore, projectId: string, at: string): PointInTimeState {
  const seq = store.seqAtTime(projectId, at);
  return foldToSeq(store, projectId, seq, at, null);
}

/**
 * The state of a project's installed packages while a revision was checked out.
 *
 * Returns `commit_not_observed` rather than a nearby guess when this machine
 * never had that revision checked out while the log was recording. A confident
 * wrong answer here is the exact failure IWOMC exists to prevent.
 */
export function stateAtCommit(
  store: CompanionStore,
  projectId: string,
  commit: string,
): HistoryResult {
  const seq = store.seqAtCommit(projectId, commit);
  if (seq === null) {
    // Nothing *changed* while that revision was checked out, but IWOMC may
    // still have looked at it - a capture or a first sweep records a baseline
    // and no events, which is a complete answer, not an absent one.
    const baseline = store.latestBaselineForCommit(projectId, commit);
    if (baseline) {
      return foldToSeq(store, projectId, baseline.seq, baseline.at, commit);
    }
    return {
      kind: "commit_not_observed",
      commit,
      message:
        "No package activity was recorded for this revision on this device. Either it was never checked out here, or the watcher was not running while it was.",
    };
  }
  const events = store.listPackageEvents(projectId, { fromSeq: seq, toSeq: seq, limit: 1 });
  const at = events[0]?.at ?? new Date().toISOString();
  return foldToSeq(store, projectId, seq, at, commit);
}

function foldToSeq(
  store: CompanionStore,
  projectId: string,
  seq: number,
  at: string,
  commit: string | null,
): PointInTimeState {
  const baseline = store.baselineAtOrBefore(projectId, seq);
  const fromSeq = baseline ? baseline.seq + 1 : 0;
  const span = seq - fromSeq + 1;
  const events =
    seq < fromSeq ? [] : store.listPackageEvents(projectId, { fromSeq, toSeq: seq, limit: MAX_REPLAY });

  const coverage: CoverageGap[] = [];
  if (span > MAX_REPLAY) {
    coverage.push({
      area: "replay_limit",
      reason: `This range holds ${span} events and the fold replayed the first ${MAX_REPLAY}. The result is incomplete.`,
      remediation: "Record baselines more often so folds start closer to the point being queried.",
    });
  }

  const from = baseline?.at ?? events[0]?.window.from ?? at;
  coverage.push(...describeCoverage(uncoveredIntervals(store.listWatchSessions(projectId), from, at)));

  // When the caller asked by time rather than by revision, report the
  // revision that was checked out when the last replayed change happened.
  // That is a recorded fact, not an inference about the current worktree.
  const observedCommit = commit ?? events[events.length - 1]?.commit ?? baseline?.commit ?? null;
  return fold({ at, commit: observedCommit, baseline, events, coverage });
}

/** What changed between two points in time, in the order a person would fix it. */
export function diffAt(
  store: CompanionStore,
  projectId: string,
  a: string,
  b: string,
): StateDiff {
  return diffStates(stateAt(store, projectId, a), stateAt(store, projectId, b));
}

export interface CommitDiff {
  readonly diff: StateDiff | null;
  readonly missing: CommitNotObserved[];
}

/** What changed between two revisions, when both were actually observed here. */
export function diffCommits(
  store: CompanionStore,
  projectId: string,
  a: string,
  b: string,
): CommitDiff {
  const left = stateAtCommit(store, projectId, a);
  const right = stateAtCommit(store, projectId, b);
  const missing = [left, right].filter(isCommitNotObserved);
  if (missing.length > 0) return { diff: null, missing };
  return {
    diff: diffStates(left as PointInTimeState, right as PointInTimeState),
    missing: [],
  };
}

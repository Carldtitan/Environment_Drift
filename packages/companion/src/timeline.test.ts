import { describe, expect, it } from "vitest";
import {
  baselineFrom,
  classifyChange,
  compareLoose,
  deriveEvents,
  describeCoverage,
  diffStates,
  fold,
  uncoveredIntervals,
  type InventoryReading,
} from "./timeline.js";

const CONTEXT = {
  projectId: "project-1",
  from: "2026-08-23T10:00:00.000Z",
  to: "2026-08-23T10:00:30.000Z",
  commit: "a".repeat(40),
  branch: "main",
  worktreeDirty: false,
  source: "swept" as const,
};

function reading(at: string, packages: Record<string, string>): InventoryReading {
  return {
    at,
    packages: Object.entries(packages).map(([name, version]) => ({
      ecosystem: "node",
      manager: "npm",
      adapterId: "npm",
      name,
      version,
    })),
  };
}

describe("version comparison", () => {
  it("orders ordinary releases", () => {
    expect(compareLoose("1.2.3", "1.2.4")).toBe(-1);
    expect(compareLoose("2.0.0", "1.9.9")).toBe(1);
    expect(compareLoose("1.2.3", "1.2.3")).toBe(0);
    expect(compareLoose("1.2", "1.2.1")).toBe(-1);
  });

  it("refuses to guess when the two versions are not comparable", () => {
    // A manager may report anything at all as a version. Claiming an order
    // here would be a fabricated fact about the developer's machine.
    expect(compareLoose("1.0.0", "1.0.0-rc1")).toBeNull();
    expect(compareLoose("2023.4", "main")).toBeNull();
  });

  it("names a downgrade as a downgrade", () => {
    expect(classifyChange("5.1.0", "4.18.2")).toBe("downgraded");
    expect(classifyChange("4.18.2", "5.1.0")).toBe("upgraded");
    expect(classifyChange(null, "1.0.0")).toBe("installed");
    expect(classifyChange("1.0.0", null)).toBe("removed");
  });

  it("treats an unorderable change as an upgrade rather than inventing a downgrade", () => {
    expect(classifyChange("1.0.0", "1.0.0-rc1")).toBe("upgraded");
  });
});

describe("deriving events", () => {
  it("produces nothing for the first reading", () => {
    const events = deriveEvents(null, reading(CONTEXT.to, { left: "1.0.0" }), CONTEXT, 0);
    expect(events).toEqual([]);
  });

  it("records installs, upgrades, downgrades, and removals in one diff", () => {
    const before = reading(CONTEXT.from, { alpha: "1.0.0", beta: "2.0.0", gamma: "3.0.0" });
    const after = reading(CONTEXT.to, { alpha: "1.1.0", beta: "1.0.0", delta: "0.1.0" });

    const events = deriveEvents(before, after, CONTEXT, 7);
    const byName = Object.fromEntries(events.map((event) => [event.name, event]));

    expect(events.map((event) => event.seq)).toEqual([7, 8, 9, 10]);
    expect(byName["alpha"]?.kind).toBe("upgraded");
    expect(byName["beta"]?.kind).toBe("downgraded");
    expect(byName["beta"]?.fromVersion).toBe("2.0.0");
    expect(byName["beta"]?.toVersion).toBe("1.0.0");
    expect(byName["gamma"]?.kind).toBe("removed");
    expect(byName["gamma"]?.toVersion).toBeNull();
    expect(byName["delta"]?.kind).toBe("installed");
    expect(byName["delta"]?.fromVersion).toBeNull();
  });

  it("carries the observation window, not just the instant it was noticed", () => {
    const events = deriveEvents(
      reading(CONTEXT.from, { alpha: "1.0.0" }),
      reading(CONTEXT.to, { alpha: "1.1.0" }),
      CONTEXT,
      0,
    );
    expect(events[0]?.window).toEqual({ from: CONTEXT.from, to: CONTEXT.to });
    expect(events[0]?.at).toBe(CONTEXT.to);
  });

  it("binds every event to the revision that was checked out", () => {
    const events = deriveEvents(
      reading(CONTEXT.from, {}),
      reading(CONTEXT.to, { alpha: "1.0.0" }),
      CONTEXT,
      0,
    );
    expect(events[0]?.commit).toBe(CONTEXT.commit);
    expect(events[0]?.branch).toBe("main");
  });

  it("gives the same event the same id however many times it is derived", () => {
    const derive = (startSeq: number) =>
      deriveEvents(reading(CONTEXT.from, {}), reading(CONTEXT.to, { alpha: "1.0.0" }), CONTEXT, startSeq);
    // The id must not depend on the sequence number, or a crash between
    // deriving and appending would duplicate the row on restart.
    expect(derive(0)[0]?.id).toBe(derive(99)[0]?.id);
  });
});

describe("folding to a point in time", () => {
  it("replays events over a baseline", () => {
    const baseline = baselineFrom(
      "project-1",
      reading("2026-08-23T09:00:00.000Z", { alpha: "1.0.0", beta: "2.0.0" }),
      -1,
      null,
    );
    const events = deriveEvents(
      reading(CONTEXT.from, { alpha: "1.0.0", beta: "2.0.0" }),
      reading(CONTEXT.to, { alpha: "1.0.0", beta: "1.5.0", gamma: "0.1.0" }),
      CONTEXT,
      0,
    );

    const state = fold({ at: CONTEXT.to, commit: null, baseline, events, coverage: [] });
    const versions = Object.fromEntries(state.packages.map((entry) => [entry.name, entry.version]));
    expect(versions).toEqual({ alpha: "1.0.0", beta: "1.5.0", gamma: "0.1.0" });
    expect(state.replayedEvents).toBe(2);
  });

  it("says so when it has no baseline to start from", () => {
    const state = fold({ at: CONTEXT.to, commit: null, baseline: null, events: [], coverage: [] });
    expect(state.coverage.map((gap) => gap.area)).toContain("baseline");
  });

  it("is idempotent: replaying the same events twice gives the same state", () => {
    const events = deriveEvents(
      reading(CONTEXT.from, { alpha: "1.0.0" }),
      reading(CONTEXT.to, { alpha: "2.0.0" }),
      CONTEXT,
      0,
    );
    const once = fold({ at: CONTEXT.to, commit: null, baseline: null, events, coverage: [] });
    const twice = fold({ at: CONTEXT.to, commit: null, baseline: null, events: [...events, ...events], coverage: [] });
    expect(twice.packages).toEqual(once.packages);
  });
});

describe("watch coverage", () => {
  const window = { from: "2026-08-23T00:00:00.000Z", to: "2026-08-23T12:00:00.000Z" };

  it("reports nothing missing when one session covers the whole period", () => {
    const gaps = uncoveredIntervals(
      [{ startedAt: "2026-08-22T00:00:00.000Z", lastSeenAt: "2026-08-23T12:00:00.000Z", sweepIntervalMs: 45_000, endedAt: null }],
      window.from,
      window.to,
    );
    expect(gaps).toEqual([]);
    expect(describeCoverage(gaps)).toEqual([]);
  });

  it("finds the hours nobody was watching", () => {
    const gaps = uncoveredIntervals(
      [
        { startedAt: "2026-08-23T00:00:00.000Z", lastSeenAt: "2026-08-23T03:00:00.000Z", sweepIntervalMs: 45_000, endedAt: "2026-08-23T03:00:00.000Z" },
        { startedAt: "2026-08-23T05:00:00.000Z", lastSeenAt: "2026-08-23T12:00:00.000Z", sweepIntervalMs: 45_000, endedAt: "2026-08-23T12:00:00.000Z" },
      ],
      window.from,
      window.to,
    );
    expect(gaps).toEqual([{ from: "2026-08-23T03:00:00.000Z", to: "2026-08-23T05:00:00.000Z" }]);

    const described = describeCoverage(gaps);
    expect(described[0]?.area).toBe("watch_coverage");
    expect(described[0]?.reason).toContain("2.0h");
  });

  it("stops covering time when a watcher was killed instead of stopped", () => {
    // No `endedAt`, and the last heartbeat was hours ago: the process died.
    // Treating that as "still running" would vouch for a period nobody saw.
    const gaps = uncoveredIntervals(
      [
        {
          startedAt: "2026-08-23T00:00:00.000Z",
          lastSeenAt: "2026-08-23T02:00:00.000Z",
          sweepIntervalMs: 45_000,
          endedAt: null,
        },
      ],
      window.from,
      window.to,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.to).toBe(window.to);
    expect(Date.parse(gaps[0]?.from as string)).toBeGreaterThanOrEqual(
      Date.parse("2026-08-23T02:00:00.000Z"),
    );
  });

  it("merges overlapping sessions instead of double-counting them", () => {
    const gaps = uncoveredIntervals(
      [
        { startedAt: "2026-08-23T00:00:00.000Z", lastSeenAt: "2026-08-23T08:00:00.000Z", sweepIntervalMs: 45_000, endedAt: "2026-08-23T08:00:00.000Z" },
        { startedAt: "2026-08-23T04:00:00.000Z", lastSeenAt: "2026-08-23T12:00:00.000Z", sweepIntervalMs: 45_000, endedAt: "2026-08-23T12:00:00.000Z" },
      ],
      window.from,
      window.to,
    );
    expect(gaps).toEqual([]);
  });
});

describe("diffing two points in time", () => {
  it("describes what a teammate would have to change", () => {
    const left = fold({
      at: "a",
      commit: null,
      baseline: baselineFrom("p", reading("a", { alpha: "1.0.0", beta: "2.0.0" }), -1, null),
      events: [],
      coverage: [],
    });
    const right = fold({
      at: "b",
      commit: null,
      baseline: baselineFrom("p", reading("b", { alpha: "1.0.0", beta: "1.0.0", gamma: "9.9.9" }), -1, null),
      events: [],
      coverage: [],
    });

    const diff = diffStates(left, right);
    expect(diff.entries).toEqual([
      {
        ecosystem: "node",
        manager: "npm",
        adapterId: "npm",
        name: "beta",
        fromVersion: "2.0.0",
        toVersion: "1.0.0",
        kind: "downgraded",
      },
      {
        ecosystem: "node",
        manager: "npm",
        adapterId: "npm",
        name: "gamma",
        fromVersion: null,
        toVersion: "9.9.9",
        kind: "installed",
      },
    ]);
  });

  it("carries both sides' blind spots into the difference", () => {
    const withGap = fold({
      at: "a",
      commit: null,
      baseline: null,
      events: [],
      coverage: [],
    });
    const diff = diffStates(withGap, withGap);
    expect(diff.coverage.map((gap) => gap.area)).toEqual(["baseline"]);
  });
});

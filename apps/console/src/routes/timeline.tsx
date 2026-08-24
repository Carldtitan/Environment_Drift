import { useEffect, useState } from "react";
import { api, ApiError, type TimelineView } from "../api.ts";
import { Button, Card, Empty, Facts, Loading, Mono, Notice, Pill, relativeTime } from "../components/primitives.tsx";

/**
 * The package timeline.
 *
 * Two panes that never blend into each other: on the left, what was actually
 * installed - replayed from the device's own append-only log, identical on any
 * machine holding it. On the right, what the agent was doing at that moment,
 * from durable memory. The second explains the first and is never allowed to
 * stand in for it, so the left pane renders unchanged when memory is down.
 */

const KIND_TONE = {
  installed: "ready",
  upgraded: "info",
  downgraded: "attention",
  removed: "danger",
} as const;

function packagesInstalledLabel(count: number): string {
  return count === 1 ? "1 package installed" : `${count} packages installed`;
}

/**
 * A package.json without a `version` is unusual but legal. Rendering the gap
 * as blank leaves a reader guessing whether something failed.
 */
function versionLabel(version: string | null): string {
  if (version === null) return "";
  return version.trim().length === 0 ? "unknown version" : version;
}

function VersionMove({ from, to }: { from: string | null; to: string | null }) {
  if (from === null) return <Mono>{versionLabel(to)}</Mono>;
  if (to === null) return <Mono>{versionLabel(from)}</Mono>;
  return (
    <span>
      <Mono>{versionLabel(from)}</Mono>
      <span aria-hidden="true"> → </span>
      <span className="sr-only"> to </span>
      <Mono>{versionLabel(to)}</Mono>
    </span>
  );
}

export function TimelineRoute({ projectId }: { projectId: string | null }) {
  const [view, setView] = useState<TimelineView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<string>("");
  const [commit, setCommit] = useState<string>("");
  const [query, setQuery] = useState<{ at?: string; commit?: string }>({});

  useEffect(() => {
    let cancelled = false;
    setView(null);
    api
      .timeline(projectId, query)
      .then((value) => {
        if (!cancelled) setView(value);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, query]);

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (view === null) return <Loading label="Replaying the package log" rows={4} />;

  if (!view.available) {
    return <Empty title="The package timeline lives on the device that recorded it">{view.detail}</Empty>;
  }
  if (!view.timeline) {
    return (
      <Empty
        title="No checkout is registered on this device"
        steps={[
          <>
            Run <Mono>iwomc init</Mono> inside a Git checkout.
          </>,
          <>
            Run <Mono>iwomc watch</Mono> to start recording installs as they happen.
          </>,
        ]}
      />
    );
  }

  const { state, recentEvents, totalEvents, memory, anchor } = view.timeline;
  const notObserved = "kind" in state;

  const ask = () => {
    setQuery({
      ...(commit.trim() ? { commit: commit.trim() } : {}),
      ...(!commit.trim() && at.trim() ? { at: new Date(at).toISOString() } : {}),
    });
  };

  return (
    <div className="stack">
      <Card
        title="Point in time"
        action={
          <Button
            onClick={() => {
              setAt("");
              setCommit("");
              setQuery({});
            }}
          >
            Now
          </Button>
        }
      >
        <div className="field-row">
          <label className="field">
            <span className="field__label">Moment</span>
            <input
              type="datetime-local"
              value={at}
              onChange={(event) => setAt(event.target.value)}
              disabled={commit.trim().length > 0}
            />
          </label>
          <label className="field">
            <span className="field__label">or Git revision</span>
            <input
              type="text"
              inputMode="text"
              spellCheck={false}
              placeholder="full commit sha"
              value={commit}
              onChange={(event) => setCommit(event.target.value)}
            />
          </label>
          <Button variant="primary" onClick={ask}>
            Show that moment
          </Button>
        </div>
      </Card>

      {notObserved ? (
        <Empty title={`Revision ${(state as { commit: string }).commit.slice(0, 12)} was never observed here`}>
          {(state as { message: string }).message} A teammate who did have it checked out while watching can
          share their log. IWOMC will not estimate the answer from a nearby revision.
        </Empty>
      ) : (
        <Card title={packagesInstalledLabel((state as { packages: unknown[] }).packages.length)}>
          <Facts
            rows={[
              ["At", <span key="at">{new Date(anchor.at).toLocaleString()}</span>],
              [
                "Revision",
                anchor.commit ?? (state as { commit: string | null }).commit ? (
                  <Mono key="rev">
                    {(anchor.commit ?? (state as { commit: string | null }).commit ?? "").slice(0, 12)}
                  </Mono>
                ) : (
                  <span key="rev" className="hint">
                    not recorded
                  </span>
                ),
              ],
              [
                "Replayed",
                <span key="replayed">
                  {(state as { replayedEvents: number }).replayedEvents} of {totalEvents} recorded changes
                </span>,
              ],
            ]}
          />
        </Card>
      )}

      <div className="split">
        <Card title="What changed">
          {recentEvents.length === 0 ? (
            <p className="hint">
              Nothing has changed since IWOMC started watching this project. Run <Mono>iwomc watch</Mono> in the
              background to record installs, upgrades, and downgrades as they happen.
            </p>
          ) : (
            <ul className="record-list">
              {[...recentEvents].reverse().map((event) => (
                <li key={event.id} className="record">
                  <span className="record__label">
                    <Pill tone={KIND_TONE[event.kind]}>{event.kind}</Pill> {event.name}
                  </span>
                  <span className="record__meta">
                    <VersionMove from={event.fromVersion} to={event.toVersion} /> · {event.manager}
                    {event.source === "swept" ? " · found by a sweep" : " · caught as it happened"}
                  </span>
                  <span className="record__aside">
                    <span className="hint">{relativeTime(event.at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="What the agent was doing">
          <MemoryPane memory={memory} />
        </Card>
      </div>

      {!notObserved && (state as { coverage: { area: string; reason: string }[] }).coverage.length > 0 ? (
        <Card title="What this answer does not cover">
          <ul className="record-list">
            {(state as { coverage: { area: string; reason: string; remediation?: string }[] }).coverage.map(
              (gap) => (
                <li key={gap.area} className="record">
                  <span className="record__label">{gap.area.replace(/_/gu, " ")}</span>
                  {/* The reason is the point of the row, so it wraps rather
                      than being clipped to one line. */}
                  <span className="record__meta record__meta--wrap">{gap.reason}</span>
                  {gap.remediation ? (
                    <span className="record__meta record__meta--wrap">{gap.remediation}</span>
                  ) : null}
                </li>
              ),
            )}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function MemoryPane({ memory }: { memory: TimelineView["timeline"] extends null ? never : NonNullable<TimelineView["timeline"]>["memory"] }) {
  if (memory === null) {
    return <p className="hint">Memory integration is not configured. The record beside this is unaffected.</p>;
  }
  if (memory.status.status !== "connected") {
    return (
      <>
        <Pill tone="attention">memory disconnected</Pill>
        <p className="hint" style={{ marginTop: 12 }}>
          {memory.status.detail} The record beside this is deterministic and unaffected.
        </p>
      </>
    );
  }
  if (memory.entries.length === 0) {
    return <p className="hint">Claude-Mem holds no observations near this moment.</p>;
  }
  return (
    <>
      <p className="hint">Explanation only. Never used as environment truth.</p>
      <ul className="record-list">
        {memory.entries.map((entry) => (
          <li key={entry.id} className="record">
            <span className="record__label">{entry.title}</span>
            {entry.text !== entry.title ? <span className="record__meta">{entry.text}</span> : null}
            <span className="record__aside">
              <span className="hint">{entry.at ? relativeTime(entry.at) : entry.position}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

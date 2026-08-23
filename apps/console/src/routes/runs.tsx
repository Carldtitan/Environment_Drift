import type { Job, Overview, RescueOutcome } from "../api.ts";
import {
  BlockerPanel,
  Card,
  Empty,
  Facts,
  Loading,
  Mono,
  relativeTime,
  shortDigest,
} from "../components/primitives.tsx";
import { RunStatePill } from "../components/signal-grid.tsx";

/**
 * Rescue runs read as a chronology of what a device did, and requests in flight
 * read as a chronology of what it was asked to do. Neither is optimistic: a
 * request that has not been picked up says so.
 */
export function RunsRoute({ overview }: { overview: Overview | null }) {
  if (overview === null) return <Loading label="Reading rescue runs" rows={4} />;

  const active = overview.jobs.filter((job) => job.state !== "finished" && job.state !== "expired");
  const finished = overview.jobs.filter((job) => job.state === "finished" || job.state === "expired");

  return (
    <div className="stack">
      {active.length > 0 ? (
        <Card title="Requests in flight">
          <ul className="record-list">
            {active.map((job) => (
              <JobRow key={job.request.id} job={job} devices={overview.devices} />
            ))}
          </ul>
        </Card>
      ) : null}

      {overview.runs.length === 0 ? (
        <Empty title="No rescue has run in this workspace yet">
          A rescue run appears here the moment a device reports a signed outcome. Nothing is shown before that.
        </Empty>
      ) : (
        overview.runs.map((run) => <RunCard key={run.runId} run={run} />)
      )}

      {finished.length > 0 ? (
        <Card title="Completed requests">
          <ul className="record-list">
            {finished.slice(0, 12).map((job) => (
              <JobRow key={job.request.id} job={job} devices={overview.devices} />
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function RunCard({ run }: { run: RescueOutcome }) {
  const duration = Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt));
  return (
    <Card
      title={
        <span className="row" style={{ gap: 10 }}>
          <RunStatePill state={run.state} />
          <span style={{ fontSize: "1rem" }}>{run.commit.slice(0, 12)}</span>
        </span>
      }
      action={<span className="hint">{relativeTime(run.endedAt)}</span>}
    >
      <Facts
        rows={[
          ["Contract", <Mono key="c">{shortDigest(run.contractDigest)}</Mono>],
          ["Duration", `${(duration / 1000).toFixed(1)} s`],
          [
            "Proof",
            run.proof
              ? `exit ${run.proof.exitCode ?? "none"}${run.proof.timedOut ? " (timed out)" : ""} after ${(run.proof.durationMs / 1000).toFixed(1)} s`
              : "not reached — the run stopped before the proof command",
          ],
          ["Assurance", run.assurance.replace(/_/gu, " ")],
          [
            "Steps applied",
            run.stepsApplied.length === 0 ? "none" : <Mono key="s">{run.stepsApplied.join(", ")}</Mono>,
          ],
        ]}
      />
      {run.blocker ? (
        <div style={{ marginTop: 16 }}>
          <BlockerPanel blocker={run.blocker} />
        </div>
      ) : null}
    </Card>
  );
}

function JobRow({ job, devices }: { job: Job; devices: Overview["devices"] }) {
  const device = devices.find((entry) => entry.id === job.request.deviceId);
  const expired = Date.parse(job.request.expiresAt) <= Date.now();
  const latest = job.progress[job.progress.length - 1];

  return (
    <li className="record">
      <span className="record__label">
        {job.request.action} · {device?.displayName ?? job.request.deviceId.slice(0, 8)}
      </span>
      <span className="record__meta">
        {latest
          ? latest.message
          : expired
            ? "expired before the device picked it up"
            : "queued — waiting for the device to poll"}
      </span>
      <span className="record__aside">
        <RunStatePill state={expired && job.state !== "finished" ? "inconclusive" : job.state} />
        <span className="hint">{relativeTime(job.request.issuedAt)}</span>
      </span>
      {job.progress.length > 1 ? (
        <details style={{ gridColumn: "1 / -1", marginTop: 10 }}>
          <summary className="hint" style={{ cursor: "pointer" }}>
            {job.progress.length} progress reports
          </summary>
          <ol className="timeline" style={{ marginTop: 12 }}>
            {job.progress.map((entry, index) => (
              <li key={index} data-terminal={index === job.progress.length - 1 ? "true" : "false"}>
                <div className="timeline__when">{new Date(entry.at).toLocaleTimeString()}</div>
                <div className="timeline__what">{entry.message}</div>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </li>
  );
}

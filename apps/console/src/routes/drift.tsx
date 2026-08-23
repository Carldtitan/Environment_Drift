import { useEffect, useState } from "react";
import { api, ApiError, type DriftView, type Overview } from "../api.ts";
import { Button, Card, Empty, Loading, Mono, Notice, relativeTime } from "../components/primitives.tsx";

/**
 * Drift is the gap between what the repository declares and what a capture
 * observed. Findings live on the device that captured them, so this screen says
 * so plainly when it is not running next to a Companion.
 */
export function DriftRoute({
  projectId,
  overview,
  onChanged,
}: {
  projectId: string | null;
  overview: Overview | null;
  onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<DriftView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .drift(projectId)
      .then((value) => {
        if (!cancelled) setView(value);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const device = overview?.devices.find((entry) => entry.state === "active") ?? null;

  const askPromote = async () => {
    if (!projectId || !device) return;
    setBusy(true);
    setError(null);
    try {
      await api.createJob({ projectId, deviceId: device.id, action: "promote" });
      setSent(
        `A promotion review was requested from ${device.displayName}. It produces a diff for review; nothing is written until a person applies it.`,
      );
      await onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (view === null) return <Loading label="Reading drift findings" rows={3} />;

  if (!view.available) {
    return (
      <Empty title="Drift findings live on the device that captured them">
        {view.detail}
      </Empty>
    );
  }

  if (view.findings.length === 0) {
    return (
      <Empty title="No drift at the captured revision">
        The repository declares everything the last capture observed. That is the state you want: the next
        developer gets what this machine has.
      </Empty>
    );
  }

  return (
    <div className="stack">
      {sent ? <Notice tone="ready">{sent}</Notice> : null}
      <Card
        title={`${view.findings.length} finding${view.findings.length === 1 ? "" : "s"}`}
        action={
          <Button busy={busy} disabled={!device} onClick={() => void askPromote()}>
            Review a repository repair
          </Button>
        }
      >
        <ul className="record-list">
          {view.findings.map((finding) => (
            <li key={finding.id} className="record">
              <span className="record__label">{finding.summary}</span>
              <span className="record__meta">
                {finding.kind.replace(/_/gu, " ")} · affects <Mono>{finding.affectedDeclaration}</Mono> · found by{" "}
                {finding.adapterId}
              </span>
              <span className="record__aside">
                <span className="hint">{relativeTime(finding.detectedAt)}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="hint" style={{ marginTop: 16 }}>
          A rescue installs these into project-local state without touching a tracked file. Promotion is the
          separate, reviewed step that writes them into the repository.
        </p>
      </Card>
    </div>
  );
}

import { useState } from "react";
import { api, ApiError, type Overview } from "../api.ts";
import {
  BlockerPanel,
  Button,
  Card,
  Empty,
  Facts,
  Loading,
  Mono,
  Notice,
  Pill,
  relativeTime,
  shortDigest,
} from "../components/primitives.tsx";
import { ContractDocument } from "../components/contract-document.tsx";
import { RunStatePill, SignalPanel, signalsFor, SupportPill } from "../components/signal-grid.tsx";

/**
 * The screen answers one question and offers one dominant action. Everything
 * else on it is evidence for that answer.
 */
export function OverviewRoute({
  overview,
  onChanged,
}: {
  overview: Overview | null;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [targetDeviceId, setTargetDeviceId] = useState<string | null>(null);

  if (overview === null) return <Loading label="Reading workspace state" rows={4} />;

  const local = overview.local;
  const projectId = overview.selectedProjectId;
  const runnableDevices = overview.devices.filter((entry) => entry.state === "active");
  const device =
    runnableDevices.find((entry) => entry.id === targetDeviceId) ?? runnableDevices[0] ?? null;
  const exact = overview.contracts.find(
    (entry) => entry.contract.source.commit === local?.project?.commit,
  );
  const newest = overview.contracts[0];
  const lastRun = overview.runs[0];

  const signals = signalsFor({
    hasContract: overview.contracts.length > 0,
    contractState: exact?.contract.state ?? null,
    declaredFileCount: exact?.contract.source.declaredFileDigests.length ?? 0,
  });

  if (overview.projects.length === 0) {
    return (
      <Empty
        title="No project is registered in this workspace yet"
        steps={[
          <>
            Open a Git checkout on a machine running the Companion and run <code>iwomc init --proof "&lt;the command that proves it works&gt;"</code>.
          </>,
          <>
            On a checkout where the project already works, run <code>iwomc capture</code>.
          </>,
          <>
            Run <code>iwomc verify</code> so the contract earns a real state.
          </>,
          <>
            On the broken checkout, run <code>iwomc rescue</code> — or press the action here.
          </>,
        ]}
      >
        A project appears here the moment a device registers one. Nothing is shown until then.
      </Empty>
    );
  }

  const askDevice = async (action: "capture" | "verify" | "rescue" | "promote") => {
    if (!projectId || !device) return;
    setBusy(action);
    setError(null);
    setSent(null);
    try {
      await api.createJob({
        projectId,
        deviceId: device.id,
        action,
        ...(exact ? { contractId: exact.contract.id } : {}),
      });
      setSent(
        `The ${action} request was sent to ${device.displayName}. It carries the project id and a signed expiry — never a path from this browser.`,
      );
      await onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const verdict = readVerdict(overview);

  return (
    <div className="stack">
      <section className="verdict">
        <div>
          <p className="verdict__question">Can this checkout be rescued now?</p>
          <h2 className="verdict__answer">{verdict.answer}</h2>
          <p className="verdict__reason">{verdict.reason}</p>

          <div className="verdict__actions">
            <Button
              variant="primary"
              dominant
              busy={busy === "rescue"}
              disabled={!verdict.canRescue || !device}
              onClick={() => void askDevice("rescue")}
              title={
                verdict.canRescue
                  ? "Send a signed rescue request to this device"
                  : "Rescue is unavailable until the reason above is resolved"
              }
            >
              Rescue this checkout
            </Button>
            <Button busy={busy === "capture"} disabled={!device} onClick={() => void askDevice("capture")}>
              Capture
            </Button>
            <Button busy={busy === "verify"} disabled={!device || !exact} onClick={() => void askDevice("verify")}>
              Verify contract
            </Button>
          </div>
          {runnableDevices.length > 0 ? (
            <div className="field" style={{ marginTop: 14, maxWidth: 360 }}>
              <label htmlFor="target-device">Target checkout</label>
              <select
                id="target-device"
                value={device?.id ?? ""}
                onChange={(event) => setTargetDeviceId(event.target.value || null)}
              >
                {runnableDevices.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.displayName} ({entry.platform.os}/{entry.platform.arch})
                  </option>
                ))}
              </select>
              <p className="hint">The signed job runs only in the checkout this device already registered.</p>
            </div>
          ) : null}
          {!device ? (
            <p className="hint" style={{ marginTop: 10 }}>
              No device is enrolled in this workspace, so there is nobody to ask. Pair one from the Team screen.
            </p>
          ) : null}
        </div>
        <SignalPanel signals={signals} />
      </section>

      {sent ? <Notice tone="ready">{sent}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <div className="grid-2">
        <div className="stack">
          {exact ? (
            <ContractDocument entry={exact} />
          ) : newest ? (
            <Card title="No contract for this exact revision">
              <p style={{ color: "var(--ink-600)" }}>
                The newest contract in this workspace is for {newest.contract.source.commit.slice(0, 12)}. IWOMC
                will not apply it to a different revision on its own — applying it is a deliberate choice.
              </p>
              <div style={{ marginTop: 16 }}>
                <ContractDocument entry={newest} compact />
              </div>
            </Card>
          ) : (
            <Empty title="No contract has been captured yet">
              Ask a teammate whose checkout works to run <code>iwomc capture</code>, or press Capture above to send
              that request to a device.
            </Empty>
          )}
        </div>

        <div className="stack">
          <Card title="This device">
            {local?.bound ? (
              <Facts
                rows={[
                  ["Project", local.project?.projectName ?? "-"],
                  [
                    "Revision",
                    <Mono key="r">
                      {local.project?.commit.slice(0, 12)}
                      {local.project?.branch ? ` · ${local.project.branch}` : ""}
                    </Mono>,
                  ],
                  [
                    "Worktree",
                    local.project?.worktreeDirty
                      ? `${local.project.dirtyPathCount} uncommitted change(s)`
                      : "clean",
                  ],
                  [
                    "Support",
                    local.support ? <SupportPill key="s" support={local.support.level} /> : "unknown",
                  ],
                  [
                    "Proof command",
                    local.proof?.configured ? (
                      <Mono key="p">{local.proof.command}</Mono>
                    ) : (
                      "not configured — IWOMC cannot report working without one"
                    ),
                  ],
                  [
                    "Memory",
                    <Pill key="m" tone={local.memory?.status === "connected" ? "ready" : "attention"}>
                      {local.memory?.status === "connected" ? "memory connected" : "memory disconnected"}
                    </Pill>,
                  ],
                ]}
              />
            ) : (
              <p style={{ color: "var(--ink-600)" }}>
                {local?.detail ??
                  "This console is not running alongside a Companion, so no local checkout state is available. The shared records below are still real."}
              </p>
            )}
          </Card>

          <Card title="Last rescue run">
            {lastRun ? (
              <div className="stack stack--tight">
                <div className="row">
                  <RunStatePill state={lastRun.state} />
                  <span className="hint">
                    {relativeTime(lastRun.endedAt)} · {lastRun.commit.slice(0, 12)}
                  </span>
                </div>
                <Facts
                  rows={[
                    ["Contract", <Mono key="c">{shortDigest(lastRun.contractDigest)}</Mono>],
                    ["Steps applied", String(lastRun.stepsApplied.length)],
                    [
                      "Proof",
                      lastRun.proof
                        ? `exit ${lastRun.proof.exitCode ?? "none"}${lastRun.proof.timedOut ? " (timed out)" : ""}`
                        : "not reached",
                    ],
                    ["Assurance", lastRun.assurance.replace(/_/gu, " ")],
                  ]}
                />
                {lastRun.blocker ? <BlockerPanel blocker={lastRun.blocker} /> : null}
              </div>
            ) : (
              <p style={{ color: "var(--ink-600)" }}>No rescue has run in this workspace yet.</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function readVerdict(overview: Overview): { answer: string; reason: string; canRescue: boolean } {
  const local = overview.local;
  if (local?.bound && local.canRescueNow) {
    return {
      answer: local.canRescueNow.possible ? "Yes" : "Not yet",
      reason: local.canRescueNow.reason,
      canRescue: local.canRescueNow.possible,
    };
  }

  const contracts = overview.contracts;
  if (contracts.length === 0) {
    return {
      answer: "Not yet",
      reason:
        "No contract has been captured for this project. A rescue needs evidence from a checkout where the project already works.",
      canRescue: false,
    };
  }
  const usable = contracts.find((entry) =>
    ["approved", "locally_checked", "clean_verified"].includes(entry.contract.state),
  );
  if (!usable) {
    return {
      answer: "Not yet",
      reason:
        "Every contract for this project is still a candidate. Verify one in a fresh directory, or approve it, before it can be applied.",
      canRescue: false,
    };
  }
  return {
    answer: "Yes, on a device that holds the checkout",
    reason: `A ${usable.contract.state.replace(/_/gu, " ")} contract exists for ${usable.contract.source.commit.slice(0, 12)}. The device checks the revision itself before it changes anything.`,
    canRescue: true,
  };
}

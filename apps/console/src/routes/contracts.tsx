import { useState } from "react";
import { api, ApiError, type Overview } from "../api.ts";
import { Button, Empty, Loading, Notice } from "../components/primitives.tsx";
import { ContractDocument } from "../components/contract-document.tsx";

export function ContractsRoute({
  overview,
  onChanged,
}: {
  overview: Overview | null;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  if (overview === null) return <Loading label="Reading contracts" rows={4} />;

  const device = overview.devices.find((entry) => entry.state === "active") ?? null;
  const projectId = overview.selectedProjectId;

  if (overview.contracts.length === 0) {
    return (
      <Empty
        title="No contract has been published for this project"
        steps={[
          <>
            On a checkout where the project works, run <code>iwomc capture</code>.
          </>,
          <>
            Run <code>iwomc verify</code> so the contract earns a real state instead of an assumed one.
          </>,
          <>The device publishes it here once it is signed.</>,
        ]}
      >
        A contract is bound to one exact Git revision. IWOMC will not invent one for a revision nobody captured.
      </Empty>
    );
  }

  const verify = async (contractId: string) => {
    if (!projectId || !device) return;
    setBusy(contractId);
    setError(null);
    setSent(null);
    try {
      await api.createJob({ projectId, deviceId: device.id, action: "verify", contractId });
      setSent(`A verification request was sent to ${device.displayName}.`);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      {sent ? <Notice tone="ready">{sent}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {overview.contracts.map((entry) => (
        <ContractDocument
          key={entry.contract.id}
          entry={entry}
          action={
            <Button
              variant="quiet"
              busy={busy === entry.contract.id}
              disabled={!device}
              onClick={() => void verify(entry.contract.id)}
              title={device ? "Ask a device to verify this contract" : "No active device to ask"}
            >
              Verify contract
            </Button>
          }
        />
      ))}
    </div>
  );
}

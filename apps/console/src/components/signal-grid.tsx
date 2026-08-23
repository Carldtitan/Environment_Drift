import type { ContractState, SupportLevel } from "../api.ts";
import { Pill, type Tone } from "./primitives.tsx";

/**
 * The signal grid.
 *
 * Four squares stand for the four kinds of evidence IWOMC can hold about a
 * revision: what the repository declares, what a capture observed, whether a
 * fresh directory on a developer machine proved it, and whether a clean remote
 * environment proved it. A filled square means IWOMC holds that evidence. The
 * legend spells each one out, so the grid is never the only way to read it.
 */

export type SignalRole = "declared" | "observed" | "locally_checked" | "clean_verified";

export const SIGNAL_ROLES: readonly SignalRole[] = [
  "declared",
  "observed",
  "locally_checked",
  "clean_verified",
];

export const SIGNAL_LABELS: Readonly<Record<SignalRole, { title: string; on: string; off: string }>> = {
  declared: {
    title: "Declared",
    on: "the repository states its own dependencies",
    off: "the repository does not state its dependencies",
  },
  observed: {
    title: "Observed",
    on: "a capture recorded what this project actually uses",
    off: "nothing has been captured for this revision",
  },
  locally_checked: {
    title: "Locally checked",
    on: "the contract passed in a fresh directory on a developer machine",
    off: "no fresh-directory check has passed",
  },
  clean_verified: {
    title: "Clean verified",
    on: "the contract passed in a disposable clean environment",
    off: "no clean-environment verification has passed",
  },
};

export interface Signals {
  declared: boolean;
  observed: boolean;
  locally_checked: boolean;
  clean_verified: boolean;
}

export function signalsFor(input: {
  hasContract: boolean;
  contractState?: ContractState | null;
  declaredFileCount?: number;
}): Signals {
  const state = input.contractState ?? null;
  return {
    declared: (input.declaredFileCount ?? 0) > 0,
    observed: input.hasContract,
    locally_checked: state === "locally_checked" || state === "clean_verified",
    clean_verified: state === "clean_verified",
  };
}

export function SignalGrid({
  signals,
  size = 12,
  label,
}: {
  signals: Signals;
  size?: number;
  label?: string;
}) {
  const on = SIGNAL_ROLES.filter((role) => signals[role]);
  const text =
    label ??
    (on.length === 0
      ? "No evidence held for this revision"
      : `Evidence held: ${on.map((role) => SIGNAL_LABELS[role].title.toLowerCase()).join(", ")}`);
  return (
    <span
      className="signal-grid"
      role="img"
      aria-label={text}
      style={{ ["--cell" as string]: `${size}px`, ["--cell-gap" as string]: `${Math.max(2, size / 3)}px` }}
    >
      {SIGNAL_ROLES.map((role) => (
        <span
          key={role}
          className="signal-grid__cell"
          data-role={role}
          data-on={signals[role] ? "true" : "false"}
        />
      ))}
    </span>
  );
}

export function SignalPanel({ signals }: { signals: Signals }) {
  return (
    <div className="signal-panel">
      <div className="row" style={{ gap: 14 }}>
        <SignalGrid signals={signals} size={22} />
        <div>
          <span className="section-label">Evidence held</span>
          <p style={{ fontWeight: 600 }}>
            {SIGNAL_ROLES.filter((role) => signals[role]).length} of 4
          </p>
        </div>
      </div>
      <dl className="signal-panel__legend">
        {SIGNAL_ROLES.map((role) => (
          <div key={role} style={{ display: "contents" }}>
            <dt>
              <span
                className="signal-grid__cell"
                data-role={role}
                data-on={signals[role] ? "true" : "false"}
                aria-hidden="true"
              />
            </dt>
            <dd>
              <b>{SIGNAL_LABELS[role].title}</b> —{" "}
              {signals[role] ? SIGNAL_LABELS[role].on : SIGNAL_LABELS[role].off}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ------------------------------------------------------------- vocabulary --

const CONTRACT_TONE: Readonly<Record<ContractState, Tone>> = {
  candidate: "info",
  approved: "info",
  locally_checked: "ready",
  clean_verified: "ready",
  rejected: "danger",
  unsupported: "attention",
  inconclusive: "attention",
  superseded: "neutral",
  revoked: "danger",
};

const CONTRACT_WORDS: Readonly<Record<ContractState, string>> = {
  candidate: "needs approval",
  approved: "approved",
  locally_checked: "locally checked",
  clean_verified: "clean verified",
  rejected: "rejected",
  unsupported: "unsupported",
  inconclusive: "inconclusive",
  superseded: "superseded",
  revoked: "revoked",
};

export function ContractStatePill({ state }: { state: ContractState }) {
  return <Pill tone={CONTRACT_TONE[state] ?? "neutral"}>{CONTRACT_WORDS[state] ?? state}</Pill>;
}

const RUN_TONE: Readonly<Record<string, Tone>> = {
  working: "ready",
  failed: "danger",
  blocked: "attention",
  unsupported: "attention",
  inconclusive: "attention",
  cancelled: "neutral",
};

export function RunStatePill({ state }: { state: string }) {
  return <Pill tone={RUN_TONE[state] ?? "neutral"}>{state}</Pill>;
}

const SUPPORT_TONE: Readonly<Record<SupportLevel, Tone>> = {
  native: "ready",
  recipe: "attention",
  observe_only: "neutral",
};

const SUPPORT_WORDS: Readonly<Record<SupportLevel, string>> = {
  native: "native",
  recipe: "recipe (needs review)",
  observe_only: "observe only",
};

export function SupportPill({ support }: { support: SupportLevel }) {
  return <Pill tone={SUPPORT_TONE[support] ?? "neutral"}>{SUPPORT_WORDS[support] ?? support}</Pill>;
}

const INTEGRATION_TONE: Readonly<Record<string, Tone>> = {
  connected: "ready",
  disconnected: "attention",
  not_configured: "neutral",
  misconfigured: "danger",
  permission_denied: "danger",
  unavailable: "attention",
};

export function IntegrationPill({ status }: { status: string }) {
  return (
    <Pill tone={INTEGRATION_TONE[status] ?? "neutral"}>{status.replace(/_/gu, " ")}</Pill>
  );
}

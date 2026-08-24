import type { ReactNode } from "react";

/**
 * One component vocabulary for the whole console. Every state a control can be
 * in - default, hover, focus, disabled, loading - is defined once here so two
 * screens can never disagree about what a button looks like.
 */

export type Tone = "ready" | "attention" | "danger" | "info" | "signal" | "neutral";

export function Button({
  children,
  variant = "secondary",
  dominant = false,
  busy = false,
  disabled = false,
  onClick,
  type = "button",
  title,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "quiet" | "danger";
  dominant?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  title?: string;
}) {
  return (
    <button
      type={type}
      className={`btn btn--${variant}${dominant ? " btn--dominant" : ""}`}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...(title ? { title } : {})}
    >
      {busy ? <span className="btn__spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/** Every state carries a word as well as a colour and a dot shape. */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="pill" data-tone={tone}>
      <span className="pill__dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Card({
  title,
  action,
  children,
  paper = false,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  paper?: boolean;
}) {
  return (
    <section className={`card${paper ? " card--paper" : ""}`}>
      {title !== undefined ? (
        <header className="card__head">
          <h2>{title}</h2>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "contents" }}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({
  title,
  children,
  steps,
}: {
  title: string;
  children?: ReactNode;
  steps?: ReactNode[];
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {steps ? (
        <ol>
          {steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function Loading({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="card" aria-busy="true" aria-live="polite">
      <span className="section-label">{label}</span>
      <div className="stack stack--tight" style={{ marginTop: 14 }}>
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="skeleton"
            style={{ width: `${100 - index * 12}%` }}
            aria-hidden="true"
          />
        ))}
      </div>
    </div>
  );
}

export function Notice({ tone, children }: { tone?: "danger" | "ready"; children: ReactNode }) {
  return (
    <p className="notice" {...(tone ? { "data-tone": tone } : {})} role={tone === "danger" ? "alert" : undefined}>
      {children}
    </p>
  );
}

/** A blocker always shows its code, what happened, and one next action. */
export function BlockerPanel({
  blocker,
}: {
  blocker: { code: string; message: string; nextAction: string };
}) {
  return (
    <div className="blocker" role="group" aria-label="Blocker">
      <span className="blocker__code">{blocker.code}</span>
      <p style={{ marginTop: 4 }}>{blocker.message}</p>
      <p className="blocker__next">
        <b>Next:</b> {blocker.nextAction}
      </p>
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="mono">{children}</span>;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function shortDigest(digest: string | undefined): string {
  if (!digest) return "-";
  return digest.startsWith("sha256:") ? digest.slice(7, 19) : digest.slice(0, 12);
}

/**
 * Which device should run work requested from this screen.
 *
 * On a team of one there is a single device and any choice is the same choice.
 * On a team of ten, "the first active device in the list" means sending your
 * rescue to whichever teammate's laptop happens to sort first - possibly one
 * that has not been switched on for months, in which case the job sits queued
 * until it expires and nobody finds out why.
 *
 * The console you are looking at usually belongs to a machine, and that is the
 * obvious default. Failing that, the device seen most recently is the one most
 * likely to still be there.
 */
export function preferredDevice<
  T extends { id: string; state: string; lastSeenAt?: string },
>(devices: readonly T[], localDeviceId?: string | null): T | null {
  const active = devices.filter((entry) => entry.state === "active");
  const here = localDeviceId ? active.find((entry) => entry.id === localDeviceId) : undefined;
  if (here) return here;
  return (
    [...active].sort((left, right) => (right.lastSeenAt ?? "").localeCompare(left.lastSeenAt ?? ""))[0] ??
    null
  );
}

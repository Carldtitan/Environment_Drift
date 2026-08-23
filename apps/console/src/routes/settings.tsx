import { useEffect, useState } from "react";
import { api, ApiError, type AuditView, type CapabilityView, type SettingsView } from "../api.ts";
import {
  Card,
  Empty,
  Facts,
  Loading,
  Mono,
  Notice,
  Pill,
  relativeTime,
} from "../components/primitives.tsx";
import { IntegrationPill, SupportPill } from "../components/signal-grid.tsx";

/**
 * Settings shows what is actually true. An integration reaches "connected" only
 * because a live health call succeeded, and every unavailable one names the
 * exact configuration value that is missing plus the next action.
 */
export function SettingsRoute() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityView | null>(null);
  const [audit, setAudit] = useState<AuditView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.settings(), api.capabilities(), api.audit()])
      .then(([one, two, three]) => {
        if (cancelled) return;
        setSettings(one);
        setCapabilities(two);
        setAudit(three);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (settings === null) return <Loading label="Reading integration state" rows={5} />;

  const integrations = settings.integrations;

  return (
    <div className="stack">
      <Card title="Control plane">
        <Facts
          rows={[
            ["Durable store", settings.store],
            ["Service signing key", <Mono key="k">{settings.servicePublicKey.slice(0, 24)}…</Mono>],
            [
              "Companion on this host",
              settings.localAvailable ? "connected to this console process" : "not running alongside this console",
            ],
            [
              "Audit chain",
              audit ? (
                <Pill key="a" tone={audit.chain.ok ? "ready" : "danger"}>
                  {audit.chain.ok ? "intact" : `broken at ${audit.chain.brokenAt}`}
                </Pill>
              ) : (
                "unknown"
              ),
            ],
          ]}
        />
      </Card>

      {integrations ? (
        <>
          <Card title="Verifiers">
            <ul className="record-list">
              {integrations.verifiers.map((verifier) => (
                <li key={verifier.id} className="record">
                  <span className="record__label">{verifier.label}</span>
                  <span className="record__meta record__meta--wrap">{verifier.detail}</span>
                  <span className="record__aside">
                    {verifier.remainingBudgetUsd !== undefined ? (
                      <span className="hint">USD {verifier.remainingBudgetUsd.toFixed(2)} left</span>
                    ) : null}
                    <Pill tone={verifier.available ? "ready" : "attention"}>
                      {verifier.available ? "available" : "unavailable"}
                    </Pill>
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Durable memory">
            <div className="row">
              <IntegrationPill status={integrations.memory.status} />
              {integrations.memory.endpoint ? (
                <Mono>{integrations.memory.endpoint}</Mono>
              ) : null}
            </div>
            <p style={{ marginTop: 10, color: "var(--ink-600)" }}>{integrations.memory.detail}</p>
            <p className="hint" style={{ marginTop: 8 }}>
              Memory records why a requirement exists. It is never inventory, authorization, proof, or secret
              storage, and IWOMC keeps working without it.
            </p>
          </Card>

          <Card title="Integrations">
            <ul className="record-list">
              {integrations.reports.map((report) => (
                <li key={report.id} className="record">
                  <span className="record__label">{report.label}</span>
                  <span className="record__meta record__meta--wrap">{report.detail ?? report.nextAction}</span>
                  <span className="record__aside">
                    <IntegrationPill status={report.status} />
                  </span>
                  <details style={{ gridColumn: "1 / -1", marginTop: 10 }}>
                    <summary className="hint" style={{ cursor: "pointer" }}>
                      Configuration ({report.requirements.filter((entry) => entry.present).length}/
                      {report.requirements.length} present)
                    </summary>
                    <ul style={{ margin: "10px 0 0", padding: 0, listStyle: "none" }}>
                      {report.requirements.map((requirement) => (
                        <li key={requirement.name} className="row" style={{ padding: "4px 0", gap: 10 }}>
                          <Pill tone={requirement.present ? "ready" : "neutral"}>
                            {requirement.present ? "set" : "missing"}
                          </Pill>
                          <Mono>{requirement.name}</Mono>
                          <span className="hint">{requirement.description}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="hint" style={{ marginTop: 10 }}>
                      <b>Next:</b> {report.nextAction}
                    </p>
                  </details>
                </li>
              ))}
            </ul>
          </Card>
        </>
      ) : (
        <Empty title="Integration state comes from a Companion">
          This console is not running next to a Companion process, so it cannot report which integrations that
          machine has. Run <code>iwomc doctor</code> there instead.
        </Empty>
      )}

      {capabilities?.adapters ? (
        <Card title="Ecosystem support">
          <p style={{ color: "var(--ink-600)", marginBottom: 14 }}>
            Recognising a package manager is not the same as supporting it. This is what this build can actually
            do.
          </p>
          <ul className="record-list">
            {capabilities.adapters.map((adapter) => (
              <li key={adapter.id} className="record">
                <span className="record__label">
                  {adapter.ecosystem} · {adapter.manager}
                </span>
                <span className="record__meta record__meta--wrap">{adapter.supportNote}</span>
                <span className="record__aside">
                  {adapter.conformanceTested ? <Pill tone="info">conformance tested</Pill> : null}
                  <SupportPill support={adapter.support} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {audit && audit.events.length > 0 ? (
        <Card title="Audit">
          <ol className="timeline">
            {audit.events.slice(0, 25).map((event, index) => (
              <li key={event.id} data-terminal={index === 0 ? "true" : "false"}>
                <div className="timeline__when">
                  {new Date(event.at).toLocaleString()} · {event.digest.slice(7, 19)}
                </div>
                <div className="timeline__what">
                  <b>{event.action}</b> — {event.subject} by {event.actor}
                </div>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}
    </div>
  );
}

export { relativeTime };

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type TeamView } from "../api.ts";
import {
  Button,
  Card,
  Empty,
  Loading,
  Mono,
  Notice,
  Pill,
  relativeTime,
} from "../components/primitives.tsx";

const ROLES = ["owner", "maintainer", "developer", "reviewer", "observer"] as const;

export function TeamRoute() {
  const [view, setView] = useState<TeamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [role, setRole] = useState<string>("developer");
  const [issued, setIssued] = useState<{ command: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.team());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (view === null) return <Loading label="Reading workspace membership" rows={3} />;

  const canManage = view.role === "owner" || view.role === "maintainer";

  const act = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <Card
        title="Invite a teammate"
        action={<Pill tone="neutral">your role: {view.role}</Pill>}
      >
        {canManage ? (
          <>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <div className="field" style={{ minWidth: 200 }}>
                <label htmlFor="invite-role">Role</label>
                <select id="invite-role" value={role} onChange={(event) => setRole(event.target.value)}>
                  {ROLES.filter((entry) => entry !== "owner" || view.role === "owner").map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                variant="primary"
                busy={busy === "invite"}
                onClick={() =>
                  void act("invite", async () => {
                    const created = await api.createInvitation(role);
                    setIssued({ command: created.command });
                  })
                }
              >
                Create invitation
              </Button>
            </div>
            {issued ? (
              <div style={{ marginTop: 16 }}>
                <p className="section-label">Single use, expires in 7 days, shown once</p>
                <pre className="machine" style={{ marginTop: 8 }}>
                  {issued.command}
                </pre>
                <p className="hint" style={{ marginTop: 8 }}>
                  Send this to your teammate over a channel you trust. Only its hash is stored here, so it cannot
                  be shown again.
                </p>
              </div>
            ) : null}
          </>
        ) : (
          <p style={{ color: "var(--ink-600)" }}>
            Creating invitations needs the maintainer role or higher. Yours is {view.role}.
          </p>
        )}
      </Card>

      <Card title={`Members (${view.members.length})`}>
        <ul className="record-list">
          {view.members.map((member) => (
            <li key={member.personId} className="record">
              <span className="record__label">{member.person.displayName}</span>
              <span className="record__meta">
                <Mono>{member.personId}</Mono> · joined {relativeTime(member.joinedAt)}
              </span>
              <span className="record__aside">
                {view.role === "owner" ? (
                  <select
                    aria-label={`Role for ${member.person.displayName}`}
                    className="field"
                    value={member.role}
                    style={{ minHeight: 34, padding: "0 8px", borderRadius: 8, border: "1px solid var(--rule-strong)", background: "var(--paper)" }}
                    onChange={(event) =>
                      void act(`role:${member.personId}`, () =>
                        api.changeRole(member.personId, event.target.value).then(() => undefined),
                      )
                    }
                  >
                    {ROLES.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Pill tone="neutral">{member.role}</Pill>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={`Devices (${view.devices.length})`}>
        {view.devices.length === 0 ? (
          <Empty title="No device is enrolled">
            A device enrolls by running <code>iwomc join &lt;invitation&gt;</code>. Its private signing key never
            leaves that machine.
          </Empty>
        ) : (
          <ul className="record-list">
            {view.devices.map((device) => (
              <li key={device.id} className="record">
                <span className="record__label">{device.displayName}</span>
                <span className="record__meta">
                  {device.platform.os}/{device.platform.arch} · enrolled {relativeTime(device.enrolledAt)} · last
                  seen {relativeTime(device.lastSeenAt)}
                </span>
                <span className="record__aside">
                  <Pill tone={device.state === "active" ? "ready" : device.state === "revoked" ? "danger" : "info"}>
                    {device.state}
                  </Pill>
                  {canManage && device.state !== "revoked" ? (
                    <Button
                      variant="danger"
                      busy={busy === `revoke:${device.id}`}
                      onClick={() =>
                        void act(`revoke:${device.id}`, () => api.revokeDevice(device.id).then(() => undefined))
                      }
                    >
                      Revoke
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage ? (
        <Card title={`Invitations (${view.invitations.length})`}>
          {view.invitations.length === 0 ? (
            <p style={{ color: "var(--ink-600)" }}>No invitation has been created.</p>
          ) : (
            <ul className="record-list">
              {view.invitations.map((invitation) => {
                const expired = Date.parse(invitation.expiresAt) <= Date.now();
                const state = invitation.revokedAt
                  ? "revoked"
                  : invitation.acceptedAt
                    ? "used"
                    : expired
                      ? "expired"
                      : "open";
                return (
                  <li key={invitation.id} className="record">
                    <span className="record__label">{invitation.role}</span>
                    <span className="record__meta">
                      created {relativeTime(invitation.createdAt)} · expires {relativeTime(invitation.expiresAt)}
                    </span>
                    <span className="record__aside">
                      <Pill tone={state === "open" ? "info" : state === "used" ? "ready" : "neutral"}>{state}</Pill>
                      {state === "open" ? (
                        <Button
                          variant="quiet"
                          busy={busy === `inv:${invitation.id}`}
                          onClick={() =>
                            void act(`inv:${invitation.id}`, () =>
                              api.revokeInvitation(invitation.id).then(() => undefined),
                            )
                          }
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      ) : null}
    </div>
  );
}

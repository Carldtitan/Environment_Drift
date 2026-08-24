import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { digestOf } from "@iwomc/contracts";
import type {
  AuditEvent,
  Device,
  DeviceState,
  EnvironmentContractV1,
  EnvironmentReceiptV1,
  Invitation,
  Membership,
  Person,
  Project,
  RescueOutcomeV1,
  RescueRequestV1,
  Workspace,
  WorkspaceRole,
} from "@iwomc/contracts";

/**
 * The control-plane store interface.
 *
 * Two implementations exist: a SQLite store that runs anywhere with no
 * credentials, and a Postgres store for a hosted deployment. Every read and
 * write is workspace-scoped by its arguments, so authorization cannot be
 * skipped by calling a different method.
 */

export interface JobRecord {
  readonly request: RescueRequestV1;
  readonly state: "queued" | "delivered" | "running" | "finished" | "expired" | "cancelled";
  readonly progress: readonly { at: string; state: string; message: string }[];
  readonly outcomeRunId: string | null;
}

export interface StoredTeamContract {
  readonly contract: EnvironmentContractV1;
  readonly receivedAt: string;
}

export interface ControlPlaneStore {
  readonly kind: "sqlite" | "postgres";
  close(): void;

  createWorkspace(workspace: Workspace): void;
  getWorkspace(id: string): Workspace | null;
  listWorkspacesForPerson(personId: string): Workspace[];

  upsertPerson(person: Person): void;
  getPerson(id: string): Person | null;

  addMembership(membership: Membership): void;
  getMembership(workspaceId: string, personId: string): Membership | null;
  listMemberships(workspaceId: string): (Membership & { person: Person })[];
  updateRole(workspaceId: string, personId: string, role: WorkspaceRole): void;
  removeMembership(workspaceId: string, personId: string): void;
  countOwners(workspaceId: string): number;

  createInvitation(invitation: Invitation): void;
  getInvitationByHash(tokenHash: string): Invitation | null;
  listInvitations(workspaceId: string): Invitation[];
  /** Atomic single-use acceptance: returns false when already accepted. */
  acceptInvitation(id: string, personId: string, at: string): boolean;
  revokeInvitation(workspaceId: string, id: string, at: string): void;

  createDevice(device: Device, credentialHash: string): void;
  getDeviceByCredential(credentialHash: string): Device | null;
  getDevice(id: string): Device | null;
  listDevices(workspaceId: string): Device[];
  setDeviceState(id: string, state: DeviceState, at: string): void;
  touchDevice(id: string, at: string): void;

  upsertProject(project: Project): void;
  getProject(id: string): Project | null;
  findProject(workspaceId: string, canonicalRemoteDigest: string, subdirectory: string): Project | null;
  listProjects(workspaceId: string): Project[];

  saveReceipt(workspaceId: string, receipt: EnvironmentReceiptV1): void;
  listReceipts(workspaceId: string, projectId: string, limit: number): EnvironmentReceiptV1[];

  saveContract(workspaceId: string, contract: EnvironmentContractV1, receivedAt: string): void;
  getContract(workspaceId: string, id: string): StoredTeamContract | null;
  listContracts(workspaceId: string, projectId: string, limit: number): StoredTeamContract[];
  findContractForCommit(workspaceId: string, projectId: string, commit: string): StoredTeamContract | null;

  saveRescueOutcome(workspaceId: string, outcome: RescueOutcomeV1): void;
  listRescueOutcomes(workspaceId: string, projectId: string | null, limit: number): RescueOutcomeV1[];

  createJob(workspaceId: string, job: JobRecord): void;
  listJobsForDevice(workspaceId: string, deviceId: string, now: string): JobRecord[];
  /** Mark queued or delivered jobs past their expiry as expired. */
  expireStaleJobs(now: string): number;
  listJobs(workspaceId: string, limit: number): JobRecord[];
  getJob(workspaceId: string, id: string): JobRecord | null;
  updateJob(workspaceId: string, id: string, update: Partial<Omit<JobRecord, "request">>): void;
  appendJobProgress(workspaceId: string, id: string, entry: { at: string; state: string; message: string }): void;

  appendAudit(event: Omit<AuditEvent, "digest" | "previousDigest">): AuditEvent;
  listAudit(workspaceId: string, limit: number): AuditEvent[];
  verifyAuditChain(workspaceId: string): { ok: boolean; brokenAt?: string };

  /** Session tokens for the hosted console. Only the hash is stored. */
  createSession(input: { tokenHash: string; personId: string; workspaceId: string; expiresAt: string }): void;
  getSession(tokenHash: string): { personId: string; workspaceId: string; expiresAt: string } | null;
  deleteSession(tokenHash: string): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, avatar_url TEXT
);
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id TEXT NOT NULL, person_id TEXT NOT NULL, role TEXT NOT NULL, joined_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, person_id)
);
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  accepted_at TEXT, accepted_by TEXT, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, workspace_id TEXT, person_id TEXT NOT NULL, display_name TEXT NOT NULL,
  public_key TEXT NOT NULL, state TEXT NOT NULL, enrolled_at TEXT NOT NULL, last_seen_at TEXT,
  revoked_at TEXT, platform_os TEXT NOT NULL, platform_arch TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
  canonical_remote_digest TEXT NOT NULL, subdirectory TEXT NOT NULL, created_at TEXT NOT NULL,
  default_proof_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_identity
  ON projects (workspace_id, canonical_remote_digest, subdirectory);
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL,
  payload TEXT NOT NULL, received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contracts_lookup ON contracts (workspace_id, project_id, commit_sha);
CREATE TABLE IF NOT EXISTS rescue_runs (
  run_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
  state TEXT NOT NULL, payload TEXT NOT NULL, ended_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, device_id TEXT NOT NULL, project_id TEXT NOT NULL,
  state TEXT NOT NULL, request TEXT NOT NULL, progress TEXT NOT NULL, outcome_run_id TEXT,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
-- Every enrolled device asks "anything for me?" on a timer, and the answer is
-- almost always no. Unindexed that question scans every job the team has ever
-- created, from every device, forever.
CREATE INDEX IF NOT EXISTS jobs_device_state ON jobs (workspace_id, device_id, state);
CREATE INDEX IF NOT EXISTS jobs_workspace_created ON jobs (workspace_id, created_at);
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY, workspace_id TEXT, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL,
  previous_digest TEXT, digest TEXT NOT NULL, seq INTEGER
);
-- Appending chains onto the newest row for the workspace and allocates the
-- next sequence. Unindexed, both are full scans, and this is the one table
-- every member of a team writes to on every action.
CREATE INDEX IF NOT EXISTS audit_seq ON audit (seq);
CREATE INDEX IF NOT EXISTS audit_workspace_seq ON audit (workspace_id, seq);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, person_id TEXT NOT NULL, workspace_id TEXT NOT NULL, expires_at TEXT NOT NULL
);
`;

export class SqliteControlPlaneStore implements ControlPlaneStore {
  readonly kind = "sqlite" as const;
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  // -- workspaces ---------------------------------------------------------

  createWorkspace(workspace: Workspace): void {
    this.#db
      .prepare("INSERT INTO workspaces (id, name, created_at, created_by) VALUES (?, ?, ?, ?)")
      .run(workspace.id, workspace.name, workspace.createdAt, workspace.createdBy);
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.#db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | Record<string, string>
      | undefined;
    return row
      ? { id: row["id"] as string, name: row["name"] as string, createdAt: row["created_at"] as string, createdBy: row["created_by"] as string }
      : null;
  }

  listWorkspacesForPerson(personId: string): Workspace[] {
    const rows = this.#db
      .prepare(
        `SELECT w.* FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
         WHERE m.person_id = ? ORDER BY w.created_at`,
      )
      .all(personId) as Record<string, string>[];
    return rows.map((row) => ({
      id: row["id"] as string,
      name: row["name"] as string,
      createdAt: row["created_at"] as string,
      createdBy: row["created_by"] as string,
    }));
  }

  // -- people and membership ---------------------------------------------

  upsertPerson(person: Person): void {
    this.#db
      .prepare(
        `INSERT INTO people (id, display_name, avatar_url) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, avatar_url = excluded.avatar_url`,
      )
      .run(person.id, person.displayName, person.avatarUrl ?? null);
  }

  getPerson(id: string): Person | null {
    const row = this.#db.prepare("SELECT * FROM people WHERE id = ?").get(id) as
      | Record<string, string | null>
      | undefined;
    return row
      ? {
          id: row["id"] as string,
          displayName: row["display_name"] as string,
          ...(row["avatar_url"] ? { avatarUrl: row["avatar_url"] as string } : {}),
        }
      : null;
  }

  addMembership(membership: Membership): void {
    this.#db
      .prepare(
        `INSERT INTO memberships (workspace_id, person_id, role, joined_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, person_id) DO UPDATE SET role = excluded.role`,
      )
      .run(membership.workspaceId, membership.personId, membership.role, membership.joinedAt);
  }

  getMembership(workspaceId: string, personId: string): Membership | null {
    const row = this.#db
      .prepare("SELECT * FROM memberships WHERE workspace_id = ? AND person_id = ?")
      .get(workspaceId, personId) as Record<string, string> | undefined;
    return row
      ? {
          workspaceId: row["workspace_id"] as string,
          personId: row["person_id"] as string,
          role: row["role"] as WorkspaceRole,
          joinedAt: row["joined_at"] as string,
        }
      : null;
  }

  listMemberships(workspaceId: string): (Membership & { person: Person })[] {
    const rows = this.#db
      .prepare(
        `SELECT m.*, p.display_name, p.avatar_url FROM memberships m
         LEFT JOIN people p ON p.id = m.person_id
         WHERE m.workspace_id = ? ORDER BY m.joined_at`,
      )
      .all(workspaceId) as Record<string, string | null>[];
    return rows.map((row) => ({
      workspaceId: row["workspace_id"] as string,
      personId: row["person_id"] as string,
      role: row["role"] as WorkspaceRole,
      joinedAt: row["joined_at"] as string,
      person: {
        id: row["person_id"] as string,
        displayName: (row["display_name"] as string | null) ?? (row["person_id"] as string),
        ...(row["avatar_url"] ? { avatarUrl: row["avatar_url"] as string } : {}),
      },
    }));
  }

  updateRole(workspaceId: string, personId: string, role: WorkspaceRole): void {
    this.#db
      .prepare("UPDATE memberships SET role = ? WHERE workspace_id = ? AND person_id = ?")
      .run(role, workspaceId, personId);
  }

  removeMembership(workspaceId: string, personId: string): void {
    this.#db
      .prepare("DELETE FROM memberships WHERE workspace_id = ? AND person_id = ?")
      .run(workspaceId, personId);
  }

  countOwners(workspaceId: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'owner'")
      .get(workspaceId) as { n: number };
    return Number(row.n);
  }

  // -- invitations --------------------------------------------------------

  createInvitation(invitation: Invitation): void {
    this.#db
      .prepare(
        `INSERT INTO invitations (id, workspace_id, role, token_hash, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        invitation.id,
        invitation.workspaceId,
        invitation.role,
        invitation.tokenHash,
        invitation.createdBy,
        invitation.createdAt,
        invitation.expiresAt,
      );
  }

  getInvitationByHash(tokenHash: string): Invitation | null {
    const row = this.#db.prepare("SELECT * FROM invitations WHERE token_hash = ?").get(tokenHash) as
      | Record<string, string | null>
      | undefined;
    return row ? rowToInvitation(row) : null;
  }

  listInvitations(workspaceId: string): Invitation[] {
    const rows = this.#db
      .prepare("SELECT * FROM invitations WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(workspaceId) as Record<string, string | null>[];
    return rows.map(rowToInvitation);
  }

  /**
   * Single use is enforced by the WHERE clause, not by a read-then-write, so
   * two simultaneous redemptions cannot both add a member (R2.2).
   */
  acceptInvitation(id: string, personId: string, at: string): boolean {
    const result = this.#db
      .prepare(
        `UPDATE invitations SET accepted_at = ?, accepted_by = ?
         WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
      )
      .run(at, personId, id);
    return Number(result.changes) === 1;
  }

  revokeInvitation(workspaceId: string, id: string, at: string): void {
    this.#db
      .prepare("UPDATE invitations SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL")
      .run(at, id, workspaceId);
  }

  // -- devices ------------------------------------------------------------

  createDevice(device: Device, credentialHash: string): void {
    this.#db
      .prepare(
        `INSERT INTO devices (id, workspace_id, person_id, display_name, public_key, state, enrolled_at, platform_os, platform_arch, credential_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        device.id,
        device.workspaceId,
        device.personId,
        device.displayName,
        device.publicKey,
        device.state,
        device.enrolledAt,
        device.platform.os,
        device.platform.arch,
        credentialHash,
      );
  }

  getDeviceByCredential(credentialHash: string): Device | null {
    const row = this.#db.prepare("SELECT * FROM devices WHERE credential_hash = ?").get(credentialHash) as
      | Record<string, string | null>
      | undefined;
    return row ? rowToDevice(row) : null;
  }

  getDevice(id: string): Device | null {
    const row = this.#db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as
      | Record<string, string | null>
      | undefined;
    return row ? rowToDevice(row) : null;
  }

  listDevices(workspaceId: string): Device[] {
    const rows = this.#db
      .prepare("SELECT * FROM devices WHERE workspace_id = ? ORDER BY enrolled_at DESC")
      .all(workspaceId) as Record<string, string | null>[];
    return rows.map(rowToDevice);
  }

  setDeviceState(id: string, state: DeviceState, at: string): void {
    this.#db
      .prepare("UPDATE devices SET state = ?, revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END WHERE id = ?")
      .run(state, state, at, id);
  }

  touchDevice(id: string, at: string): void {
    this.#db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(at, id);
  }

  // -- projects -----------------------------------------------------------

  upsertProject(project: Project): void {
    this.#db
      .prepare(
        `INSERT INTO projects (id, workspace_id, name, canonical_remote_digest, subdirectory, created_at, default_proof_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, default_proof_id = excluded.default_proof_id`,
      )
      .run(
        project.id,
        project.workspaceId,
        project.name,
        project.canonicalRemoteDigest,
        project.subdirectory,
        project.createdAt,
        project.defaultProofId ?? null,
      );
  }

  getProject(id: string): Project | null {
    const row = this.#db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | Record<string, string | null>
      | undefined;
    return row ? rowToProject(row) : null;
  }

  findProject(workspaceId: string, canonicalRemoteDigest: string, subdirectory: string): Project | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM projects WHERE workspace_id = ? AND canonical_remote_digest = ? AND subdirectory = ?",
      )
      .get(workspaceId, canonicalRemoteDigest, subdirectory) as Record<string, string | null> | undefined;
    return row ? rowToProject(row) : null;
  }

  listProjects(workspaceId: string): Project[] {
    const rows = this.#db
      .prepare("SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at")
      .all(workspaceId) as Record<string, string | null>[];
    return rows.map(rowToProject);
  }

  // -- receipts and contracts --------------------------------------------

  saveReceipt(workspaceId: string, receipt: EnvironmentReceiptV1): void {
    this.#db
      .prepare(
        `INSERT INTO receipts (id, workspace_id, project_id, commit_sha, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(receipt.id, workspaceId, receipt.projectId, receipt.source.commit, JSON.stringify(receipt), receipt.capturedAt);
  }

  listReceipts(workspaceId: string, projectId: string, limit: number): EnvironmentReceiptV1[] {
    const rows = this.#db
      .prepare(
        "SELECT payload FROM receipts WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(workspaceId, projectId, limit) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as EnvironmentReceiptV1);
  }

  saveContract(workspaceId: string, contract: EnvironmentContractV1, receivedAt: string): void {
    this.#db
      .prepare(
        `INSERT INTO contracts (id, workspace_id, project_id, commit_sha, digest, state, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET digest = excluded.digest, state = excluded.state, payload = excluded.payload`,
      )
      .run(
        contract.id,
        workspaceId,
        contract.projectId,
        contract.source.commit,
        contract.digest,
        contract.state,
        JSON.stringify(contract),
        receivedAt,
      );
  }

  getContract(workspaceId: string, id: string): StoredTeamContract | null {
    const row = this.#db
      .prepare("SELECT payload, received_at FROM contracts WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, id) as { payload: string; received_at: string } | undefined;
    return row
      ? { contract: JSON.parse(row.payload) as EnvironmentContractV1, receivedAt: row.received_at }
      : null;
  }

  listContracts(workspaceId: string, projectId: string, limit: number): StoredTeamContract[] {
    const rows = this.#db
      .prepare(
        "SELECT payload, received_at FROM contracts WHERE workspace_id = ? AND project_id = ? ORDER BY received_at DESC LIMIT ?",
      )
      .all(workspaceId, projectId, limit) as { payload: string; received_at: string }[];
    return rows.map((row) => ({
      contract: JSON.parse(row.payload) as EnvironmentContractV1,
      receivedAt: row.received_at,
    }));
  }

  findContractForCommit(workspaceId: string, projectId: string, commit: string): StoredTeamContract | null {
    const row = this.#db
      .prepare(
        `SELECT payload, received_at FROM contracts
         WHERE workspace_id = ? AND project_id = ? AND commit_sha = ?
         ORDER BY CASE state WHEN 'clean_verified' THEN 0 WHEN 'locally_checked' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
                  received_at DESC
         LIMIT 1`,
      )
      .get(workspaceId, projectId, commit) as { payload: string; received_at: string } | undefined;
    return row
      ? { contract: JSON.parse(row.payload) as EnvironmentContractV1, receivedAt: row.received_at }
      : null;
  }

  // -- rescue runs --------------------------------------------------------

  saveRescueOutcome(workspaceId: string, outcome: RescueOutcomeV1): void {
    this.#db
      .prepare(
        `INSERT INTO rescue_runs (run_id, workspace_id, project_id, state, payload, ended_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET state = excluded.state, payload = excluded.payload`,
      )
      .run(outcome.runId, workspaceId, outcome.projectId, outcome.state, JSON.stringify(outcome), outcome.endedAt);
  }

  listRescueOutcomes(workspaceId: string, projectId: string | null, limit: number): RescueOutcomeV1[] {
    const rows = projectId
      ? (this.#db
          .prepare(
            "SELECT payload FROM rescue_runs WHERE workspace_id = ? AND project_id = ? ORDER BY ended_at DESC LIMIT ?",
          )
          .all(workspaceId, projectId, limit) as { payload: string }[])
      : (this.#db
          .prepare("SELECT payload FROM rescue_runs WHERE workspace_id = ? ORDER BY ended_at DESC LIMIT ?")
          .all(workspaceId, limit) as { payload: string }[]);
    return rows.map((row) => JSON.parse(row.payload) as RescueOutcomeV1);
  }

  // -- jobs ---------------------------------------------------------------

  createJob(workspaceId: string, job: JobRecord): void {
    this.#db
      .prepare(
        `INSERT INTO jobs (id, workspace_id, device_id, project_id, state, request, progress, outcome_run_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.request.id,
        workspaceId,
        job.request.deviceId,
        job.request.projectId,
        job.state,
        JSON.stringify(job.request),
        JSON.stringify(job.progress),
        job.outcomeRunId,
        job.request.expiresAt,
        job.request.issuedAt,
      );
  }

  /**
   * Close out work that was never picked up.
   *
   * A device that is asleep, revoked, or simply switched off leaves its jobs
   * queued. Without this they sit in the table forever, are scanned by every
   * later poll, and show in the console as though they were still going to
   * happen. Marking them expired is the truthful outcome: nobody ran them.
   */
  expireStaleJobs(now: string): number {
    const result = this.#db
      .prepare(
        `UPDATE jobs SET state = 'expired'
         WHERE state IN ('queued', 'delivered') AND expires_at <= ?`,
      )
      .run(now);
    return Number(result.changes ?? 0);
  }

  listJobsForDevice(workspaceId: string, deviceId: string, now: string): JobRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM jobs WHERE workspace_id = ? AND device_id = ? AND state IN ('queued','delivered')
         AND expires_at > ? ORDER BY created_at`,
      )
      .all(workspaceId, deviceId, now) as Record<string, string | null>[];
    return rows.map(rowToJob);
  }

  listJobs(workspaceId: string, limit: number): JobRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(workspaceId, limit) as Record<string, string | null>[];
    return rows.map(rowToJob);
  }

  getJob(workspaceId: string, id: string): JobRecord | null {
    const row = this.#db.prepare("SELECT * FROM jobs WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as
      | Record<string, string | null>
      | undefined;
    return row ? rowToJob(row) : null;
  }

  updateJob(workspaceId: string, id: string, update: Partial<Omit<JobRecord, "request">>): void {
    const current = this.getJob(workspaceId, id);
    if (!current) return;
    this.#db
      .prepare("UPDATE jobs SET state = ?, progress = ?, outcome_run_id = ? WHERE workspace_id = ? AND id = ?")
      .run(
        update.state ?? current.state,
        JSON.stringify(update.progress ?? current.progress),
        update.outcomeRunId ?? current.outcomeRunId,
        workspaceId,
        id,
      );
  }

  appendJobProgress(workspaceId: string, id: string, entry: { at: string; state: string; message: string }): void {
    const current = this.getJob(workspaceId, id);
    if (!current) return;
    const progress = [...current.progress, entry].slice(-200);
    this.#db
      .prepare("UPDATE jobs SET progress = ?, state = ? WHERE workspace_id = ? AND id = ?")
      .run(JSON.stringify(progress), entry.state === "finished" ? "finished" : "running", workspaceId, id);
  }

  // -- audit --------------------------------------------------------------

  appendAudit(event: Omit<AuditEvent, "digest" | "previousDigest">): AuditEvent {
    const previous = this.#db
      .prepare("SELECT digest FROM audit WHERE COALESCE(workspace_id,'') = ? ORDER BY seq DESC LIMIT 1")
      .get(event.workspaceId ?? "") as { digest: string } | undefined;
    const previousDigest = previous?.digest ?? null;
    const digest = digestOf({ ...event, previousDigest });
    const full: AuditEvent = { ...event, previousDigest, digest };
    this.#db
      .prepare(
        `INSERT INTO audit (id, workspace_id, at, actor, action, subject, detail, previous_digest, digest, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq),0)+1 FROM audit))`,
      )
      .run(
        full.id,
        full.workspaceId,
        full.at,
        full.actor,
        full.action,
        full.subject,
        JSON.stringify(full.detail),
        full.previousDigest,
        full.digest,
      );
    return full;
  }

  listAudit(workspaceId: string, limit: number): AuditEvent[] {
    const rows = this.#db
      .prepare("SELECT * FROM audit WHERE COALESCE(workspace_id,'') = ? ORDER BY seq DESC LIMIT ?")
      .all(workspaceId, limit) as Record<string, string | null>[];
    return rows.map(rowToAudit);
  }

  verifyAuditChain(workspaceId: string): { ok: boolean; brokenAt?: string } {
    const rows = this.#db
      .prepare("SELECT * FROM audit WHERE COALESCE(workspace_id,'') = ? ORDER BY seq")
      .all(workspaceId) as Record<string, string | null>[];
    let previousDigest: string | null = null;
    for (const row of rows) {
      const event = rowToAudit(row);
      const expected = digestOf({
        id: event.id,
        workspaceId: event.workspaceId,
        at: event.at,
        actor: event.actor,
        action: event.action,
        subject: event.subject,
        detail: event.detail,
        previousDigest,
      });
      if (expected !== event.digest) return { ok: false, brokenAt: event.id };
      previousDigest = event.digest;
    }
    return { ok: true };
  }

  // -- sessions -----------------------------------------------------------

  createSession(input: { tokenHash: string; personId: string; workspaceId: string; expiresAt: string }): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (token_hash, person_id, workspace_id, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at`,
      )
      .run(input.tokenHash, input.personId, input.workspaceId, input.expiresAt);
  }

  getSession(tokenHash: string): { personId: string; workspaceId: string; expiresAt: string } | null {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as
      | Record<string, string>
      | undefined;
    return row
      ? {
          personId: row["person_id"] as string,
          workspaceId: row["workspace_id"] as string,
          expiresAt: row["expires_at"] as string,
        }
      : null;
  }

  deleteSession(tokenHash: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }
}

function rowToInvitation(row: Record<string, string | null>): Invitation {
  return {
    id: row["id"] as string,
    workspaceId: row["workspace_id"] as string,
    role: row["role"] as WorkspaceRole,
    tokenHash: row["token_hash"] as string,
    createdBy: row["created_by"] as string,
    createdAt: row["created_at"] as string,
    expiresAt: row["expires_at"] as string,
    ...(row["accepted_at"] ? { acceptedAt: row["accepted_at"] as string } : {}),
    ...(row["accepted_by"] ? { acceptedBy: row["accepted_by"] as string } : {}),
    ...(row["revoked_at"] ? { revokedAt: row["revoked_at"] as string } : {}),
  };
}

function rowToDevice(row: Record<string, string | null>): Device {
  return {
    id: row["id"] as string,
    workspaceId: (row["workspace_id"] as string | null) ?? null,
    personId: row["person_id"] as string,
    displayName: row["display_name"] as string,
    publicKey: row["public_key"] as string,
    state: row["state"] as DeviceState,
    enrolledAt: row["enrolled_at"] as string,
    ...(row["last_seen_at"] ? { lastSeenAt: row["last_seen_at"] as string } : {}),
    ...(row["revoked_at"] ? { revokedAt: row["revoked_at"] as string } : {}),
    platform: {
      os: row["platform_os"] as Device["platform"]["os"],
      arch: row["platform_arch"] as Device["platform"]["arch"],
    },
  };
}

function rowToProject(row: Record<string, string | null>): Project {
  return {
    id: row["id"] as string,
    workspaceId: row["workspace_id"] as string,
    name: row["name"] as string,
    canonicalRemoteDigest: row["canonical_remote_digest"] as string,
    subdirectory: row["subdirectory"] as string,
    createdAt: row["created_at"] as string,
    ...(row["default_proof_id"] ? { defaultProofId: row["default_proof_id"] as string } : {}),
  };
}

function rowToJob(row: Record<string, string | null>): JobRecord {
  return {
    request: JSON.parse(row["request"] as string) as RescueRequestV1,
    state: row["state"] as JobRecord["state"],
    progress: JSON.parse(row["progress"] as string) as JobRecord["progress"],
    outcomeRunId: (row["outcome_run_id"] as string | null) ?? null,
  };
}

function rowToAudit(row: Record<string, string | null>): AuditEvent {
  return {
    id: row["id"] as string,
    workspaceId: (row["workspace_id"] as string | null) ?? null,
    at: row["at"] as string,
    actor: row["actor"] as string,
    action: row["action"] as string,
    subject: row["subject"] as string,
    detail: JSON.parse(row["detail"] as string) as Record<string, unknown>,
    previousDigest: (row["previous_digest"] as string | null) ?? null,
    digest: row["digest"] as string,
  };
}

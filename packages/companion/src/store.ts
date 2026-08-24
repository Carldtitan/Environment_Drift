import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  deriveKey,
  digestOf,
  newLocalStoreKey,
  open as openSealed,
  seal,
  type SealedBlob,
} from "@iwomc/contracts";
import type {
  AuditEvent,
  ContractState,
  DriftFinding,
  EnvironmentContractV1,
  EnvironmentReceiptV1,
  InventoryBaselineV1,
  PackageEventV1,
  ProofCommand,
  RescueEvent,
  RescueOutcomeV1,
  RescueRunState,
  VerificationAttestationV1,
} from "@iwomc/contracts";
import { keyFilePath, storePath } from "./paths.js";

/**
 * The local Companion store (task 3.2).
 *
 * Rows that could carry sensitive or machine-identifying material - the device
 * private key, receipts, contracts, journals, and bounded logs - are sealed
 * with AES-256-GCM before they touch disk. The key lives in a 0600 file next to
 * the database and never leaves the machine.
 */

export interface ProjectBinding {
  readonly projectId: string;
  readonly workspaceId: string | null;
  readonly projectName: string;
  readonly canonicalRemoteDigest: string;
  readonly subdirectory: string;
  /** Absolute path of the local checkout. Never leaves the device. */
  readonly checkoutPath: string;
  readonly createdAt: string;
}

export interface StoredContract {
  readonly id: string;
  readonly projectId: string;
  readonly commit: string;
  readonly digest: string;
  readonly state: ContractState;
  readonly origin: "local" | "team";
  readonly contract: EnvironmentContractV1;
  readonly createdAt: string;
}

/**
 * One period during which the watcher was running.
 *
 * `endedAt` is null for a session that was never stopped: either it is running
 * now, or the process was killed. `lastSeenAt` separates those two cases,
 * which is what stops a crashed watcher from claiming coverage forever.
 */
export interface WatchSessionRecord {
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly sweepIntervalMs: number;
  readonly endedAt: string | null;
}

export interface StoredRun {
  readonly id: string;
  readonly projectId: string;
  readonly contractId: string;
  readonly commit: string;
  /** The directory this run worked in. Empty for runs recorded before it was tracked. */
  readonly checkoutPath?: string;
  readonly state: RescueRunState;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: RescueOutcomeV1 | null;
}

export interface JournalEntry {
  readonly runId: string;
  readonly seq: number;
  readonly at: string;
  readonly stepId: string;
  readonly idempotencyKey: string;
  readonly phase: "started" | "succeeded" | "failed" | "skipped";
  readonly detail: Record<string, unknown>;
}

export interface BudgetEntry {
  readonly id: string;
  readonly provider: string;
  readonly amountUsd: number;
  readonly at: string;
  readonly reference: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS device (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  private_key_sealed TEXT NOT NULL,
  state TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  platform_os TEXT NOT NULL,
  platform_arch TEXT NOT NULL,
  workspace_id TEXT
);

CREATE TABLE IF NOT EXISTS bindings (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT,
  project_name TEXT NOT NULL,
  canonical_remote_digest TEXT NOT NULL,
  subdirectory TEXT NOT NULL,
  checkout_path_sealed TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bindings_identity
  ON bindings (canonical_remote_digest, subdirectory, COALESCE(workspace_id, ''));

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  digest TEXT NOT NULL,
  payload_sealed TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_project ON receipts (project_id, commit_sha);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL,
  origin TEXT NOT NULL,
  payload_sealed TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contracts_project ON contracts (project_id, commit_sha);

CREATE TABLE IF NOT EXISTS proofs (
  project_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  -- Which directory the run actually worked in. A resume may only reuse work
  -- done in the same one: two checkouts of a project can exist side by side,
  -- and steps applied to one are not applied to the other.
  checkout_path TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome_sealed TEXT
);
CREATE INDEX IF NOT EXISTS runs_project ON runs (project_id, started_at);

CREATE TABLE IF NOT EXISTS journal (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  step_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  phase TEXT NOT NULL,
  detail_sealed TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS attestations (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_sealed TEXT NOT NULL,
  log_sealed TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attestations_contract ON attestations (contract_id);

CREATE TABLE IF NOT EXISTS drift (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  payload_sealed TEXT NOT NULL,
  detected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drift_project ON drift (project_id, commit_sha);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT NOT NULL,
  previous_digest TEXT,
  digest TEXT NOT NULL,
  seq INTEGER
);
-- Every append reads the newest row to chain onto it, and reads the highest
-- sequence to allocate the next one. Without this index both are full scans,
-- so writing n events costs O(n^2) - a team fills this table fast enough for
-- that to become the slowest thing IWOMC does.
CREATE INDEX IF NOT EXISTS audit_seq ON audit (seq);

CREATE TABLE IF NOT EXISTS package_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  commit_sha TEXT,
  name TEXT NOT NULL,
  manager TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_sealed TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS package_events_seq ON package_events (project_id, seq);
CREATE INDEX IF NOT EXISTS package_events_time ON package_events (project_id, at);
CREATE INDEX IF NOT EXISTS package_events_commit ON package_events (project_id, commit_sha);
CREATE INDEX IF NOT EXISTS package_events_name ON package_events (project_id, manager, name, seq);

CREATE TABLE IF NOT EXISTS inventory_baselines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  commit_sha TEXT,
  payload_sealed TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inventory_baselines_seq ON inventory_baselines (project_id, seq);

CREATE TABLE IF NOT EXISTS watch_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  -- Updated after every sweep. A watcher that is killed rather than stopped
  -- never writes ended_at, and without a heartbeat its session would claim
  -- coverage forever.
  last_seen_at TEXT NOT NULL,
  sweep_interval_ms INTEGER NOT NULL,
  -- The process doing the recording. Lets a dead recorder be replaced at once
  -- instead of after its heartbeat grace expires.
  recorder_pid INTEGER NOT NULL DEFAULT 0,
  ended_at TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS watch_sessions_project ON watch_sessions (project_id, started_at);

CREATE TABLE IF NOT EXISTS budget_ledger (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  at TEXT NOT NULL,
  reference TEXT NOT NULL
);
`;

function loadOrCreateKey(path: string): Buffer {
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) throw new Error(`${path} does not contain a 32-byte key`);
    return key;
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = newLocalStoreKey();
  writeFileSync(path, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file still inherits the user profile ACL.
  }
  return key;
}

/**
 * Columns added to a table after it first shipped.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing database, so a new
 * column has to be added explicitly or an upgraded IWOMC crashes on the store
 * it wrote yesterday. Each entry is idempotent: adding a column that is
 * already there is skipped, not an error.
 */
const ADDED_COLUMNS: readonly { table: string; column: string; definition: string }[] = [
  { table: "watch_sessions", column: "last_seen_at", definition: "TEXT NOT NULL DEFAULT ''" },
  { table: "watch_sessions", column: "sweep_interval_ms", definition: "INTEGER NOT NULL DEFAULT 45000" },
  { table: "watch_sessions", column: "recorder_pid", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "runs", column: "checkout_path", definition: "TEXT NOT NULL DEFAULT ''" },
];

function applyAdditiveMigrations(db: DatabaseSync): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.length === 0) continue;
    if (columns.some((existing) => existing.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Whether a process id is still running.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. `EPERM` means it exists but belongs to someone else, which for
 * this purpose counts as alive.
 */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /busy|locked/iu.test(message);
}

/**
 * Block for a few milliseconds without spinning the CPU.
 *
 * `node:sqlite` is synchronous, so there is no promise to await inside a
 * transaction retry. Atomics.wait on a throwaway buffer is the sanctioned way
 * to sleep a synchronous path.
 */
function sleepBriefly(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
}

export class CompanionStore {
  readonly #db: DatabaseSync;
  readonly #key: Buffer;
  readonly #path: string;

  private constructor(db: DatabaseSync, key: Buffer, path: string) {
    this.#db = db;
    this.#key = key;
    this.#path = path;
  }

  static openAt(databasePath: string, keyPath: string): CompanionStore {
    mkdirSync(dirname(databasePath), { recursive: true });
    const key = deriveKey(loadOrCreateKey(keyPath), "iwomc/companion-store/v1");
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    applyAdditiveMigrations(db);
    return new CompanionStore(db, key, databasePath);
  }

  static open(env: NodeJS.ProcessEnv = process.env): CompanionStore {
    return CompanionStore.openAt(storePath(env), keyFilePath(env));
  }

  get path(): string {
    return this.#path;
  }

  close(): void {
    this.#db.close();
  }

  #seal(value: unknown, aad: string): string {
    return JSON.stringify(seal(JSON.stringify(value), this.#key, aad));
  }

  #open<T>(text: string, aad: string): T {
    const blob = JSON.parse(text) as SealedBlob;
    return JSON.parse(openSealed(blob, this.#key, aad)) as T;
  }

  // -- meta ---------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // -- device -------------------------------------------------------------

  /**
   * A machine has exactly one device row. Enrollment replaces the local id with
   * the one the control plane issued, so the row is keyed on the public key -
   * the thing that actually identifies this machine - and any older row for the
   * same key is removed rather than left behind for `loadDevice` to pick up.
   */
  saveDevice(device: {
    id: string;
    personId: string;
    displayName: string;
    publicKey: string;
    privateKeyPem: string;
    state: string;
    enrolledAt: string;
    platformOs: string;
    platformArch: string;
    workspaceId: string | null;
  }): void {
    this.#db
      .prepare("DELETE FROM device WHERE public_key = ? AND id <> ?")
      .run(device.publicKey, device.id);
    this.#db
      .prepare(
        `INSERT INTO device (id, person_id, display_name, public_key, private_key_sealed, state, enrolled_at, platform_os, platform_arch, workspace_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           person_id = excluded.person_id,
           display_name = excluded.display_name,
           public_key = excluded.public_key,
           private_key_sealed = excluded.private_key_sealed,
           state = excluded.state,
           workspace_id = excluded.workspace_id`,
      )
      .run(
        device.id,
        device.personId,
        device.displayName,
        device.publicKey,
        this.#seal(device.privateKeyPem, `device:${device.id}`),
        device.state,
        device.enrolledAt,
        device.platformOs,
        device.platformArch,
        device.workspaceId,
      );
  }

  loadDevice(): {
    id: string;
    personId: string;
    displayName: string;
    publicKey: string;
    privateKeyPem: string;
    state: string;
    enrolledAt: string;
    platformOs: string;
    platformArch: string;
    workspaceId: string | null;
  } | null {
    const row = this.#db.prepare("SELECT * FROM device ORDER BY enrolled_at DESC LIMIT 1").get() as
      | Record<string, string | null>
      | undefined;
    if (!row) return null;
    const id = row["id"] as string;
    return {
      id,
      personId: row["person_id"] as string,
      displayName: row["display_name"] as string,
      publicKey: row["public_key"] as string,
      privateKeyPem: this.#open<string>(row["private_key_sealed"] as string, `device:${id}`),
      state: row["state"] as string,
      enrolledAt: row["enrolled_at"] as string,
      platformOs: row["platform_os"] as string,
      platformArch: row["platform_arch"] as string,
      workspaceId: (row["workspace_id"] as string | null) ?? null,
    };
  }

  // -- bindings -----------------------------------------------------------

  saveBinding(binding: ProjectBinding): void {
    this.#db
      .prepare(
        `INSERT INTO bindings (project_id, workspace_id, project_name, canonical_remote_digest, subdirectory, checkout_path_sealed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           project_name = excluded.project_name,
           canonical_remote_digest = excluded.canonical_remote_digest,
           subdirectory = excluded.subdirectory,
           checkout_path_sealed = excluded.checkout_path_sealed`,
      )
      .run(
        binding.projectId,
        binding.workspaceId,
        binding.projectName,
        binding.canonicalRemoteDigest,
        binding.subdirectory,
        this.#seal(binding.checkoutPath, `binding:${binding.projectId}`),
        binding.createdAt,
      );
  }

  #rowToBinding(row: Record<string, string | null>): ProjectBinding {
    const projectId = row["project_id"] as string;
    return {
      projectId,
      workspaceId: (row["workspace_id"] as string | null) ?? null,
      projectName: row["project_name"] as string,
      canonicalRemoteDigest: row["canonical_remote_digest"] as string,
      subdirectory: row["subdirectory"] as string,
      checkoutPath: this.#open<string>(row["checkout_path_sealed"] as string, `binding:${projectId}`),
      createdAt: row["created_at"] as string,
    };
  }

  listBindings(): ProjectBinding[] {
    const rows = this.#db.prepare("SELECT * FROM bindings ORDER BY created_at").all() as Record<
      string,
      string | null
    >[];
    return rows.map((row) => this.#rowToBinding(row));
  }

  findBindingById(projectId: string): ProjectBinding | null {
    const row = this.#db.prepare("SELECT * FROM bindings WHERE project_id = ?").get(projectId) as
      | Record<string, string | null>
      | undefined;
    return row ? this.#rowToBinding(row) : null;
  }

  /**
   * A checkout is identified by its remote fingerprint and subdirectory.
   *
   * When a workspace is given, its binding wins; otherwise a local-only binding
   * for the same checkout is returned. Without that fallback, joining a
   * workspace would make a device's existing projects vanish - they were bound
   * before there was a workspace to bind them to.
   */
  findBindingByIdentity(
    canonicalRemoteDigest: string,
    subdirectory: string,
    workspaceId: string | null,
  ): ProjectBinding | null {
    const rows = this.#db
      .prepare(
        `SELECT * FROM bindings
         WHERE canonical_remote_digest = ? AND subdirectory = ?
           AND (COALESCE(workspace_id, '') = ? OR workspace_id IS NULL)
         ORDER BY CASE WHEN COALESCE(workspace_id, '') = ? THEN 0 ELSE 1 END`,
      )
      .all(canonicalRemoteDigest, subdirectory, workspaceId ?? "", workspaceId ?? "") as Record<
      string,
      string | null
    >[];
    const row = rows[0];
    return row ? this.#rowToBinding(row) : null;
  }

  deleteBinding(projectId: string): void {
    this.#db.prepare("DELETE FROM bindings WHERE project_id = ?").run(projectId);
  }

  // -- receipts -----------------------------------------------------------

  saveReceipt(receipt: EnvironmentReceiptV1): void {
    this.#db
      .prepare(
        `INSERT INTO receipts (id, project_id, commit_sha, digest, payload_sealed, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        receipt.id,
        receipt.projectId,
        receipt.source.commit,
        receipt.digest,
        this.#seal(receipt, `receipt:${receipt.id}`),
        receipt.capturedAt,
      );
  }

  listReceipts(projectId: string, limit = 50): EnvironmentReceiptV1[] {
    const rows = this.#db
      .prepare("SELECT id, payload_sealed FROM receipts WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(projectId, limit) as { id: string; payload_sealed: string }[];
    return rows.map((row) => this.#open<EnvironmentReceiptV1>(row.payload_sealed, `receipt:${row.id}`));
  }

  getReceipt(id: string): EnvironmentReceiptV1 | null {
    const row = this.#db.prepare("SELECT id, payload_sealed FROM receipts WHERE id = ?").get(id) as
      | { id: string; payload_sealed: string }
      | undefined;
    return row ? this.#open<EnvironmentReceiptV1>(row.payload_sealed, `receipt:${row.id}`) : null;
  }

  // -- contracts ----------------------------------------------------------

  saveContract(contract: EnvironmentContractV1, origin: "local" | "team"): void {
    this.#db
      .prepare(
        `INSERT INTO contracts (id, project_id, commit_sha, digest, state, origin, payload_sealed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           digest = excluded.digest,
           state = excluded.state,
           origin = excluded.origin,
           payload_sealed = excluded.payload_sealed`,
      )
      .run(
        contract.id,
        contract.projectId,
        contract.source.commit,
        contract.digest,
        contract.state,
        origin,
        this.#seal(contract, `contract:${contract.id}`),
        contract.issuedAt,
      );
  }

  #rowToContract(row: Record<string, string>): StoredContract {
    return {
      id: row["id"] as string,
      projectId: row["project_id"] as string,
      commit: row["commit_sha"] as string,
      digest: row["digest"] as string,
      state: row["state"] as ContractState,
      origin: row["origin"] as "local" | "team",
      contract: this.#open<EnvironmentContractV1>(
        row["payload_sealed"] as string,
        `contract:${row["id"] as string}`,
      ),
      createdAt: row["created_at"] as string,
    };
  }

  getContract(id: string): StoredContract | null {
    const row = this.#db.prepare("SELECT * FROM contracts WHERE id = ?").get(id) as
      | Record<string, string>
      | undefined;
    return row ? this.#rowToContract(row) : null;
  }

  listContracts(projectId: string, limit = 100): StoredContract[] {
    const rows = this.#db
      .prepare("SELECT * FROM contracts WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(projectId, limit) as Record<string, string>[];
    return rows.map((row) => this.#rowToContract(row));
  }

  findContractsForCommit(projectId: string, commit: string): StoredContract[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM contracts WHERE project_id = ? AND commit_sha = ? ORDER BY created_at DESC",
      )
      .all(projectId, commit) as Record<string, string>[];
    return rows.map((row) => this.#rowToContract(row));
  }

  /**
   * Contracts for a commit under *any* project on this device.
   *
   * Two checkouts of the same code are the same IWOMC project only when they
   * share a Git remote. A clone of a local folder, or a fork with a different
   * origin, produces a different project fingerprint - and then "no contract
   * exists for this commit" is true but points at entirely the wrong problem.
   * This lets the caller name the real one.
   */
  findContractsForCommitAnywhere(commit: string): StoredContract[] {
    const rows = this.#db
      .prepare("SELECT * FROM contracts WHERE commit_sha = ? ORDER BY created_at DESC LIMIT 20")
      .all(commit) as Record<string, string>[];
    return rows.map((row) => this.#rowToContract(row));
  }

  // -- proof --------------------------------------------------------------

  saveProof(projectId: string, proof: ProofCommand, updatedAt: string): void {
    this.#db
      .prepare(
        `INSERT INTO proofs (project_id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(projectId, JSON.stringify(proof), updatedAt);
  }

  getProof(projectId: string): ProofCommand | null {
    const row = this.#db.prepare("SELECT payload FROM proofs WHERE project_id = ?").get(projectId) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as ProofCommand) : null;
  }

  // -- runs, journal, events ----------------------------------------------

  createRun(run: {
    id: string;
    projectId: string;
    contractId: string;
    commit: string;
    /** The directory the run works in, so a resume only reuses its own work. */
    checkoutPath?: string;
    state: RescueRunState;
    startedAt: string;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO runs (id, project_id, contract_id, commit_sha, checkout_path, state, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.projectId,
        run.contractId,
        run.commit,
        run.checkoutPath ?? "",
        run.state,
        run.startedAt,
      );
  }

  updateRunState(runId: string, state: RescueRunState): void {
    this.#db.prepare("UPDATE runs SET state = ? WHERE id = ?").run(state, runId);
  }

  finishRun(runId: string, outcome: RescueOutcomeV1): void {
    this.#db
      .prepare("UPDATE runs SET state = ?, ended_at = ?, outcome_sealed = ? WHERE id = ?")
      .run(outcome.state, outcome.endedAt, this.#seal(outcome, `outcome:${runId}`), runId);
  }

  #rowToRun(row: Record<string, string | null>): StoredRun {
    const id = row["id"] as string;
    const outcomeSealed = row["outcome_sealed"] as string | null;
    return {
      id,
      projectId: row["project_id"] as string,
      contractId: row["contract_id"] as string,
      commit: row["commit_sha"] as string,
      state: row["state"] as RescueRunState,
      startedAt: row["started_at"] as string,
      endedAt: (row["ended_at"] as string | null) ?? null,
      outcome: outcomeSealed ? this.#open<RescueOutcomeV1>(outcomeSealed, `outcome:${id}`) : null,
    };
  }

  getRun(runId: string): StoredRun | null {
    const row = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | Record<string, string | null>
      | undefined;
    return row ? this.#rowToRun(row) : null;
  }

  listRuns(projectId: string, limit = 50): StoredRun[] {
    const rows = this.#db
      .prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(projectId, limit) as Record<string, string | null>[];
    return rows.map((row) => this.#rowToRun(row));
  }

  listAllRuns(limit = 100): StoredRun[] {
    const rows = this.#db
      .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as Record<string, string | null>[];
    return rows.map((row) => this.#rowToRun(row));
  }

  appendJournal(entry: JournalEntry): void {
    this.#db
      .prepare(
        `INSERT INTO journal (run_id, seq, at, step_id, idempotency_key, phase, detail_sealed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.runId,
        entry.seq,
        entry.at,
        entry.stepId,
        entry.idempotencyKey,
        entry.phase,
        this.#seal(entry.detail, `journal:${entry.runId}`),
      );
  }

  readJournal(runId: string): JournalEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM journal WHERE run_id = ? ORDER BY seq")
      .all(runId) as Record<string, string | number>[];
    return rows.map((row) => ({
      runId: row["run_id"] as string,
      seq: row["seq"] as number,
      at: row["at"] as string,
      stepId: row["step_id"] as string,
      idempotencyKey: row["idempotency_key"] as string,
      phase: row["phase"] as JournalEntry["phase"],
      detail: this.#open<Record<string, unknown>>(row["detail_sealed"] as string, `journal:${runId}`),
    }));
  }

  /**
   * Idempotency keys already recorded as succeeded, so an interrupted rescue
   * can resume instead of repeating work (R7.4).
   *
   * Scoped to the directory as well as the project and contract. Two checkouts
   * of one project can sit side by side on a machine, and work applied to one
   * of them has plainly not been applied to the other - without this, the
   * second rescue skips every step and installs nothing.
   */
  completedIdempotencyKeys(projectId: string, contractId: string, checkoutPath: string): Set<string> {
    const rows = this.#db
      .prepare(
        `SELECT j.idempotency_key AS k FROM journal j
         JOIN runs r ON r.id = j.run_id
         WHERE r.project_id = ? AND r.contract_id = ? AND r.checkout_path = ?
           AND j.phase = 'succeeded'`,
      )
      .all(projectId, contractId, checkoutPath) as { k: string }[];
    return new Set(rows.map((row) => row.k));
  }

  appendEvent(event: RescueEvent): void {
    this.#db
      .prepare("INSERT INTO run_events (run_id, seq, payload) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .run(event.runId, event.seq, JSON.stringify(event));
  }

  readEvents(runId: string, afterSeq = -1): RescueEvent[] {
    const rows = this.#db
      .prepare("SELECT payload FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq")
      .all(runId, afterSeq) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as RescueEvent);
  }

  // -- attestations -------------------------------------------------------

  saveAttestation(attestation: VerificationAttestationV1, log: string): void {
    this.#db
      .prepare(
        `INSERT INTO attestations (id, contract_id, verifier, state, payload_sealed, log_sealed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, payload_sealed = excluded.payload_sealed, log_sealed = excluded.log_sealed`,
      )
      .run(
        attestation.id,
        attestation.contractId,
        attestation.verifier,
        attestation.state,
        this.#seal(attestation, `attestation:${attestation.id}`),
        this.#seal(log, `attestation-log:${attestation.id}`),
        attestation.startedAt,
      );
  }

  listAttestations(contractId: string): VerificationAttestationV1[] {
    const rows = this.#db
      .prepare("SELECT id, payload_sealed FROM attestations WHERE contract_id = ? ORDER BY created_at DESC")
      .all(contractId) as { id: string; payload_sealed: string }[];
    return rows.map((row) =>
      this.#open<VerificationAttestationV1>(row.payload_sealed, `attestation:${row.id}`),
    );
  }

  readAttestationLog(id: string): string | null {
    const row = this.#db.prepare("SELECT log_sealed FROM attestations WHERE id = ?").get(id) as
      | { log_sealed: string | null }
      | undefined;
    if (!row?.log_sealed) return null;
    return this.#open<string>(row.log_sealed, `attestation-log:${id}`);
  }

  // -- drift --------------------------------------------------------------

  saveDrift(findings: readonly DriftFinding[]): void {
    const statement = this.#db.prepare(
      `INSERT INTO drift (id, project_id, commit_sha, payload_sealed, detected_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_sealed = excluded.payload_sealed, detected_at = excluded.detected_at`,
    );
    for (const finding of findings) {
      statement.run(
        finding.id,
        finding.projectId,
        finding.commit,
        this.#seal(finding, `drift:${finding.id}`),
        finding.detectedAt,
      );
    }
  }

  listDrift(projectId: string, commit?: string): DriftFinding[] {
    const rows = commit
      ? (this.#db
          .prepare("SELECT id, payload_sealed FROM drift WHERE project_id = ? AND commit_sha = ? ORDER BY detected_at DESC")
          .all(projectId, commit) as { id: string; payload_sealed: string }[])
      : (this.#db
          .prepare("SELECT id, payload_sealed FROM drift WHERE project_id = ? ORDER BY detected_at DESC")
          .all(projectId) as { id: string; payload_sealed: string }[]);
    return rows.map((row) => this.#open<DriftFinding>(row.payload_sealed, `drift:${row.id}`));
  }

  // -- the package event log ----------------------------------------------


  /** The next sequence number for this project's log. */
  nextPackageEventSeq(projectId: string): number {
    const row = this.#db
      .prepare("SELECT COALESCE(MAX(seq), -1) AS last FROM package_events WHERE project_id = ?")
      .get(projectId) as { last: number };
    return Number(row.last) + 1;
  }

  /**
   * Append observed changes and return them as they were stored.
   *
   * The log is append-only: a correction is a new event, never an edit, so a
   * replay of the same range always agrees with itself.
   *
   * Sequence numbers are assigned *here*, inside a single immediate
   * transaction, not by the caller. A resident `iwomc watch` and an `iwomc
   * sweep` in another terminal are both normal, and if each picked its own
   * "next" number beforehand they would collide on the unique index and one
   * would crash. Event ids are content-addressed and independent of the
   * sequence, so the same observation arriving twice is skipped rather than
   * duplicated or renumbered.
   *
   * The caller's `seq` is used only as relative ordering within this batch.
   */
  appendPackageEvents(events: readonly PackageEventV1[]): PackageEventV1[] {
    if (events.length === 0) return [];
    const ordered = [...events].sort((left, right) => left.seq - right.seq);

    const insert = this.#db.prepare(
      `INSERT INTO package_events (id, project_id, seq, at, commit_sha, name, manager, kind, payload_sealed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const exists = this.#db.prepare("SELECT 1 AS present FROM package_events WHERE id = ?");

    const stored: PackageEventV1[] = [];
    this.#inTransaction(() => {
      stored.length = 0;
      let next = this.nextPackageEventSeq(ordered[0]?.projectId ?? "");
      for (const event of ordered) {
        if (exists.get(event.id) !== undefined) continue;
        const persisted: PackageEventV1 = { ...event, seq: next };
        next += 1;
        insert.run(
          persisted.id,
          persisted.projectId,
          persisted.seq,
          persisted.at,
          persisted.commit,
          persisted.name,
          persisted.manager,
          persisted.kind,
          this.#seal(persisted, `package-event:${persisted.id}`),
        );
        stored.push(persisted);
      }
    });
    return stored;
  }

  /**
   * Run a write inside one immediate transaction, retrying a busy database.
   *
   * Several IWOMC processes share one store file. SQLite in WAL mode allows
   * concurrent readers with one writer, so a second writer is told to wait
   * rather than being corrupted - but it is told by throwing, and a background
   * recorder that gave up on the first contended write would quietly lose
   * events.
   */
  #inTransaction<T>(work: () => T): T {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        this.#db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        sleepBriefly();
        continue;
      }
      try {
        const result = work();
        this.#db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          // The transaction was already rolled back by the failure itself.
        }
        if (isBusy(error) && Date.now() < deadline) {
          sleepBriefly();
          continue;
        }
        throw error;
      }
    }
  }

  listPackageEvents(
    projectId: string,
    options: { fromSeq?: number; toSeq?: number; limit?: number; name?: string } = {},
  ): PackageEventV1[] {
    const from = options.fromSeq ?? 0;
    const to = options.toSeq ?? Number.MAX_SAFE_INTEGER;
    const limit = options.limit ?? 5000;
    const rows = options.name
      ? (this.#db
          .prepare(
            `SELECT id, payload_sealed FROM package_events
             WHERE project_id = ? AND seq >= ? AND seq <= ? AND name = ?
             ORDER BY seq LIMIT ?`,
          )
          .all(projectId, from, to, options.name, limit) as { id: string; payload_sealed: string }[])
      : (this.#db
          .prepare(
            `SELECT id, payload_sealed FROM package_events
             WHERE project_id = ? AND seq >= ? AND seq <= ? ORDER BY seq LIMIT ?`,
          )
          .all(projectId, from, to, limit) as { id: string; payload_sealed: string }[]);
    return rows.map((row) => this.#open<PackageEventV1>(row.payload_sealed, `package-event:${row.id}`));
  }

  /**
   * Every change recorded while one revision was checked out, in order.
   *
   * This is what lets a capture pin the versions the machine actually had at
   * that revision, instead of only what happens to be on disk now.
   */
  listPackageEventsForCommit(projectId: string, commit: string): PackageEventV1[] {
    const rows = this.#db
      .prepare(
        `SELECT id, payload_sealed FROM package_events
         WHERE project_id = ? AND commit_sha = ? ORDER BY seq`,
      )
      .all(projectId, commit) as { id: string; payload_sealed: string }[];
    return rows.map((row) => this.#open<PackageEventV1>(row.payload_sealed, `package-event:${row.id}`));
  }

  countPackageEvents(projectId: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM package_events WHERE project_id = ?")
      .get(projectId) as { n: number };
    return Number(row.n);
  }

  saveInventoryBaseline(baseline: InventoryBaselineV1): void {
    this.#db
      .prepare(
        `INSERT INTO inventory_baselines (id, project_id, seq, at, commit_sha, payload_sealed)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        baseline.id,
        baseline.projectId,
        baseline.seq,
        baseline.at,
        baseline.commit,
        this.#seal(baseline, `baseline:${baseline.id}`),
      );
  }

  /** The newest baseline at or before a sequence number, if any. */
  baselineAtOrBefore(projectId: string, seq: number): InventoryBaselineV1 | null {
    const row = this.#db
      .prepare(
        `SELECT id, payload_sealed FROM inventory_baselines
         WHERE project_id = ? AND seq <= ? ORDER BY seq DESC, at DESC LIMIT 1`,
      )
      .get(projectId, seq) as { id: string; payload_sealed: string } | undefined;
    return row ? this.#open<InventoryBaselineV1>(row.payload_sealed, `baseline:${row.id}`) : null;
  }

  /**
   * Thin out old baselines.
   *
   * A baseline is a shortcut, not evidence: the events are the record, and a
   * fold from any earlier baseline plus the events after it produces exactly
   * the same answer. Dropping one costs a little replay time and no accuracy,
   * which is why this only ever touches baselines and never an event.
   *
   * Recent ones are kept in full because recent questions are the common ones.
   * Older days keep one apiece, and the oldest is always kept - it is the
   * anchor for every question about the beginning.
   *
   * Returns how many were removed.
   */
  pruneBaselines(projectId: string, now: string, keepFullDays = 7): number {
    const cutoff = Date.parse(now) - keepFullDays * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(cutoff)) return 0;

    return this.#inTransaction(() => {
      const rows = this.#db
        .prepare(
          "SELECT id, at, seq FROM inventory_baselines WHERE project_id = ? ORDER BY seq ASC, at ASC",
        )
        .all(projectId) as { id: string; at: string; seq: number }[];
      if (rows.length <= 2) return 0;

      const keepPerBucket = new Map<string, string>();
      const doomed: string[] = [];
      const nowMs = Date.parse(now);
      for (const [index, row] of rows.entries()) {
        const at = Date.parse(row.at);
        // Always keep the oldest and anything inside the recent window.
        if (index === 0 || !Number.isFinite(at) || at >= cutoff) continue;

        // Resolution falls off with age, the way anyone actually asks about
        // their own history: this week in detail, last month by day, older
        // than that by week.
        const ageDays = (nowMs - at) / (24 * 60 * 60 * 1000);
        const bucket =
          ageDays <= 30
            ? row.at.slice(0, 10)
            : `week-${Math.floor(at / (7 * 24 * 60 * 60 * 1000))}`;

        const previous = keepPerBucket.get(bucket);
        if (previous !== undefined) doomed.push(previous);
        keepPerBucket.set(bucket, row.id);
      }

      if (doomed.length === 0) return 0;
      const remove = this.#db.prepare("DELETE FROM inventory_baselines WHERE id = ?");
      for (const id of doomed) remove.run(id);
      return doomed.length;
    });
  }

  /** Rough on-disk size of the log, for `iwomc doctor`. */
  packageLogFootprint(projectId: string): {
    events: number;
    baselines: number;
    approximateBytes: number;
  } {
    const row = this.#db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM package_events WHERE project_id = ?) AS events,
           (SELECT COUNT(*) FROM inventory_baselines WHERE project_id = ?) AS baselines,
           (SELECT COALESCE(SUM(LENGTH(payload_sealed)), 0) FROM package_events WHERE project_id = ?) AS eventBytes,
           (SELECT COALESCE(SUM(LENGTH(payload_sealed)), 0) FROM inventory_baselines WHERE project_id = ?) AS baselineBytes`,
      )
      .get(projectId, projectId, projectId, projectId) as {
      events: number;
      baselines: number;
      eventBytes: number;
      baselineBytes: number;
    };
    return {
      events: Number(row.events),
      baselines: Number(row.baselines),
      approximateBytes: Number(row.eventBytes) + Number(row.baselineBytes),
    };
  }

  /**
   * The newest baseline recorded while a specific revision was checked out.
   *
   * Asking only whether the *latest* baseline happens to match would answer
   * "never observed" for a revision that was plainly observed, just not most
   * recently.
   */
  latestBaselineForCommit(projectId: string, commit: string): InventoryBaselineV1 | null {
    const row = this.#db
      .prepare(
        `SELECT id, payload_sealed FROM inventory_baselines
         WHERE project_id = ? AND commit_sha = ? ORDER BY seq DESC, at DESC LIMIT 1`,
      )
      .get(projectId, commit) as { id: string; payload_sealed: string } | undefined;
    return row ? this.#open<InventoryBaselineV1>(row.payload_sealed, `baseline:${row.id}`) : null;
  }

  /** Highest sequence number recorded at or before an instant. */
  seqAtTime(projectId: string, when: string): number {
    const row = this.#db
      .prepare(
        "SELECT COALESCE(MAX(seq), -1) AS last FROM package_events WHERE project_id = ? AND at <= ?",
      )
      .get(projectId, when) as { last: number };
    return Number(row.last);
  }

  /** Highest sequence number observed while a revision was checked out. */
  seqAtCommit(projectId: string, commit: string): number | null {
    const row = this.#db
      .prepare(
        "SELECT MAX(seq) AS last FROM package_events WHERE project_id = ? AND commit_sha = ?",
      )
      .get(projectId, commit) as { last: number | null };
    return row.last === null ? null : Number(row.last);
  }

  // -- watch coverage -----------------------------------------------------

  /**
   * Claim the right to record changes for one project on this device.
   *
   * Only one recorder per project may write. Two would each notice the same
   * real install from their own last reading and log it twice, at two slightly
   * different times, and the history would say a package changed twice when it
   * changed once. The lease is the watch session itself: it is held while the
   * session is open and its heartbeat is recent, and it is released when the
   * recorder stops or stops beating.
   */
  acquireRecorderLease(input: {
    sessionId: string;
    projectId: string;
    at: string;
    sweepIntervalMs: number;
  }): { acquired: boolean; heldBy?: { startedAt: string; lastSeenAt: string } } {
    return this.#inTransaction(() => {
      const now = Date.parse(input.at);
      const rows = this.#db
        .prepare(
          `SELECT id, started_at, last_seen_at, sweep_interval_ms, recorder_pid FROM watch_sessions
           WHERE project_id = ? AND ended_at IS NULL`,
        )
        .all(input.projectId) as {
        id: string;
        started_at: string;
        last_seen_at: string;
        sweep_interval_ms: number;
        recorder_pid: number;
      }[];

      for (const row of rows) {
        if (row.id === input.sessionId) continue;
        const lastSeen = Date.parse(row.last_seen_at);
        // Twice its own interval, floored at a minute: long enough that a slow
        // sweep does not look dead, short enough that a killed recorder frees
        // the project quickly.
        const grace = Math.max(Number(row.sweep_interval_ms) * 2, 60_000);
        const beatingRecently =
          Number.isFinite(lastSeen) && Number.isFinite(now) && now - lastSeen <= grace;

        // A recorder killed outright never writes `ended_at`, and with a long
        // interval its heartbeat grace could hold the project for many
        // minutes. Checking whether its process still exists releases it at
        // once. This can only ever release sooner: if the id has been reused by
        // an unrelated process the check says "alive" and the heartbeat rule
        // still applies.
        const alive = Number(row.recorder_pid) > 0 ? processExists(Number(row.recorder_pid)) : true;

        if (beatingRecently && alive) {
          return {
            acquired: false,
            heldBy: { startedAt: row.started_at, lastSeenAt: row.last_seen_at },
          };
        }
        // Close its session at its last heartbeat so it stops claiming
        // coverage for time nobody watched.
        this.#db
          .prepare("UPDATE watch_sessions SET ended_at = ?, reason = ? WHERE id = ?")
          .run(row.last_seen_at, alive ? "no heartbeat" : "recorder process ended", row.id);
      }

      this.#db
        .prepare(
          `INSERT INTO watch_sessions
             (id, project_id, started_at, last_seen_at, sweep_interval_ms, recorder_pid)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.sessionId,
          input.projectId,
          input.at,
          input.at,
          input.sweepIntervalMs,
          process.pid,
        );
      return { acquired: true };
    });
  }

  /** Record that the watcher was still alive at this instant. */
  touchWatchSession(id: string, at: string): void {
    this.#db.prepare("UPDATE watch_sessions SET last_seen_at = ? WHERE id = ?").run(at, id);
  }

  endWatchSession(id: string, endedAt: string, reason: string): void {
    this.#db
      .prepare("UPDATE watch_sessions SET ended_at = ?, reason = ? WHERE id = ?")
      .run(endedAt, reason, id);
  }

  /**
   * Periods the watcher was running. A fold across a period NOT listed here is
   * reconstructed from sweeps alone or not at all, and must say so rather than
   * implying the log is complete.
   */
  listWatchSessions(projectId: string): WatchSessionRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT started_at, last_seen_at, sweep_interval_ms, ended_at
         FROM watch_sessions WHERE project_id = ? ORDER BY started_at`,
      )
      .all(projectId) as {
      started_at: string;
      last_seen_at: string;
      sweep_interval_ms: number;
      ended_at: string | null;
    }[];
    return rows.map((row) => ({
      startedAt: row.started_at,
      lastSeenAt: row.last_seen_at,
      sweepIntervalMs: Number(row.sweep_interval_ms),
      endedAt: row.ended_at,
    }));
  }

  // -- audit --------------------------------------------------------------

  /**
   * Append-only, hash-chained audit log. `previousDigest` links each event to
   * the one before it so a deletion is detectable (R12.3, R12.5).
   */
  appendAudit(input: Omit<AuditEvent, "digest" | "previousDigest">): AuditEvent {
    const previous = this.#db
      .prepare("SELECT digest FROM audit ORDER BY seq DESC LIMIT 1")
      .get() as { digest: string } | undefined;
    const previousDigest = previous?.digest ?? null;
    const digest = digestOf({ ...input, previousDigest });
    const event: AuditEvent = { ...input, previousDigest, digest };
    this.#db
      .prepare(
        `INSERT INTO audit (id, workspace_id, at, actor, action, subject, detail, previous_digest, digest, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM audit))`,
      )
      .run(
        event.id,
        event.workspaceId,
        event.at,
        event.actor,
        event.action,
        event.subject,
        JSON.stringify(event.detail),
        event.previousDigest,
        event.digest,
      );
    return event;
  }

  listAudit(limit = 200): AuditEvent[] {
    const rows = this.#db
      .prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT ?")
      .all(limit) as Record<string, string | null>[];
    return rows.map((row) => ({
      id: row["id"] as string,
      workspaceId: (row["workspace_id"] as string | null) ?? null,
      at: row["at"] as string,
      actor: row["actor"] as string,
      action: row["action"] as string,
      subject: row["subject"] as string,
      detail: JSON.parse(row["detail"] as string) as Record<string, unknown>,
      previousDigest: (row["previous_digest"] as string | null) ?? null,
      digest: row["digest"] as string,
    }));
  }

  /** Recompute the chain and report the first entry that does not verify. */
  verifyAuditChain(): { ok: boolean; brokenAt?: string } {
    const rows = this.#db.prepare("SELECT * FROM audit ORDER BY seq").all() as Record<
      string,
      string | null
    >[];
    let previousDigest: string | null = null;
    for (const row of rows) {
      const expected = digestOf({
        id: row["id"],
        workspaceId: (row["workspace_id"] as string | null) ?? null,
        at: row["at"],
        actor: row["actor"],
        action: row["action"],
        subject: row["subject"],
        detail: JSON.parse(row["detail"] as string) as Record<string, unknown>,
        previousDigest,
      });
      if (expected !== row["digest"]) return { ok: false, brokenAt: row["id"] as string };
      previousDigest = row["digest"] as string;
    }
    return { ok: true };
  }

  // -- budget -------------------------------------------------------------

  recordSpend(entry: BudgetEntry): void {
    this.#db
      .prepare("INSERT INTO budget_ledger (id, provider, amount_usd, at, reference) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
      .run(entry.id, entry.provider, entry.amountUsd, entry.at, entry.reference);
  }

  totalSpend(provider: string): number {
    const row = this.#db
      .prepare("SELECT COALESCE(SUM(amount_usd), 0) AS total FROM budget_ledger WHERE provider = ?")
      .get(provider) as { total: number };
    return Number(row.total);
  }

  listSpend(provider: string, limit = 100): BudgetEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM budget_ledger WHERE provider = ? ORDER BY at DESC LIMIT ?")
      .all(provider, limit) as Record<string, string | number>[];
    return rows.map((row) => ({
      id: row["id"] as string,
      provider: row["provider"] as string,
      amountUsd: Number(row["amount_usd"]),
      at: row["at"] as string,
      reference: row["reference"] as string,
    }));
  }
}

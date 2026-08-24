import { randomUUID } from "node:crypto";
import {
  blocked,
  digestOf,
  hashToken,
  parseContract,
  parseReceipt,
  parseRescueOutcome,
  randomId,
  roleAtLeast,
  signContract,
  verifyPayload,
  type Device,
  type EnvironmentContractV1,
  type EnvironmentReceiptV1,
  type Invitation,
  type KeyPair,
  type PlatformTarget,
  type RescueOutcomeV1,
  type RescueRequestV1,
  type WorkspaceRole,
  signPayload,
} from "@iwomc/contracts";
import type { ControlPlaneStore, JobRecord } from "./store.js";

/**
 * Control-plane domain logic (R1, R2, R12).
 *
 * Authorization is explicit at every entry point: a caller presents either a
 * console session or a device credential, and the resulting principal is
 * checked against the workspace and required role before anything is read or
 * written. Every mutation appends an audit event.
 */

export class ForbiddenError extends Error {
  readonly status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = "ForbiddenError";
    this.status = status;
  }
}

export interface PersonPrincipal {
  readonly kind: "person";
  readonly personId: string;
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
}

export interface DevicePrincipal {
  readonly kind: "device";
  readonly device: Device;
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
}

export type Principal = PersonPrincipal | DevicePrincipal;

export interface ServiceOptions {
  readonly store: ControlPlaneStore;
  /** The service signing key. Shareable contracts are signed with it. */
  readonly signingKey: KeyPair;
  readonly now?: () => string;
  readonly invitationTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly jobTtlMs?: number;
}

export class ControlPlaneService {
  readonly store: ControlPlaneStore;
  readonly #signingKey: KeyPair;
  readonly #now: () => string;
  readonly #invitationTtlMs: number;
  readonly #sessionTtlMs: number;
  readonly #jobTtlMs: number;

  constructor(options: ServiceOptions) {
    this.store = options.store;
    this.#signingKey = options.signingKey;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#invitationTtlMs = options.invitationTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.#sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.#jobTtlMs = options.jobTtlMs ?? 15 * 60 * 1000;
  }

  get servicePublicKey(): string {
    return this.#signingKey.publicKey;
  }

  // -- authentication -----------------------------------------------------

  authenticateSession(token: string | null): PersonPrincipal | null {
    if (!token) return null;
    const session = this.store.getSession(hashToken(token));
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= Date.parse(this.#now())) {
      this.store.deleteSession(hashToken(token));
      return null;
    }
    const membership = this.store.getMembership(session.workspaceId, session.personId);
    if (!membership) return null;
    return {
      kind: "person",
      personId: session.personId,
      workspaceId: session.workspaceId,
      role: membership.role,
    };
  }

  authenticateDevice(token: string | null): DevicePrincipal | null {
    if (!token) return null;
    const device = this.store.getDeviceByCredential(hashToken(token));
    if (!device) return null;
    if (device.state === "revoked") {
      throw new ForbiddenError("This device has been revoked.", 401);
    }
    if (device.workspaceId === null) {
      throw new ForbiddenError("This device is not attached to a workspace.", 403);
    }
    const membership = this.store.getMembership(device.workspaceId, device.personId);
    if (!membership) {
      throw new ForbiddenError("The person who enrolled this device is no longer a member.", 403);
    }
    this.store.touchDevice(device.id, this.#now());
    return { kind: "device", device, workspaceId: device.workspaceId, role: membership.role };
  }

  require(principal: Principal | null, workspaceId: string, role: WorkspaceRole): Principal {
    if (!principal) throw new ForbiddenError("Authentication is required.", 401);
    if (principal.workspaceId !== workspaceId) {
      throw new ForbiddenError("That workspace is not visible to this principal.");
    }
    if (!roleAtLeast(principal.role, role)) {
      throw new ForbiddenError(`This action requires the ${role} role or higher.`);
    }
    return principal;
  }

  // -- workspace and people ----------------------------------------------

  createWorkspace(input: { name: string; person: { id: string; displayName: string } }): {
    workspaceId: string;
  } {
    const at = this.#now();
    const workspaceId = randomUUID();
    this.store.upsertPerson({ id: input.person.id, displayName: input.person.displayName });
    this.store.createWorkspace({ id: workspaceId, name: input.name, createdAt: at, createdBy: input.person.id });
    this.store.addMembership({ workspaceId, personId: input.person.id, role: "owner", joinedAt: at });
    this.#audit(workspaceId, input.person.id, "workspace.created", `workspace:${workspaceId}`, {
      name: input.name,
    });
    return { workspaceId };
  }

  createSession(input: { personId: string; workspaceId: string }): { token: string; expiresAt: string } {
    const token = randomId(32);
    const expiresAt = new Date(Date.parse(this.#now()) + this.#sessionTtlMs).toISOString();
    this.store.createSession({
      tokenHash: hashToken(token),
      personId: input.personId,
      workspaceId: input.workspaceId,
      expiresAt,
    });
    return { token, expiresAt };
  }

  listMembers(principal: Principal, workspaceId: string) {
    this.require(principal, workspaceId, "observer");
    return this.store.listMemberships(workspaceId);
  }

  changeRole(principal: Principal, workspaceId: string, personId: string, role: WorkspaceRole): void {
    this.require(principal, workspaceId, "owner");
    const membership = this.store.getMembership(workspaceId, personId);
    if (!membership) throw new ForbiddenError("That person is not a member of this workspace.", 404);
    if (membership.role === "owner" && role !== "owner" && this.store.countOwners(workspaceId) <= 1) {
      throw new ForbiddenError("A workspace must keep at least one owner.");
    }
    this.store.updateRole(workspaceId, personId, role);
    this.#audit(workspaceId, actorOf(principal), "membership.role_changed", `person:${personId}`, { role });
  }

  removeMember(principal: Principal, workspaceId: string, personId: string): void {
    this.require(principal, workspaceId, "owner");
    const membership = this.store.getMembership(workspaceId, personId);
    if (!membership) throw new ForbiddenError("That person is not a member of this workspace.", 404);
    if (membership.role === "owner" && this.store.countOwners(workspaceId) <= 1) {
      throw new ForbiddenError("A workspace must keep at least one owner.");
    }
    this.store.removeMembership(workspaceId, personId);
    for (const device of this.store.listDevices(workspaceId)) {
      if (device.personId === personId && device.state !== "revoked") {
        this.store.setDeviceState(device.id, "revoked", this.#now());
      }
    }
    this.#audit(workspaceId, actorOf(principal), "membership.removed", `person:${personId}`, {});
  }

  // -- invitations --------------------------------------------------------

  createInvitation(principal: Principal, workspaceId: string, role: WorkspaceRole): {
    invitation: Invitation;
    token: string;
  } {
    this.require(principal, workspaceId, "maintainer");
    if (role === "owner" && principal.role !== "owner") {
      throw new ForbiddenError("Only an owner can invite another owner.");
    }
    const at = this.#now();
    const token = randomId(24);
    const invitation: Invitation = {
      id: randomUUID(),
      workspaceId,
      role,
      tokenHash: hashToken(token),
      createdBy: actorOf(principal),
      createdAt: at,
      expiresAt: new Date(Date.parse(at) + this.#invitationTtlMs).toISOString(),
    };
    this.store.createInvitation(invitation);
    this.#audit(workspaceId, actorOf(principal), "invitation.created", `invitation:${invitation.id}`, {
      role,
      expiresAt: invitation.expiresAt,
    });
    // The raw token is returned once and never stored.
    return { invitation, token };
  }

  listInvitations(principal: Principal, workspaceId: string): Invitation[] {
    this.require(principal, workspaceId, "maintainer");
    return this.store.listInvitations(workspaceId);
  }

  revokeInvitation(principal: Principal, workspaceId: string, id: string): void {
    this.require(principal, workspaceId, "maintainer");
    this.store.revokeInvitation(workspaceId, id, this.#now());
    this.#audit(workspaceId, actorOf(principal), "invitation.revoked", `invitation:${id}`, {});
  }

  /** Redeem an invitation and enroll a device in one atomic step. */
  enrollDevice(input: {
    invitationToken: string;
    publicKey: string;
    displayName: string;
    platform: PlatformTarget;
    personId?: string;
    personDisplayName?: string;
  }): { deviceId: string; deviceToken: string; workspaceId: string; personId: string; role: WorkspaceRole } {
    const at = this.#now();
    const invitation = this.store.getInvitationByHash(hashToken(input.invitationToken));
    if (!invitation) throw new ForbiddenError("That invitation is not valid.", 401);
    if (invitation.revokedAt) throw new ForbiddenError("That invitation was revoked.", 401);
    if (invitation.acceptedAt) throw new ForbiddenError("That invitation has already been used.", 401);
    if (Date.parse(invitation.expiresAt) <= Date.parse(at)) {
      throw new ForbiddenError("That invitation has expired.", 401);
    }

    const personId = input.personId ?? `device-owner:${digestOf({ publicKey: input.publicKey }).slice(7, 27)}`;
    if (!this.store.acceptInvitation(invitation.id, personId, at)) {
      // Another request redeemed it first; single use is enforced in the store.
      throw new ForbiddenError("That invitation has already been used.", 409);
    }

    this.store.upsertPerson({
      id: personId,
      displayName: input.personDisplayName ?? input.displayName,
    });
    this.store.addMembership({
      workspaceId: invitation.workspaceId,
      personId,
      role: invitation.role,
      joinedAt: at,
    });

    const deviceId = randomUUID();
    const deviceToken = randomId(32);
    const device: Device = {
      id: deviceId,
      workspaceId: invitation.workspaceId,
      personId,
      displayName: input.displayName,
      publicKey: input.publicKey,
      state: "active",
      enrolledAt: at,
      platform: input.platform,
    };
    this.store.createDevice(device, hashToken(deviceToken));
    this.#audit(invitation.workspaceId, personId, "device.enrolled", `device:${deviceId}`, {
      platform: `${input.platform.os}/${input.platform.arch}`,
      role: invitation.role,
    });

    return {
      deviceId,
      deviceToken,
      workspaceId: invitation.workspaceId,
      personId,
      role: invitation.role,
    };
  }

  listDevices(principal: Principal, workspaceId: string): Device[] {
    this.require(principal, workspaceId, "observer");
    return this.store.listDevices(workspaceId);
  }

  revokeDevice(principal: Principal, workspaceId: string, deviceId: string): void {
    this.require(principal, workspaceId, "maintainer");
    const device = this.store.getDevice(deviceId);
    if (!device || device.workspaceId !== workspaceId) {
      throw new ForbiddenError("That device is not in this workspace.", 404);
    }
    this.store.setDeviceState(deviceId, "revoked", this.#now());
    this.#audit(workspaceId, actorOf(principal), "device.revoked", `device:${deviceId}`, {});
  }

  // -- projects -----------------------------------------------------------

  bindProject(
    principal: DevicePrincipal,
    input: { projectId: string | null; projectName: string; canonicalRemoteDigest: string; subdirectory: string },
  ): { projectId: string } {
    this.require(principal, principal.workspaceId, "developer");
    const existing = this.store.findProject(
      principal.workspaceId,
      input.canonicalRemoteDigest,
      input.subdirectory,
    );
    if (existing) return { projectId: existing.id };

    const at = this.#now();
    const projectId = input.projectId ?? randomUUID();
    this.store.upsertProject({
      id: projectId,
      workspaceId: principal.workspaceId,
      name: input.projectName,
      canonicalRemoteDigest: input.canonicalRemoteDigest,
      subdirectory: input.subdirectory,
      createdAt: at,
    });
    this.#audit(principal.workspaceId, principal.device.personId, "project.registered", `project:${projectId}`, {
      canonicalRemoteDigest: input.canonicalRemoteDigest,
      subdirectory: input.subdirectory,
    });
    return { projectId };
  }

  listProjects(principal: Principal, workspaceId: string) {
    this.require(principal, workspaceId, "observer");
    return this.store.listProjects(workspaceId);
  }

  // -- receipts and contracts --------------------------------------------

  publishReceipt(principal: DevicePrincipal, raw: unknown): { accepted: boolean } {
    const receipt: EnvironmentReceiptV1 = parseReceipt(raw);
    this.require(principal, principal.workspaceId, "developer");
    this.#assertProjectInWorkspace(principal.workspaceId, receipt.projectId);
    if (receipt.deviceId !== principal.device.id) {
      throw new ForbiddenError("A receipt must be published by the device that captured it.");
    }
    this.store.saveReceipt(principal.workspaceId, receipt);
    this.#audit(principal.workspaceId, principal.device.personId, "receipt.published", `receipt:${receipt.id}`, {
      commit: receipt.source.commit,
    });
    return { accepted: true };
  }

  /**
   * Accept a device-signed contract, validate policy, then re-sign it as a
   * shareable team baseline. A dirty-worktree capture is refused here (R5.6).
   */
  publishContract(principal: DevicePrincipal, raw: unknown): { contract: EnvironmentContractV1 } {
    const candidate = parseContract(raw);
    this.require(principal, principal.workspaceId, "developer");
    this.#assertProjectInWorkspace(principal.workspaceId, candidate.projectId);

    if (!candidate.signature) {
      throw new ForbiddenError("A contract must be signed by the device that authored it.");
    }
    if (candidate.signature.publicKey !== principal.device.publicKey) {
      throw new ForbiddenError("The contract was not signed by the publishing device's key.");
    }
    if (!verifyPayload({ digest: candidate.digest, id: candidate.id }, candidate.signature)) {
      throw new ForbiddenError("The contract signature does not verify.");
    }
    if (candidate.source.worktreeDirty) {
      throw new ForbiddenError(
        "A capture from a dirty worktree stays local-only. Commit or stash the changes and capture again.",
      );
    }
    if (candidate.support === "observe_only") {
      throw new ForbiddenError("An observe-only contract cannot become a team baseline.");
    }

    const at = this.#now();
    // A candidate becomes approved on publication; a contract that already
    // carries a verification state keeps it. Either way the workspace is
    // stamped in, so the content is re-addressed and re-signed by the service.
    const state = candidate.state === "candidate" ? "approved" : candidate.state;
    const { digest: _oldDigest, signature: _oldSignature, ...content } = candidate;
    void _oldDigest;
    void _oldSignature;
    const rebased = { ...content, workspaceId: principal.workspaceId, state };
    const resealed = parseContract({ ...rebased, digest: digestOf(rebased) });
    const signed = signContract(resealed, this.#signingKey, "service", at);
    this.store.saveContract(principal.workspaceId, signed, at);
    this.#audit(principal.workspaceId, principal.device.personId, "contract.published", `contract:${signed.id}`, {
      digest: signed.digest,
      commit: signed.source.commit,
      support: signed.support,
    });
    return { contract: signed };
  }

  resolveContract(
    principal: DevicePrincipal,
    input: { projectId: string; commit: string },
  ): { exact: EnvironmentContractV1 | null; nearest: EnvironmentContractV1 | null } {
    this.require(principal, principal.workspaceId, "developer");
    this.#assertProjectInWorkspace(principal.workspaceId, input.projectId);
    const exact = this.store.findContractForCommit(principal.workspaceId, input.projectId, input.commit);
    if (exact) return { exact: exact.contract, nearest: null };
    const recent = this.store.listContracts(principal.workspaceId, input.projectId, 1);
    return { exact: null, nearest: recent[0]?.contract ?? null };
  }

  listContracts(principal: Principal, workspaceId: string, projectId: string) {
    this.require(principal, workspaceId, "observer");
    return this.store.listContracts(workspaceId, projectId, 100);
  }

  publishRescueOutcome(principal: DevicePrincipal, raw: unknown): { accepted: boolean } {
    const outcome: RescueOutcomeV1 = parseRescueOutcome(raw);
    this.require(principal, principal.workspaceId, "developer");
    this.#assertProjectInWorkspace(principal.workspaceId, outcome.projectId);
    if (outcome.deviceId !== principal.device.id) {
      throw new ForbiddenError("A rescue outcome must be reported by the device that ran it.");
    }
    if (!outcome.signature || !verifyPayload(stripSignature(outcome), outcome.signature)) {
      throw new ForbiddenError("The rescue outcome signature does not verify.");
    }
    this.store.saveRescueOutcome(principal.workspaceId, outcome);
    this.#audit(principal.workspaceId, principal.device.personId, "rescue.reported", `run:${outcome.runId}`, {
      state: outcome.state,
      commit: outcome.commit,
    });
    return { accepted: true };
  }

  listRescueOutcomes(principal: Principal, workspaceId: string, projectId: string | null) {
    this.require(principal, workspaceId, "observer");
    return this.store.listRescueOutcomes(workspaceId, projectId, 50);
  }

  // -- device jobs --------------------------------------------------------

  /**
   * The console asks a device to do something. The request carries workspace,
   * project, action, expiry, and a service signature - never a local path.
   */
  createJob(
    principal: Principal,
    input: { workspaceId: string; projectId: string; deviceId: string; action: RescueRequestV1["action"]; contractId?: string },
  ): RescueRequestV1 {
    this.require(principal, input.workspaceId, "developer");
    this.#assertProjectInWorkspace(input.workspaceId, input.projectId);
    const device = this.store.getDevice(input.deviceId);
    if (!device || device.workspaceId !== input.workspaceId) {
      throw new ForbiddenError("That device is not in this workspace.", 404);
    }
    if (device.state === "revoked") {
      throw new ForbiddenError("A revoked device cannot receive jobs.");
    }

    const issuedAt = this.#now();
    const body = {
      schemaVersion: 1 as const,
      id: randomUUID(),
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      deviceId: input.deviceId,
      action: input.action,
      ...(input.contractId ? { contractId: input.contractId } : {}),
      requestedBy: actorOf(principal),
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + this.#jobTtlMs).toISOString(),
      idempotencyKey: digestOf({ input, issuedAt }).slice(7, 39),
    };
    const request: RescueRequestV1 = {
      ...body,
      signature: signPayload(body, this.#signingKey, "service", issuedAt),
    };
    this.store.createJob(input.workspaceId, {
      request,
      state: "queued",
      progress: [],
      outcomeRunId: null,
    });
    this.#audit(input.workspaceId, actorOf(principal), `job.${input.action}_requested`, `job:${request.id}`, {
      projectId: input.projectId,
      deviceId: input.deviceId,
    });
    return request;
  }

  pollJobs(principal: DevicePrincipal): RescueRequestV1[] {
    this.require(principal, principal.workspaceId, "developer");
    const now = this.#now();
    // Devices poll continuously, which makes this the natural place to retire
    // work nobody collected. A job whose device never came back should read as
    // expired, not as still pending.
    this.store.expireStaleJobs(now);
    const jobs = this.store.listJobsForDevice(principal.workspaceId, principal.device.id, now);
    for (const job of jobs) {
      if (job.state === "queued") {
        this.store.updateJob(principal.workspaceId, job.request.id, { state: "delivered" });
      }
    }
    return jobs.map((job) => job.request);
  }

  reportJobProgress(principal: DevicePrincipal, jobId: string, state: string, message: string): void {
    this.require(principal, principal.workspaceId, "developer");
    const job = this.store.getJob(principal.workspaceId, jobId);
    if (!job) throw new ForbiddenError("That job does not exist in this workspace.", 404);
    if (job.request.deviceId !== principal.device.id) {
      throw new ForbiddenError("That job is addressed to another device.");
    }
    this.store.appendJobProgress(principal.workspaceId, jobId, { at: this.#now(), state, message });
  }

  listJobs(principal: Principal, workspaceId: string): JobRecord[] {
    this.require(principal, workspaceId, "observer");
    return this.store.listJobs(workspaceId, 50);
  }

  // -- audit --------------------------------------------------------------

  listAudit(principal: Principal, workspaceId: string) {
    this.require(principal, workspaceId, "reviewer");
    return this.store.listAudit(workspaceId, 200);
  }

  verifyAuditChain(principal: Principal, workspaceId: string) {
    this.require(principal, workspaceId, "reviewer");
    return this.store.verifyAuditChain(workspaceId);
  }

  // -- internals ----------------------------------------------------------

  #assertProjectInWorkspace(workspaceId: string, projectId: string): void {
    const project = this.store.getProject(projectId);
    if (!project || project.workspaceId !== workspaceId) {
      blocked(
        "workspace_forbidden",
        `Project ${projectId} is not registered in this workspace.`,
        "Run `iwomc init` in the checkout to register the project, then try again.",
      );
    }
  }

  #audit(
    workspaceId: string | null,
    actor: string,
    action: string,
    subject: string,
    detail: Record<string, unknown>,
  ): void {
    this.store.appendAudit({
      id: randomUUID(),
      workspaceId,
      at: this.#now(),
      actor,
      action,
      subject,
      detail,
    });
  }
}

function actorOf(principal: Principal): string {
  return principal.kind === "person" ? principal.personId : principal.device.personId;
}

function stripSignature(outcome: RescueOutcomeV1): Record<string, unknown> {
  const { signature: _signature, ...rest } = outcome;
  void _signature;
  return rest as unknown as Record<string, unknown>;
}

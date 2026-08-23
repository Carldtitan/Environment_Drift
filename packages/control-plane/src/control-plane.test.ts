import { beforeEach, describe, expect, it } from "vitest";
import {
  generateDeviceKeyPair,
  hashToken,
  sealContract,
  signContract,
  signPayload,
  type EnvironmentContractV1,
  type RescueOutcomeV1,
} from "@iwomc/contracts";
import { SqliteControlPlaneStore } from "./store.js";
import { ControlPlaneService, ForbiddenError } from "./service.js";
import { readPostgresConfig, validatePostgresConfig, createPostgresStore, PostgresUnavailableError } from "./postgres.js";

/**
 * Control-plane tests (task 6.1-6.4).
 *
 * Every one of these is an authorization question: can this principal see or
 * change this thing? The answers must not depend on the caller being polite.
 */

const NOW = "2026-08-23T05:00:00.000Z";
const DIGEST = `sha256:${"c".repeat(64)}`;

let store: SqliteControlPlaneStore;
let service: ControlPlaneService;
let serviceKey: ReturnType<typeof generateDeviceKeyPair>;

beforeEach(() => {
  store = new SqliteControlPlaneStore(":memory:");
  serviceKey = generateDeviceKeyPair();
  service = new ControlPlaneService({ store, signingKey: serviceKey });
});

function owner(name = "Ada") {
  const created = service.createWorkspace({ name: `${name} workspace`, person: { id: `github:${name}`, displayName: name } });
  const session = service.createSession({ personId: `github:${name}`, workspaceId: created.workspaceId });
  const principal = service.authenticateSession(session.token);
  if (!principal) throw new Error("session did not authenticate");
  return { workspaceId: created.workspaceId, principal, token: session.token, personId: `github:${name}` };
}

function enroll(workspaceOwner: ReturnType<typeof owner>, displayName = "laptop") {
  const invitation = service.createInvitation(workspaceOwner.principal, workspaceOwner.workspaceId, "developer");
  const keys = generateDeviceKeyPair();
  const enrollment = service.enrollDevice({
    invitationToken: invitation.token,
    publicKey: keys.publicKey,
    displayName,
    platform: { os: "linux", arch: "x64" },
  });
  const principal = service.authenticateDevice(enrollment.deviceToken);
  if (!principal) throw new Error("device did not authenticate");
  return { ...enrollment, keys, principal };
}

describe("workspaces and membership", () => {
  it("makes the creator the owner", () => {
    const ada = owner();
    expect(ada.principal.role).toBe("owner");
    expect(store.listMemberships(ada.workspaceId)).toHaveLength(1);
  });

  it("never lets one workspace see another", () => {
    const ada = owner("Ada");
    const bob = owner("Bob");
    expect(() => service.listMembers(ada.principal, bob.workspaceId)).toThrow(ForbiddenError);
    expect(() => service.listContracts(bob.principal, ada.workspaceId, "p")).toThrow(ForbiddenError);
  });

  it("keeps at least one owner", () => {
    const ada = owner();
    expect(() => service.changeRole(ada.principal, ada.workspaceId, ada.personId, "developer")).toThrow(
      /at least one owner/u,
    );
    expect(() => service.removeMember(ada.principal, ada.workspaceId, ada.personId)).toThrow(
      /at least one owner/u,
    );
  });

  it("revokes a person's devices when they are removed", () => {
    const ada = owner();
    const invitation = service.createInvitation(ada.principal, ada.workspaceId, "developer");
    const keys = generateDeviceKeyPair();
    const enrollment = service.enrollDevice({
      invitationToken: invitation.token,
      publicKey: keys.publicKey,
      displayName: "bob-laptop",
      platform: { os: "linux", arch: "x64" },
      personId: "github:Bob",
    });
    service.removeMember(ada.principal, ada.workspaceId, "github:Bob");
    expect(store.getDevice(enrollment.deviceId)?.state).toBe("revoked");
  });
});

describe("invitations", () => {
  it("stores only the hash and accepts exactly once", () => {
    const ada = owner();
    const invitation = service.createInvitation(ada.principal, ada.workspaceId, "developer");
    expect(invitation.invitation.tokenHash).toBe(hashToken(invitation.token));
    expect(invitation.invitation.tokenHash).not.toBe(invitation.token);

    const first = service.enrollDevice({
      invitationToken: invitation.token,
      publicKey: generateDeviceKeyPair().publicKey,
      displayName: "one",
      platform: { os: "linux", arch: "x64" },
    });
    expect(first.workspaceId).toBe(ada.workspaceId);

    expect(() =>
      service.enrollDevice({
        invitationToken: invitation.token,
        publicKey: generateDeviceKeyPair().publicKey,
        displayName: "two",
        platform: { os: "linux", arch: "x64" },
      }),
    ).toThrow(/already been used/u);
  });

  it("refuses an expired invitation", () => {
    const past = new ControlPlaneService({ store, signingKey: serviceKey, invitationTtlMs: -1 });
    const ada = owner();
    const invitation = past.createInvitation(ada.principal, ada.workspaceId, "developer");
    expect(() =>
      past.enrollDevice({
        invitationToken: invitation.token,
        publicKey: generateDeviceKeyPair().publicKey,
        displayName: "late",
        platform: { os: "linux", arch: "x64" },
      }),
    ).toThrow(/expired/u);
  });

  it("refuses a revoked invitation", () => {
    const ada = owner();
    const invitation = service.createInvitation(ada.principal, ada.workspaceId, "developer");
    service.revokeInvitation(ada.principal, ada.workspaceId, invitation.invitation.id);
    expect(() =>
      service.enrollDevice({
        invitationToken: invitation.token,
        publicKey: generateDeviceKeyPair().publicKey,
        displayName: "x",
        platform: { os: "linux", arch: "x64" },
      }),
    ).toThrow(/revoked/u);
  });

  it("only an owner can mint an owner invitation", () => {
    const ada = owner();
    // Ada is the last owner and cannot be downgraded, so invite a maintainer.
    const invitation = service.createInvitation(ada.principal, ada.workspaceId, "maintainer");
    const enrollment = service.enrollDevice({
      invitationToken: invitation.token,
      publicKey: generateDeviceKeyPair().publicKey,
      displayName: "m",
      platform: { os: "linux", arch: "x64" },
      personId: "github:Mia",
    });
    const miaSession = service.createSession({ personId: enrollment.personId, workspaceId: ada.workspaceId });
    const mia = service.authenticateSession(miaSession.token);
    expect(mia?.role).toBe("maintainer");
    expect(() => service.createInvitation(mia!, ada.workspaceId, "owner")).toThrow(/Only an owner/u);
  });
});

describe("devices", () => {
  it("refuses a revoked device immediately", () => {
    const ada = owner();
    const device = enroll(ada);
    service.revokeDevice(ada.principal, ada.workspaceId, device.deviceId);
    expect(() => service.authenticateDevice(device.deviceToken)).toThrow(/revoked/u);
  });

  it("refuses an unknown credential without leaking why", () => {
    expect(service.authenticateDevice("not-a-real-token")).toBeNull();
  });
});

describe("contracts", () => {
  function contractFor(
    projectId: string,
    keys: ReturnType<typeof generateDeviceKeyPair>,
    overrides: Partial<EnvironmentContractV1> = {},
  ) {
    const sealed = sealContract({
      schemaVersion: 1,
      id: `contract-${projectId}`,
      workspaceId: null,
      projectId,
      source: {
        commit: "a".repeat(40),
        canonicalRemoteDigest: DIGEST,
        subdirectory: ".",
        declaredFileDigests: [],
        worktreeDirty: false,
      },
      targets: [{ os: "linux", arch: "x64" }],
      support: "native",
      requirements: { runtimes: [], packages: [], systemTools: [], secrets: [] },
      steps: [],
      proof: {
        id: "proof-1",
        argv: ["true"],
        workDir: ".",
        timeoutMs: 60_000,
        expectedExitCodes: [0],
        envAllowlist: [],
        description: "check",
        maxOutputBytes: 65_536,
      },
      evidence: [],
      policy: {
        allowProjectLocalState: true,
        requireRecipeReview: true,
        requireHumanApproval: false,
        allowSourceUpload: false,
      },
      state: "candidate",
      adapters: ["node.npm"],
      issuedAt: NOW,
      authoredBy: { deviceId: "d", identity: "i" },
      ...overrides,
    } as Omit<EnvironmentContractV1, "digest" | "signature">);
    return signContract(sealed, keys, "device", NOW);
  }

  it("re-signs a published contract with the service key", () => {
    const ada = owner();
    const device = enroll(ada);
    const { projectId } = service.bindProject(device.principal, {
      projectId: null,
      projectName: "p",
      canonicalRemoteDigest: DIGEST,
      subdirectory: ".",
    });
    const published = service.publishContract(device.principal, contractFor(projectId, device.keys));
    expect(published.contract.signature?.signer).toBe("service");
    expect(published.contract.signature?.publicKey).toBe(serviceKey.publicKey);
    expect(published.contract.state).toBe("approved");
    expect(published.contract.workspaceId).toBe(ada.workspaceId);
  });

  it("refuses a contract signed by another device", () => {
    const ada = owner();
    const device = enroll(ada);
    const { projectId } = service.bindProject(device.principal, {
      projectId: null,
      projectName: "p",
      canonicalRemoteDigest: DIGEST,
      subdirectory: ".",
    });
    const stranger = generateDeviceKeyPair();
    expect(() => service.publishContract(device.principal, contractFor(projectId, stranger))).toThrow(
      /not signed by the publishing device/u,
    );
  });

  it("keeps a dirty-worktree capture local-only", () => {
    const ada = owner();
    const device = enroll(ada);
    const { projectId } = service.bindProject(device.principal, {
      projectId: null,
      projectName: "p",
      canonicalRemoteDigest: DIGEST,
      subdirectory: ".",
    });
    const dirty = contractFor(projectId, device.keys, {
      source: {
        commit: "a".repeat(40),
        canonicalRemoteDigest: DIGEST,
        subdirectory: ".",
        declaredFileDigests: [],
        worktreeDirty: true,
      },
    });
    expect(() => service.publishContract(device.principal, dirty)).toThrow(/dirty worktree/u);
  });

  it("refuses a contract for a project in another workspace", () => {
    const ada = owner("Ada");
    const bob = owner("Bob");
    const adaDevice = enroll(ada);
    const bobDevice = enroll(bob);
    const bobProject = service.bindProject(bobDevice.principal, {
      projectId: null,
      projectName: "bob",
      canonicalRemoteDigest: DIGEST,
      subdirectory: ".",
    });
    expect(() => service.publishContract(adaDevice.principal, contractFor(bobProject.projectId, adaDevice.keys))).toThrow();
  });

  it("prefers the strongest verified contract for a revision", () => {
    const ada = owner();
    const device = enroll(ada);
    const { projectId } = service.bindProject(device.principal, {
      projectId: null,
      projectName: "p",
      canonicalRemoteDigest: DIGEST,
      subdirectory: ".",
    });
    const approved = service.publishContract(device.principal, contractFor(projectId, device.keys)).contract;
    store.saveContract(ada.workspaceId, { ...approved, id: "verified", state: "clean_verified" }, NOW);

    const resolved = service.resolveContract(device.principal, { projectId, commit: "a".repeat(40) });
    expect(resolved.exact?.state).toBe("clean_verified");
  });
});

describe("device jobs", () => {
  it("carries identifiers only and is signed by the service", () => {
    const ada = owner();
    const device = enroll(ada);
    const { projectId } = service.bindProject(device.principal, {
      projectId: null,
      projectName: "p",
      canonicalRemoteDigest: DIGEST,
      subdirectory: ".",
    });
    const job = service.createJob(ada.principal, {
      workspaceId: ada.workspaceId,
      projectId,
      deviceId: device.deviceId,
      action: "rescue",
    });
    expect(job.signature?.signer).toBe("service");
    expect(JSON.stringify(job)).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//u);
    expect(Date.parse(job.expiresAt)).toBeGreaterThan(Date.parse(job.issuedAt));
  });

  it("delivers a job only to the device it names", () => {
    const ada = owner();
    const first = enroll(ada, "one");
    const second = enroll(ada, "two");
    const { projectId } = service.bindProject(first.principal, {
      projectId: null,
      projectName: "p",
      canonicalRemoteDigest: DIGEST,
      subdirectory: ".",
    });
    service.createJob(ada.principal, {
      workspaceId: ada.workspaceId,
      projectId,
      deviceId: first.deviceId,
      action: "capture",
    });
    expect(service.pollJobs(first.principal)).toHaveLength(1);
    expect(service.pollJobs(second.principal)).toHaveLength(0);
  });

  it("never delivers an expired job", () => {
    const shortLived = new ControlPlaneService({ store, signingKey: serviceKey, jobTtlMs: -1000 });
    const ada = owner();
    const device = enroll(ada);
    const { projectId } = service.bindProject(device.principal, {
      projectId: null,
      projectName: "p",
      canonicalRemoteDigest: DIGEST,
      subdirectory: ".",
    });
    shortLived.createJob(ada.principal, {
      workspaceId: ada.workspaceId,
      projectId,
      deviceId: device.deviceId,
      action: "rescue",
    });
    expect(shortLived.pollJobs(device.principal)).toHaveLength(0);
  });

  it("refuses to address a revoked device", () => {
    const ada = owner();
    const device = enroll(ada);
    const { projectId } = service.bindProject(device.principal, {
      projectId: null,
      projectName: "p",
      canonicalRemoteDigest: DIGEST,
      subdirectory: ".",
    });
    service.revokeDevice(ada.principal, ada.workspaceId, device.deviceId);
    expect(() =>
      service.createJob(ada.principal, {
        workspaceId: ada.workspaceId,
        projectId,
        deviceId: device.deviceId,
        action: "rescue",
      }),
    ).toThrow(/revoked/u);
  });
});

describe("rescue outcomes", () => {
  it("refuses an outcome whose signature does not verify", () => {
    const ada = owner();
    const device = enroll(ada);
    const { projectId } = service.bindProject(device.principal, {
      projectId: null,
      projectName: "p",
      canonicalRemoteDigest: DIGEST,
      subdirectory: ".",
    });
    const body = {
      schemaVersion: 1 as const,
      runId: "run-1",
      workspaceId: ada.workspaceId,
      projectId,
      deviceId: device.deviceId,
      contractId: "c",
      contractDigest: DIGEST,
      commit: "a".repeat(40),
      state: "working" as const,
      startedAt: NOW,
      endedAt: NOW,
      stepsApplied: [],
      journalDigest: DIGEST,
      assurance: "locally_checked" as const,
    };
    const outcome: RescueOutcomeV1 = {
      ...body,
      signature: signPayload({ ...body, state: "failed" }, device.keys, "device", NOW),
    };
    expect(() => service.publishRescueOutcome(device.principal, outcome)).toThrow(/does not verify/u);
  });
});

describe("audit", () => {
  it("links every event to the one before it", () => {
    const ada = owner();
    enroll(ada);
    const events = service.listAudit(ada.principal, ada.workspaceId);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(service.verifyAuditChain(ada.principal, ada.workspaceId).ok).toBe(true);

    // listAudit returns newest first, so walk it backwards.
    const oldestFirst = [...events].reverse();
    expect(oldestFirst[0]?.previousDigest).toBeNull();
    for (let index = 1; index < oldestFirst.length; index += 1) {
      expect(oldestFirst[index]?.previousDigest).toBe(oldestFirst[index - 1]?.digest);
    }
    // The id is unique, so an attacker cannot overwrite an event by replaying it.
    expect(() =>
      store.appendAudit({
        id: events[0]!.id,
        workspaceId: ada.workspaceId,
        at: NOW,
        actor: "someone-else",
        action: "replayed",
        subject: "x",
        detail: {},
      }),
    ).toThrow(/UNIQUE/u);
  });

  it("detects an event whose contents were rewritten underneath it", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "iwomc-audit-"));
    const path = join(dir, "cp.sqlite");
    const fileStore = new SqliteControlPlaneStore(path);
    const fileService = new ControlPlaneService({ store: fileStore, signingKey: serviceKey });

    const created = fileService.createWorkspace({ name: "w", person: { id: "github:Ada", displayName: "Ada" } });
    const session = fileService.createSession({ personId: "github:Ada", workspaceId: created.workspaceId });
    const principal = fileService.authenticateSession(session.token)!;
    fileService.createInvitation(principal, created.workspaceId, "developer");
    expect(fileService.verifyAuditChain(principal, created.workspaceId).ok).toBe(true);
    fileStore.close();

    // Rewrite one row's actor, the way someone with database access would.
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE audit SET actor = ? WHERE seq = 1").run("attacker");
    raw.close();

    const reopened = new SqliteControlPlaneStore(path);
    const reopenedService = new ControlPlaneService({ store: reopened, signingKey: serviceKey });
    const session2 = reopenedService.createSession({ personId: "github:Ada", workspaceId: created.workspaceId });
    const principal2 = reopenedService.authenticateSession(session2.token)!;
    const chain = reopenedService.verifyAuditChain(principal2, created.workspaceId);
    expect(chain.ok).toBe(false);
    expect(chain.brokenAt).toBeTruthy();
    reopened.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("needs the reviewer role or higher to read", () => {
    const ada = owner();
    const invitation = service.createInvitation(ada.principal, ada.workspaceId, "observer");
    const enrollment = service.enrollDevice({
      invitationToken: invitation.token,
      publicKey: generateDeviceKeyPair().publicKey,
      displayName: "obs",
      platform: { os: "linux", arch: "x64" },
      personId: "github:Obs",
    });
    const session = service.createSession({ personId: enrollment.personId, workspaceId: ada.workspaceId });
    const observer = service.authenticateSession(session.token);
    expect(() => service.listAudit(observer!, ada.workspaceId)).toThrow(/reviewer/u);
  });
});

describe("the Postgres port", () => {
  it("is absent unless a URL is configured", () => {
    expect(readPostgresConfig({})).toBeNull();
  });

  it("rejects a URL that is not Postgres", () => {
    const problems = validatePostgresConfig({ url: "mysql://host/db", schema: "public", maxConnections: 10, ssl: true });
    expect(problems.map((problem) => problem.field)).toContain("IWOMC_DATABASE_URL");
  });

  it("fails loudly instead of falling back to SQLite", async () => {
    await expect(
      createPostgresStore({ url: "postgres://reader@db.internal:5432/iwomc", schema: "public", maxConnections: 10, ssl: true }),
    ).rejects.toBeInstanceOf(PostgresUnavailableError);
  });
});

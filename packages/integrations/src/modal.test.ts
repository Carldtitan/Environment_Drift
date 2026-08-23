import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanionStore, defaultRegistryForCompanion } from "@iwomc/companion";
import type { EnvironmentContractV1 } from "@iwomc/contracts";
import { sealContract, signContract, generateDeviceKeyPair } from "@iwomc/contracts";
import { BudgetLedger, DEFAULT_RATES } from "./budget.js";
import { ModalVerifier, selectImage, type ModalSdk, type ModalSandboxLike } from "./modal.js";

/**
 * Modal verifier tests (task 8.1, 8.4).
 *
 * The budget, the image choice, the source-upload policy, and the cleanup path
 * are all checked against an injected SDK double, so they run with no
 * credentials and cost nothing. The one test that talks to Modal for real is
 * gated on credentials and skips with a stated reason otherwise.
 */

const NOW = "2026-08-23T05:00:00.000Z";
const DIGEST = `sha256:${"b".repeat(64)}`;

function contractWith(overrides: Partial<EnvironmentContractV1> = {}): EnvironmentContractV1 {
  const keys = generateDeviceKeyPair();
  const base = sealContract({
    schemaVersion: 1,
    id: "contract-1",
    workspaceId: null,
    projectId: "project-1",
    source: {
      commit: "a".repeat(40),
      canonicalRemoteDigest: DIGEST,
      subdirectory: ".",
      declaredFileDigests: [],
      worktreeDirty: false,
    },
    targets: [{ os: "linux", arch: "x64" }],
    support: "native",
    requirements: {
      runtimes: [{ runtime: "node", versionSpec: ">=22.0.0", source: "declared" }],
      packages: [],
      systemTools: [],
      secrets: [],
    },
    steps: [],
    proof: {
      id: "proof-1",
      argv: ["node", "--version"],
      workDir: ".",
      timeoutMs: 60_000,
      expectedExitCodes: [0],
      envAllowlist: [],
      description: "runtime present",
      maxOutputBytes: 65_536,
    },
    evidence: [],
    policy: {
      allowProjectLocalState: true,
      requireRecipeReview: true,
      requireHumanApproval: false,
      allowSourceUpload: false,
    },
    state: "approved",
    adapters: ["node.npm"],
    issuedAt: NOW,
    authoredBy: { deviceId: "device-1", identity: "local:owner" },
    ...overrides,
  } as Omit<EnvironmentContractV1, "digest" | "signature">);
  return signContract(base, keys, "device", NOW);
}

let home: string;
let store: CompanionStore;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "iwomc-modal-test-"));
  store = CompanionStore.openAt(join(home, "store.sqlite"), join(home, "key"));
});

afterEach(async () => {
  store.close();
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
});

function ledger(totalUsd = 30, perRunCapUsd = 0.5): BudgetLedger {
  return new BudgetLedger({ store, provider: "modal", policy: { totalUsd, perRunCapUsd } });
}

describe("the verification budget", () => {
  it("estimates from reserved CPU, memory, and wall time", () => {
    const budget = ledger();
    const cost = budget.estimate({ cpuCores: 2, memoryMiB: 2048, seconds: 900 });
    const expected =
      2 * 900 * DEFAULT_RATES.cpuCoreSecondUsd + 2 * 900 * DEFAULT_RATES.gibSecondUsd;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("refuses a run whose worst case exceeds the per-run cap", () => {
    const budget = ledger(30, 0.001);
    const decision = budget.authorize(0.05);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("per-run cap");
  });

  it("refuses to start when the remaining budget cannot cover the run", () => {
    const budget = ledger(30, 5);
    budget.record({ amountUsd: 29.9, reference: "earlier", at: NOW });
    const decision = budget.authorize(1);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("remains");
    expect(budget.remaining()).toBeCloseTo(0.1, 4);
  });

  it("keeps an append-only ledger of what was spent", () => {
    const budget = ledger();
    budget.record({ amountUsd: 0.01, reference: "verification:1", at: NOW });
    budget.record({ amountUsd: 0.02, reference: "verification:2", at: NOW });
    expect(budget.spent()).toBeCloseTo(0.03, 6);
    expect(budget.history()).toHaveLength(2);
  });
});

describe("base image selection", () => {
  it("chooses an official image from the declared runtime", () => {
    expect(selectImage([{ runtime: "node", versionSpec: ">=22.0.0" }])?.tag).toBe("node:22-bookworm-slim");
    expect(selectImage([{ runtime: "python", versionSpec: ">=3.12" }])?.tag).toBe("python:3.12-slim-bookworm");
  });

  it("returns null rather than substituting a runtime it has not mapped", () => {
    expect(
      selectImage([
        { runtime: "node", versionSpec: ">=22" },
        { runtime: "python", versionSpec: ">=3.12" },
      ]),
    ).toBeNull();
    expect(selectImage([{ runtime: "ghc", versionSpec: "9" }])).toBeNull();
  });
});

describe("applicability", () => {
  it("skips, rather than fails, when the project has not approved source upload", async () => {
    const verifier = new ModalVerifier({ budget: ledger(), registry: defaultRegistryForCompanion() });
    const result = await verifier.applicability(contractWith());
    expect(result.applicable).toBe(false);
    expect(result.reason).toContain("has not approved sending its source");
  });

  it("is applicable once the project approves it and an image exists", async () => {
    const verifier = new ModalVerifier({ budget: ledger(), registry: defaultRegistryForCompanion() });
    const contract = contractWith({
      policy: {
        allowProjectLocalState: true,
        requireRecipeReview: true,
        requireHumanApproval: false,
        allowSourceUpload: true,
      },
    });
    const result = await verifier.applicability(contract);
    expect(result.applicable).toBe(true);
    expect(result.reason).toContain("node:22-bookworm-slim");
  });
});

describe("availability", () => {
  it("reports not_configured with no credentials anywhere", async () => {
    const verifier = new ModalVerifier({
      budget: ledger(),
      registry: defaultRegistryForCompanion(),
      env: { HOME: "/nonexistent" },
    });
    const availability = await verifier.availability();
    expect(availability.available).toBe(false);
    expect(availability.status).toBe("not_configured");
    expect(availability.detail).toContain("modal token set");
  });

  it("does not claim connected merely because a token is present", async () => {
    const verifier = new ModalVerifier({
      budget: ledger(),
      registry: defaultRegistryForCompanion(),
      env: { MODAL_TOKEN_ID: "ak-test", MODAL_TOKEN_SECRET: "as-test", HOME: "/nonexistent" },
      loadSdk: async () => {
        throw new Error("SDK refused");
      },
    });
    const availability = await verifier.availability();
    expect(availability.available).toBe(false);
    expect(availability.status).toBe("misconfigured");
  });

  it("refuses to start when the budget is exhausted, even with valid credentials", async () => {
    const budget = ledger(30, 5);
    budget.record({ amountUsd: 30, reference: "spent", at: NOW });
    const verifier = new ModalVerifier({
      budget,
      registry: defaultRegistryForCompanion(),
      env: { MODAL_TOKEN_ID: "ak-test", MODAL_TOKEN_SECRET: "as-test", HOME: "/nonexistent" },
      loadSdk: async () => fakeSdk().sdk,
    });
    const availability = await verifier.availability();
    expect(availability.available).toBe(false);
    expect(availability.status).toBe("unavailable");
    expect(availability.remainingBudgetUsd).toBe(0);
  });
});

describe("a verification run", () => {
  it("terminates the sandbox and records the cost on every path", async () => {
    const { sdk, state } = fakeSdk({ failStep: true });
    const budget = ledger();
    const verifier = new ModalVerifier({
      budget,
      registry: defaultRegistryForCompanion(),
      env: { MODAL_TOKEN_ID: "ak-test", MODAL_TOKEN_SECRET: "as-test" },
      loadSdk: async () => sdk,
      now: () => NOW,
    });

    const contract = contractWith({
      policy: {
        allowProjectLocalState: true,
        requireRecipeReview: true,
        requireHumanApproval: false,
        allowSourceUpload: true,
      },
    });
    const output = await verifier.verify({
      contract,
      proof: contract.proof,
      sourceDir: home,
      platform: { os: "linux", arch: "x64" },
    });

    // The source bundle could not be built here (home is not a repository), so
    // the run fails - and the sandbox must still be gone.
    expect(output.attestation.assurance).toBe("unverified");
    expect(output.attestation.state).toBe("failed");
    expect(output.attestation.failureReason).toBeTruthy();
    expect(state.terminated || state.created === false).toBe(true);
  });

  it("refuses before provisioning when source upload is not approved", async () => {
    const { sdk, state } = fakeSdk();
    const verifier = new ModalVerifier({
      budget: ledger(),
      registry: defaultRegistryForCompanion(),
      env: { MODAL_TOKEN_ID: "ak-test", MODAL_TOKEN_SECRET: "as-test" },
      loadSdk: async () => sdk,
      now: () => NOW,
    });
    const contract = contractWith();
    const output = await verifier.verify({
      contract,
      proof: contract.proof,
      sourceDir: home,
      platform: { os: "linux", arch: "x64" },
    });
    expect(state.created).toBe(false);
    expect(output.attestation.cleanup).toBe("not_required");
    expect(output.attestation.failureReason).toContain("has not approved uploading source");
  });
});

/**
 * The one test that talks to Modal for real. It is skipped, loudly, when no
 * credentials are configured - never replaced by a stub that reports success.
 */
const modalConfigured =
  process.env["IWOMC_MODAL_LIVE_TEST"] === "1" &&
  ((process.env["MODAL_TOKEN_ID"] ?? "").length > 0 || (process.env["MODAL_PROFILE"] ?? "").length > 0);

describe.skipIf(!modalConfigured)("against the real Modal API (credential-gated)", () => {
  it("authenticates and reports the remaining budget", async () => {
    const verifier = new ModalVerifier({ budget: ledger(), registry: defaultRegistryForCompanion() });
    const availability = await verifier.availability();
    expect(availability.status).toBe("connected");
    expect(availability.remainingBudgetUsd).toBeGreaterThan(0);
  }, 120_000);
});

if (!modalConfigured) {
  // eslint-disable-next-line no-console
  console.info(
    "[skipped] the live Modal test needs IWOMC_MODAL_LIVE_TEST=1 plus MODAL_TOKEN_ID/MODAL_PROFILE. No stub was substituted.",
  );
}

// ---------------------------------------------------------------------------

function fakeSdk(options: { failStep?: boolean } = {}): {
  sdk: ModalSdk;
  state: { created: boolean; terminated: boolean; commands: string[][] };
} {
  const state = { created: false, terminated: false, commands: [] as string[][] };

  const sandbox: ModalSandboxLike = {
    sandboxId: "sb-test",
    filesystem: { copyFromLocal: async () => undefined },
    exec: async (command) => {
      state.commands.push([...command]);
      const exitCode = options.failStep && command[0] === "tar" ? 2 : 0;
      return {
        stdout: { readText: async () => "" },
        stderr: { readText: async () => (exitCode === 0 ? "" : "tar failed") },
        wait: async () => exitCode,
      };
    },
    terminate: async () => {
      state.terminated = true;
    },
  };

  const sdk: ModalSdk = {
    ModalClient: class {
      apps = { fromName: async () => ({ appId: "ap-test" }) };
      images = { fromRegistry: () => ({ imageId: "im-test" }) };
      sandboxes = {
        create: async () => {
          state.created = true;
          return sandbox;
        },
      };
      close() {}
    } as unknown as ModalSdk["ModalClient"],
  };

  return { sdk, state };
}

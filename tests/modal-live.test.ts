import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompanionStore, Companion, defaultRegistryForCompanion } from "@iwomc/companion";
import { BudgetLedger, ModalVerifier } from "@iwomc/integrations";
import { createNodeProject, createSandbox, runIwomc, type NodeProjectResult, type Sandbox } from "@iwomc/testkit";

/**
 * The real Modal path (task 8.4).
 *
 * This creates a disposable sandbox, materializes the contract in it, runs the
 * proof command, and terminates it. It costs money, so it is gated on an
 * explicit opt-in and skips with a stated reason otherwise. Nothing stands in
 * for it: without the opt-in there is no result, not a fake one.
 */

const enabled =
  process.env["IWOMC_MODAL_SANDBOX_TEST"] === "1" &&
  ((process.env["MODAL_TOKEN_ID"] ?? "").length > 0 || (process.env["MODAL_PROFILE"] ?? "").length > 0);

if (!enabled) {
  // eslint-disable-next-line no-console
  console.info(
    "[skipped] the live Modal sandbox test needs IWOMC_MODAL_SANDBOX_TEST=1 and Modal credentials. It creates a real sandbox and spends real budget, so it never runs by default. No stub was substituted.",
  );
}

describe.skipIf(!enabled)("clean verification in a real Modal sandbox", () => {
  let sandbox: Sandbox;
  let project: NodeProjectResult;
  let companion: Companion;
  let store: CompanionStore;
  let budget: BudgetLedger;

  beforeAll(async () => {
    sandbox = await createSandbox({ IWOMC_DISABLE_MEMORY: "1" });
    project = await createNodeProject({ root: sandbox.home });

    // Clean verification needs the project's explicit approval to send source.
    await runIwomc(["init", "--proof", "npm run proof", "--json"], { cwd: project.dir, env: sandbox.env });
    const capture = await runIwomc(["capture", "--json", "--allow-source-upload"], {
      cwd: project.dir,
      env: sandbox.env,
    });
    expect(capture.exitCode).toBe(0);

    store = CompanionStore.open(sandbox.env);
    const registry = defaultRegistryForCompanion();
    budget = new BudgetLedger({
      store,
      provider: "modal",
      policy: { totalUsd: 30, perRunCapUsd: 0.5 },
    });
    companion = new Companion({
      store,
      registry,
      env: sandbox.env,
      verifiers: [
        new ModalVerifier({
          budget,
          registry,
          // Tight bounds: this is a small project and the run must stay cheap.
          limits: { cpuCores: 2, memoryMiB: 2048, timeoutSeconds: 420, maxRetries: 0, maxLogBytes: 262_144 },
          ...(process.env["MODAL_PROFILE"] ? { profile: process.env["MODAL_PROFILE"] } : {}),
          env: process.env,
        }),
      ],
    });
  }, 900_000);

  afterAll(async () => {
    companion?.close();
    await project?.cleanup();
    await sandbox?.cleanup();
  });

  it("provisions, materializes, proves, and terminates", async () => {
    const before = budget.spent();
    const events: string[] = [];

    const result = await companion.verify(project.dir, {
      verifier: "modal",
      onEvent: (event) => events.push(`${event.phase}: ${event.message}`),
    });

    const attestation = result.attestation;
    expect(attestation, `no attestation. events:\n${events.join("\n")}`).not.toBeNull();
    expect(attestation?.verifier).toBe("modal");
    expect(
      attestation?.state,
      `verification did not pass. reason: ${attestation?.failureReason}\n${events.join("\n")}`,
    ).toBe("passed");

    // Only a passing Modal run may claim this.
    expect(attestation?.assurance).toBe("clean_verified");
    expect(attestation?.proofExitCode).toBe(0);
    expect(attestation?.platform).toEqual({ os: "linux", arch: "x64" });

    // The sandbox is gone on every path.
    expect(attestation?.cleanup).toBe("terminated");

    // The cost was recorded against the ledger before the run was reported.
    expect(attestation?.cost?.currency).toBe("USD");
    expect(attestation?.cost?.amount).toBeGreaterThan(0);
    expect(budget.spent()).toBeGreaterThan(before);
    expect(budget.spent()).toBeLessThanOrEqual(30);

    // The contract earned the strongest label the product has.
    expect(result.contract?.state).toBe("clean_verified");

    // eslint-disable-next-line no-console
    console.info(
      `[modal] ${attestation?.state} in a real sandbox; cost estimate USD ${attestation?.cost?.amount.toFixed(4)}; remaining budget USD ${budget.remaining().toFixed(4)}`,
    );
  }, 1_200_000);
});

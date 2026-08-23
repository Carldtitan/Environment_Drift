import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, CompanionStore } from "@iwomc/companion";
import { createNodeProject, createSandbox, runIwomc, type NodeProjectResult, type Sandbox } from "@iwomc/testkit";

/**
 * Negative cases (task 10.4).
 *
 * Every one of these must reach a truthful terminal state with a blocker code
 * and one next action. None of them may reach `working`.
 */

const EXIT = { ok: 0, failed: 1, blocked: 2, unsupported: 3, inconclusive: 4 };

interface RescueJson {
  state?: string;
  blocker: { code: string; message: string; nextAction: string };
  proof?: { exitCode: number | null } | null;
}

describe("a checkout that does not match the contract", () => {
  let sandbox: Sandbox;
  let project: NodeProjectResult;
  let broken: string;

  beforeAll(async () => {
    sandbox = await createSandbox({ IWOMC_DISABLE_MEMORY: "1" });
    project = await createNodeProject({ root: sandbox.home });
    broken = await project.clone();
    await runIwomc(["init", "--proof", "npm run proof", "--json"], { cwd: project.dir, env: sandbox.env });
    await runIwomc(["capture", "--json"], { cwd: project.dir, env: sandbox.env });
    await runIwomc(["verify", "--json"], { cwd: project.dir, env: sandbox.env });
    await runIwomc(["init", "--json"], { cwd: broken, env: sandbox.env });
  }, 900_000);

  afterAll(async () => {
    await project?.cleanup();
    await sandbox?.cleanup();
  });

  it("refuses a different revision and offers the nearest contract as a choice", async () => {
    // Move the second checkout forward so its HEAD is no longer the captured one.
    await writeFile(join(broken, "NOTE.md"), "a later commit\n", "utf8");
    await run(["git", "add", "-A"], { cwd: broken, timeoutMs: 60_000, envAllowlist: null });
    await run(["git", "commit", "--quiet", "--no-gpg-sign", "-m", "later"], {
      cwd: broken,
      timeoutMs: 60_000,
      envAllowlist: null,
    });

    const result = await runIwomc(["rescue", "--json", "--approve"], { cwd: broken, env: sandbox.env });
    expect(result.exitCode).toBe(EXIT.blocked);
    const payload = result.json<RescueJson & { blocker: { detail?: { nearestContractId?: string } } }>();
    expect(payload.blocker.code).toBe("no_contract_for_revision");
    expect(payload.blocker.nextAction).toContain("--contract");
    // The nearest contract is offered, never applied on its own.
    expect(payload.blocker.detail?.nearestContractId).toBeTruthy();

    await run(["git", "reset", "--hard", "HEAD~1"], { cwd: broken, timeoutMs: 60_000, envAllowlist: null });
  }, 900_000);

  it("refuses a checkout of a different repository", async () => {
    const other = await createNodeProject({ root: sandbox.home });
    try {
      await runIwomc(["init", "--json"], { cwd: other.dir, env: sandbox.env });
      // The other project has its own binding, so it has no contract at all.
      const result = await runIwomc(["rescue", "--json", "--approve"], { cwd: other.dir, env: sandbox.env });
      expect(result.exitCode).toBe(EXIT.blocked);
      expect(result.json<RescueJson>().blocker.code).toBe("no_contract_for_revision");

      // Pointing it at the first project's contract is refused on project scope.
      const status = await runIwomc(["status", "--json"], { cwd: project.dir, env: sandbox.env });
      const contractId = status.json<{ contracts: { id: string }[] }>().contracts[0]?.id as string;
      const cross = await runIwomc(["rescue", "--json", "--approve", "--contract", contractId], {
        cwd: other.dir,
        env: sandbox.env,
      });
      expect(cross.exitCode).not.toBe(EXIT.ok);
      expect(["workspace_forbidden", "no_contract_for_revision", "remote_mismatch"]).toContain(
        cross.json<RescueJson>().blocker.code,
      );
    } finally {
      await other.cleanup();
    }
  }, 900_000);

  it("refuses a contract whose signature no longer verifies", async () => {
    const status = await runIwomc(["status", "--json"], { cwd: project.dir, env: sandbox.env });
    const contractId = status.json<{ contracts: { id: string }[] }>().contracts[0]?.id as string;

    // Tamper with the stored contract the way a modified payload would arrive.
    const store = CompanionStore.open(sandbox.env);
    const stored = store.getContract(contractId);
    expect(stored).not.toBeNull();
    store.saveContract(
      {
        ...stored!.contract,
        proof: { ...stored!.contract.proof, argv: ["node", "-e", "process.exit(0)"] },
      },
      stored!.origin,
    );
    store.close();

    const result = await runIwomc(["rescue", "--json", "--approve", "--contract", contractId], {
      cwd: broken,
      env: sandbox.env,
    });
    expect(result.exitCode).toBe(EXIT.blocked);
    const payload = result.json<RescueJson>();
    expect(payload.blocker.code).toBe("signature_invalid");
    expect(payload.proof ?? null).toBeNull();

    // The refusal is recorded as a security event, not swallowed.
    const reopened = CompanionStore.open(sandbox.env);
    const audit = reopened.listAudit();
    reopened.close();
    expect(audit.some((event) => event.action === "security.contract_rejected")).toBe(true);
  }, 900_000);
});

describe("a contract that names a secret", () => {
  let sandbox: Sandbox;
  let project: NodeProjectResult;
  let broken: string;
  const secretName = "IWOMC_TEST_REQUIRED_SECRET";

  beforeAll(async () => {
    sandbox = await createSandbox({ IWOMC_DISABLE_MEMORY: "1" });
    project = await createNodeProject({ root: sandbox.home });

    // A committed environment template declares the name; the value never
    // leaves this machine and is never written into a contract.
    await writeFile(join(project.dir, ".env.example"), `${secretName}=\n`, "utf8");
    await writeFile(join(project.dir, ".env"), `${secretName}=a-local-only-value\n`, "utf8");
    await run(["git", "add", "-A", "--", ".env.example"], { cwd: project.dir, timeoutMs: 60_000, envAllowlist: null });
    await run(["git", "commit", "--quiet", "--no-gpg-sign", "-m", "declare a required secret"], {
      cwd: project.dir,
      timeoutMs: 60_000,
      envAllowlist: null,
    });
    await run(["git", "push", "--quiet", "origin", "main"], { cwd: project.dir, timeoutMs: 120_000, envAllowlist: null });

    await runIwomc(["init", "--proof", "npm run proof", "--json"], { cwd: project.dir, env: sandbox.env });
    await runIwomc(["capture", "--json"], { cwd: project.dir, env: sandbox.env });
    await runIwomc(["verify", "--json"], { cwd: project.dir, env: sandbox.env });
    broken = await project.clone();
    await runIwomc(["init", "--json"], { cwd: broken, env: sandbox.env });
  }, 900_000);

  afterAll(async () => {
    await project?.cleanup();
    await sandbox?.cleanup();
  });

  it("records the name and never the value", async () => {
    const status = await runIwomc(["status", "--json"], { cwd: project.dir, env: sandbox.env });
    const contracts = status.json<{ contracts: { id: string }[] }>().contracts;
    const store = CompanionStore.open(sandbox.env);
    const contract = store.getContract(contracts[0]!.id)!.contract;
    store.close();

    const names = contract.requirements.secrets.map((secret) => secret.name);
    expect(names).toContain(secretName);
    expect(JSON.stringify(contract)).not.toContain("a-local-only-value");
  }, 300_000);

  it("stops before the proof and names the missing secret", async () => {
    const result = await runIwomc(["rescue", "--json", "--approve"], {
      cwd: broken,
      env: { ...sandbox.env, [secretName]: "" },
    });
    expect(result.exitCode).toBe(EXIT.blocked);
    const payload = result.json<RescueJson & { blocker: { detail?: { names?: string[] } } }>();
    expect(payload.blocker.code).toBe("missing_secret");
    expect(payload.blocker.detail?.names).toContain(secretName);
    expect(payload.blocker.nextAction).toContain("never copies secret values");
    // It stopped before proving anything.
    expect(payload.proof ?? null).toBeNull();
  }, 900_000);

  it("proceeds once the teammate sets the secret themselves", async () => {
    const result = await runIwomc(["rescue", "--json", "--approve"], {
      cwd: broken,
      env: { ...sandbox.env, [secretName]: "the teammate's own value" },
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.json<{ state: string }>().state).toBe("working");
  }, 900_000);
});

describe("an interrupted rescue", () => {
  let sandbox: Sandbox;
  let project: NodeProjectResult;
  let broken: string;

  beforeAll(async () => {
    sandbox = await createSandbox({ IWOMC_DISABLE_MEMORY: "1" });
    project = await createNodeProject({ root: sandbox.home });
    broken = await project.clone();
    await runIwomc(["init", "--proof", "npm run proof", "--json"], { cwd: project.dir, env: sandbox.env });
    await runIwomc(["capture", "--json"], { cwd: project.dir, env: sandbox.env });
    await runIwomc(["verify", "--json"], { cwd: project.dir, env: sandbox.env });
    await runIwomc(["init", "--json"], { cwd: broken, env: sandbox.env });
  }, 900_000);

  afterAll(async () => {
    await project?.cleanup();
    await sandbox?.cleanup();
  });

  it("resumes from the journal instead of repeating work", async () => {
    const first = await runIwomc(["rescue", "--json", "--approve"], { cwd: broken, env: sandbox.env });
    expect(first.exitCode).toBe(EXIT.ok);

    const store = CompanionStore.open(sandbox.env);
    const runs = store.listAllRuns();
    const journal = store.readJournal(runs[0]!.id);
    store.close();
    expect(journal.some((entry) => entry.phase === "succeeded")).toBe(true);

    // A second run sees the journal and skips what already applied.
    const second = await runIwomc(["rescue", "--json", "--approve"], { cwd: broken, env: sandbox.env });
    expect(second.exitCode).toBe(EXIT.ok);
    const events = second.json<{ events: { message: string }[] }>().events;
    expect(events.some((event) => event.message.includes("already applied"))).toBe(true);
  }, 900_000);
});

describe("a directory that is not a project", () => {
  let sandbox: Sandbox;
  let dir: string;

  beforeAll(async () => {
    sandbox = await createSandbox({ IWOMC_DISABLE_MEMORY: "1" });
    dir = await mkdtemp(join(tmpdir(), "iwomc-not-a-repo-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await sandbox?.cleanup();
  });

  it("says it needs a Git checkout instead of failing obscurely", async () => {
    const result = await runIwomc(["status", "--json"], { cwd: dir, env: sandbox.env });
    expect(result.exitCode).toBe(EXIT.blocked);
    const payload = result.json<{ projectError: string }>();
    expect(payload.projectError).toContain("Git checkout");
  }, 120_000);

  it("refuses to rescue there at all", async () => {
    const result = await runIwomc(["rescue", "--json", "--approve"], { cwd: dir, env: sandbox.env });
    expect(result.exitCode).toBe(EXIT.blocked);
  }, 120_000);
});

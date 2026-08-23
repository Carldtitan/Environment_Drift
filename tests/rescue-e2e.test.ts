import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "@iwomc/companion";
import {
  createNodeProject,
  createRecipeProject,
  createSandbox,
  installUndeclaredPackage,
  runIwomc,
  type NodeProjectResult,
  type Sandbox,
} from "@iwomc/testkit";

/**
 * The acceptance test (task 10.2).
 *
 * Two independent checkouts of a project created at test time. The first works;
 * the second is broken because the repository alone does not put the
 * environment on disk. Capture in the first, rescue in the second, and require
 * the project's own proof command to pass.
 *
 * Nothing here is staged: the project name, its dependency, and its paths are
 * generated per run.
 */

const EXIT = { ok: 0, failed: 1, blocked: 2, unsupported: 3, inconclusive: 4 };

describe("capture in one checkout, rescue in another", () => {
  let sandbox: Sandbox;
  let project: NodeProjectResult;
  let broken: string;

  beforeAll(async () => {
    sandbox = await createSandbox({ IWOMC_DISABLE_MEMORY: "1" });
    project = await createNodeProject({ root: sandbox.home });
    broken = await project.clone();
  }, 900_000);

  afterAll(async () => {
    await project?.cleanup();
    await sandbox?.cleanup();
  });

  it("starts from a working checkout and a broken one", async () => {
    const working = await run(["npm", "run", "proof"], {
      cwd: project.dir,
      timeoutMs: 120_000,
      envAllowlist: null,
    });
    expect(working.exitCode, "the first checkout must actually work").toBe(0);

    const failing = await run(["npm", "run", "proof"], {
      cwd: broken,
      timeoutMs: 120_000,
      envAllowlist: null,
    });
    expect(failing.exitCode, "the second checkout must actually be broken").not.toBe(0);
  });

  it("binds the working checkout and records its proof command", async () => {
    const result = await runIwomc(["init", "--proof", "npm run proof", "--json"], {
      cwd: project.dir,
      env: sandbox.env,
    });
    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json<{ support: { level: string }; proof: { argv: string[] } }>();
    expect(payload.support.level).toBe("native");
    expect(payload.proof.argv).toEqual(["npm", "run", "proof"]);
  });

  it("captures a signed contract for the exact revision", async () => {
    const result = await runIwomc(["capture", "--json"], { cwd: project.dir, env: sandbox.env });
    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json<{
      contract: {
        digest: string;
        state: string;
        support: string;
        source: { commit: string; worktreeDirty: boolean };
        signature: { signer: string };
        steps: { kind: string }[];
        requirements: { secrets: unknown[] };
      };
      blockers: string[];
      coverage: { area: string }[];
    }>();

    expect(payload.contract.state).toBe("candidate");
    expect(payload.contract.support).toBe("native");
    expect(payload.contract.signature.signer).toBe("device");
    expect(payload.contract.source.commit).toBe(project.commit);
    expect(payload.contract.source.worktreeDirty).toBe(false);
    expect(payload.blockers).toEqual([]);
    expect(payload.contract.steps.map((step: { kind: string }) => step.kind)).toContain("install_project_dependencies");

    // Capture must state what it could not see rather than implying a full
    // host snapshot.
    const areas = payload.coverage.map((gap: { area: string }) => gap.area);
    expect(areas).toContain("host.global-packages");
    expect(areas).toContain("secrets.values");
  }, 300_000);

  it("checks the contract in a fresh directory and labels it locally checked", async () => {
    const result = await runIwomc(["verify", "--json"], { cwd: project.dir, env: sandbox.env });
    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json<{
      attestation: { state: string; assurance: string; verifier: string; cleanup: string; proofExitCode: number };
      contract: { state: string };
      verifierDetail: string;
    }>();
    expect(payload.attestation.state).toBe("passed");
    // Only Modal may claim `clean_verified`.
    expect(payload.attestation.assurance).toBe("locally_checked");
    expect(payload.attestation.verifier).toBe("local_fresh_directory");
    expect(payload.attestation.cleanup).toBe("terminated");
    expect(payload.attestation.proofExitCode).toBe(0);
    expect(payload.contract.state).toBe("locally_checked");
  }, 600_000);

  it("rescues the broken checkout and proves it works", async () => {
    const bind = await runIwomc(["init", "--json"], { cwd: broken, env: sandbox.env });
    expect(bind.exitCode).toBe(EXIT.ok);

    const status = await runIwomc(["status", "--json"], { cwd: broken, env: sandbox.env });
    const before = status.json<{ canRescueNow: { possible: boolean } }>();
    expect(before.canRescueNow.possible).toBe(true);

    const result = await runIwomc(["rescue", "--json", "--approve"], { cwd: broken, env: sandbox.env });
    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json<{
      state: string;
      proof: { exitCode: number };
      outcome: { stepsApplied: string[]; assurance: string; signature: { signer: string } };
      blocker: unknown;
    }>();

    expect(payload.state).toBe("working");
    expect(payload.blocker).toBeNull();
    // `working` is produced by the proof command, never by installing.
    expect(payload.proof.exitCode).toBe(0);
    expect(payload.outcome.stepsApplied.length).toBeGreaterThan(0);
    expect(payload.outcome.signature.signer).toBe("device");
  }, 900_000);

  it("leaves the rescued checkout genuinely working", async () => {
    const proof = await run(["npm", "run", "proof"], {
      cwd: broken,
      timeoutMs: 120_000,
      envAllowlist: null,
    });
    expect(proof.exitCode).toBe(0);
  }, 120_000);

  it("does not modify any tracked file in the rescued checkout", async () => {
    const status = await run(["git", "status", "--porcelain"], {
      cwd: broken,
      timeoutMs: 60_000,
      envAllowlist: null,
    });
    const dirty = status.stdout
      .split(/\r?\n/u)
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0)
      // node_modules and .iwomc are ignored by the fixture's .gitignore, so
      // anything left here would be a real modification.
      .filter((line: string) => !line.includes("node_modules") && !line.includes(".iwomc"));
    expect(dirty).toEqual([]);
  }, 60_000);

  it("is idempotent: a second rescue reuses the journal and still proves", async () => {
    const result = await runIwomc(["rescue", "--json", "--approve"], { cwd: broken, env: sandbox.env });
    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json<{ state: string; events: { kind: string; message: string }[] }>();
    expect(payload.state).toBe("working");
    const skipped = payload.events.filter((event: { message: string }) => event.message.includes("already applied"));
    expect(skipped.length).toBeGreaterThan(0);
  }, 900_000);
});

describe("drift and promotion", () => {
  let sandbox: Sandbox;
  let project: NodeProjectResult;

  beforeAll(async () => {
    sandbox = await createSandbox({ IWOMC_DISABLE_MEMORY: "1" });
    project = await createNodeProject({ root: sandbox.home, withUndeclared: true });
  }, 900_000);

  afterAll(async () => {
    await project?.cleanup();
    await sandbox?.cleanup();
  });

  it("finds a package that is installed here but not declared", async () => {
    const name = project.undeclaredDependency as string;
    await installUndeclaredPackage(project.dir, name, "2.3.4");

    await runIwomc(["init", "--proof", "npm run proof", "--json"], { cwd: project.dir, env: sandbox.env });
    const result = await runIwomc(["capture", "--json"], { cwd: project.dir, env: sandbox.env });
    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json<{
      drift: { kind: string; summary: string; affectedDeclaration: string }[];
      contract: { steps: { kind: string }[] };
    }>();

    const finding = payload.drift.find((entry: { summary: string; kind: string; affectedDeclaration: string }) => entry.summary.includes(name));
    expect(finding, `expected drift for ${name}, saw ${JSON.stringify(payload.drift)}`).toBeDefined();
    expect(finding?.kind).toBe("undeclared_package");
    expect(finding?.affectedDeclaration).toBe("package.json");
    expect(payload.contract.steps.map((step: { kind: string }) => step.kind)).toContain("apply_package_overlay");
  }, 300_000);

  it("proposes a reviewable diff and writes nothing until asked", async () => {
    const name = project.undeclaredDependency as string;
    const before = await readFile(join(project.dir, "package.json"), "utf8");

    const preview = await runIwomc(["promote", "--json"], { cwd: project.dir, env: sandbox.env });
    expect(preview.exitCode).toBe(EXIT.ok);
    const proposal = preview.json<{
      repair: { files: { path: string; unifiedDiff: string }[]; requiresReview: boolean };
      applied: string[];
    }>();
    expect(proposal.repair.requiresReview).toBe(true);
    expect(proposal.applied).toEqual([]);
    expect(proposal.repair.files[0]?.path).toBe("package.json");
    expect(proposal.repair.files[0]?.unifiedDiff).toContain(name);
    expect(await readFile(join(project.dir, "package.json"), "utf8")).toBe(before);

    const applied = await runIwomc(["promote", "--apply", "--json"], { cwd: project.dir, env: sandbox.env });
    expect(applied.exitCode).toBe(EXIT.ok);
    const after = await readFile(join(project.dir, "package.json"), "utf8");
    expect(after).not.toBe(before);
    expect(JSON.parse(after).dependencies).toHaveProperty(name);
  }, 300_000);
});

describe("an ecosystem IWOMC does not natively support", () => {
  let sandbox: Sandbox;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    sandbox = await createSandbox({ IWOMC_DISABLE_MEMORY: "1" });
  });

  afterAll(async () => {
    await cleanup?.();
    await sandbox?.cleanup();
  });

  it("captures evidence and reports observe_only instead of guessing a command", async () => {
    const project = await createRecipeProject({ root: sandbox.home });
    cleanup = project.cleanup;

    await runIwomc(["init", "--proof", "git --version", "--json"], { cwd: project.dir, env: sandbox.env });
    const result = await runIwomc(["capture", "--json"], { cwd: project.dir, env: sandbox.env });
    expect(result.exitCode).toBe(EXIT.unsupported);
    const payload = result.json<{ contract: unknown; support: string; supportReason: string; blockers: string[] }>();
    expect(payload.contract).toBeNull();
    expect(payload.support).toBe("observe_only");
    expect(payload.blockers.join(" ")).toContain("No adapter can materialize this project");

    const rescue = await runIwomc(["rescue", "--json", "--approve"], { cwd: project.dir, env: sandbox.env });
    expect(rescue.exitCode).toBe(EXIT.blocked);
    expect(rescue.json<{ blocker: { code: string } }>().blocker.code).toBe("no_contract_for_revision");
  }, 300_000);
});

describe("a project whose proof command does not pass", () => {
  let sandbox: Sandbox;
  let project: NodeProjectResult;

  beforeAll(async () => {
    sandbox = await createSandbox({ IWOMC_DISABLE_MEMORY: "1" });
    project = await createNodeProject({ root: sandbox.home });
  }, 900_000);

  afterAll(async () => {
    await project?.cleanup();
    await sandbox?.cleanup();
  });

  it("reports failed, not working, when the environment installs but the check fails", async () => {
    // Point the proof at a command that exists and always fails, so the
    // environment work succeeds and only the project's own check does not.
    await runIwomc(["init", "--proof", "node ./scripts/fail.mjs", "--json"], {
      cwd: project.dir,
      env: sandbox.env,
    });
    await mkdir(join(project.dir, "scripts"), { recursive: true });
    await writeFile(
      join(project.dir, "scripts", "fail.mjs"),
      "console.error('the project itself is not healthy');\nprocess.exit(3);\n",
      "utf8",
    );
    await run(["git", "add", "-A"], { cwd: project.dir, timeoutMs: 60_000, envAllowlist: null });
    await run(["git", "commit", "--quiet", "--no-gpg-sign", "-m", "add failing check"], {
      cwd: project.dir,
      timeoutMs: 60_000,
      envAllowlist: null,
    });
    // The second checkout is cloned from the origin, so the revision under test
    // has to exist there too.
    await run(["git", "push", "--quiet", "origin", "main"], {
      cwd: project.dir,
      timeoutMs: 120_000,
      envAllowlist: null,
    });

    await runIwomc(["capture", "--json"], { cwd: project.dir, env: sandbox.env });
    await runIwomc(["approve", ...(await newestContractId(project.dir, sandbox)), "--json"], {
      cwd: project.dir,
      env: sandbox.env,
    });

    const broken = await project.clone();
    await runIwomc(["init", "--json"], { cwd: broken, env: sandbox.env });
    const result = await runIwomc(["rescue", "--json", "--approve"], { cwd: broken, env: sandbox.env });

    expect(result.exitCode).toBe(EXIT.failed);
    const payload = result.json<{ state: string; proof: { exitCode: number }; blocker: { code: string } }>();
    expect(payload.state).toBe("failed");
    expect(payload.proof.exitCode).toBe(3);
    expect(payload.blocker.code).toBe("proof_failed");

    await rm(join(broken, "node_modules"), { recursive: true, force: true }).catch(() => undefined);
  }, 900_000);
});

async function newestContractId(dir: string, sandbox: Sandbox): Promise<string[]> {
  const status = await runIwomc(["status", "--json"], { cwd: dir, env: sandbox.env });
  const payload = status.json<{ contracts: { id: string }[] }>();
  const id = payload.contracts[0]?.id;
  return id ? [id] : [];
}

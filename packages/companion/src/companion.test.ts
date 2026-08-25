import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeyPair, sealContract, signContract, type MaterializationStep } from "@iwomc/contracts";
import { defaultRegistry } from "@iwomc/adapters";
import { parseCommandLine, formatCommand, UnsafeCommandError } from "./command.js";
import {
  resolveInsideManagedDir,
  resolveInsideProject,
  iwomcHome,
  MANAGED_DIR,
  excludeManagedDirLocally,
} from "./paths.js";
import { canonicalizeRemote, remoteDigest, subdirectoryOf } from "./git.js";
import { buildEnvironment, run } from "./exec.js";
import { buildCmdCommandLine, planSpawn, quoteForCommandLine, UnsafeBatchArgumentError } from "./windows-shim.js";
import { CompanionStore } from "./store.js";
import { ensureDeviceIdentity, currentPlatform } from "./identity.js";
import { materialize } from "./materialize.js";
import { draftProofCommand, runProof } from "./proof.js";

const NOW = "2026-08-23T05:00:00.000Z";
const DIGEST = `sha256:${"d".repeat(64)}`;

describe("command parsing", () => {
  it("tokenizes a command without a shell", () => {
    expect(parseCommandLine("npm run proof")).toEqual(["npm", "run", "proof"]);
    expect(parseCommandLine('node -e "console.log(1)"')).toEqual(["node", "-e", "console.log(1)"]);
    expect(parseCommandLine("pytest 'tests/my dir'")).toEqual(["pytest", "tests/my dir"]);
  });

  it("refuses anything a shell would reinterpret", () => {
    for (const bad of ["npm test | tee out", "a && b", "rm -rf $(pwd)", "echo `id`", "a > b", "a; b"]) {
      expect(() => parseCommandLine(bad), bad).toThrow(UnsafeCommandError);
    }
  });

  it("refuses an empty command", () => {
    expect(() => parseCommandLine("   ")).toThrow(UnsafeCommandError);
  });

  it("round-trips through a readable single line", () => {
    expect(formatCommand(["npm", "run", "my proof"])).toBe('npm run "my proof"');
  });
});

describe("path guards", () => {
  const project = process.platform === "win32" ? "C:\\project" : "/project";

  it("keeps a relative path inside the project", () => {
    expect(resolveInsideProject(project, "package.json")).not.toBeNull();
    expect(resolveInsideProject(project, "src/index.ts")).not.toBeNull();
  });

  it("refuses anything that escapes the project", () => {
    for (const bad of ["../elsewhere", "../../etc/passwd", "sub/../../../out"]) {
      expect(resolveInsideProject(project, bad), bad).toBeNull();
    }
  });

  it("confines managed writes to the managed directory", () => {
    expect(resolveInsideManagedDir(project, `${MANAGED_DIR}/cache/x`)).not.toBeNull();
    expect(resolveInsideManagedDir(project, "package.json")).toBeNull();
    expect(resolveInsideManagedDir(project, `${MANAGED_DIR}/../package.json`)).toBeNull();
  });

  it("keeps every device file under one root", () => {
    expect(iwomcHome({ IWOMC_HOME: project })).toBe(resolveInsideProject(project, ".") ?? project);
  });
});

describe("git identity", () => {
  it("fingerprints the same repository through every URL form", () => {
    const forms = [
      "https://github.com/acme/widget.git",
      "https://github.com/acme/widget",
      "git@github.com:acme/widget.git",
      "ssh://git@github.com/acme/widget.git",
      "https://GitHub.com/ACME/Widget.git",
    ];
    const digests = new Set(forms.map((url) => remoteDigest(canonicalizeRemote(url))));
    expect(digests.size, `expected one fingerprint, saw ${[...digests].join(", ")}`).toBe(1);
  });

  it("does not fingerprint credentials embedded in a URL", () => {
    const withCredentials = canonicalizeRemote("https://user:hunter2@github.com/acme/widget.git");
    const without = canonicalizeRemote("https://github.com/acme/widget.git");
    expect(withCredentials).toBe(without);
    expect(withCredentials).not.toContain("hunter2");
  });

  it("separates different repositories", () => {
    expect(remoteDigest(canonicalizeRemote("https://github.com/acme/one"))).not.toBe(
      remoteDigest(canonicalizeRemote("https://github.com/acme/two")),
    );

    // Without a remote, two different repositories must still be two different
    // projects. They used to share one constant fingerprint, which meant one
    // local-only project could be offered another's contracts.
    expect(remoteDigest(null, { rootCommit: "a".repeat(40) })).not.toBe(
      remoteDigest(null, { rootCommit: "b".repeat(40) }),
    );
    // A repository with no commits at all falls back to its path.
    expect(remoteDigest(null, { projectDir: "/work/one" })).not.toBe(
      remoteDigest(null, { projectDir: "/work/two" }),
    );
    // And the root commit wins over the path, so moving a folder keeps its
    // identity.
    expect(remoteDigest(null, { rootCommit: "c".repeat(40), projectDir: "/work/here" })).toBe(
      remoteDigest(null, { rootCommit: "c".repeat(40), projectDir: "/work/moved" }),
    );
  });

  it("resolves a subdirectory relative to the repository root", () => {
    expect(subdirectoryOf("/repo", "/repo")).toBe(".");
    expect(subdirectoryOf("/repo", "/repo/apps/api")).toBe("apps/api");
    expect(subdirectoryOf("/repo", "/elsewhere")).toBe(".");
  });
});

describe("process execution", () => {
  it("passes only the allowlisted environment plus what a process needs", () => {
    const env = buildEnvironment(["MY_TOKEN"], {}, { MY_TOKEN: "x", OTHER: "y", PATH: "/usr/bin" });
    expect(env["MY_TOKEN"]).toBe("x");
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["OTHER"]).toBeUndefined();
  });

  it("reports a missing executable rather than throwing", async () => {
    const result = await run(["iwomc-definitely-not-installed"], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      envAllowlist: null,
    });
    expect(result.notFound).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("captures an exit code from a real process", async () => {
    const result = await run([process.execPath, "-e", "process.exit(7)"], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
      envAllowlist: null,
    });
    expect(result.exitCode).toBe(7);
  });

  it("enforces its timeout", async () => {
    const result = await run([process.execPath, "-e", "setTimeout(() => {}, 60000)"], {
      cwd: process.cwd(),
      timeoutMs: 1_500,
      envAllowlist: null,
    });
    expect(result.timedOut).toBe(true);
  });

  it("caps captured output", async () => {
    const result = await run(
      [process.execPath, "-e", "for (let i = 0; i < 20000; i += 1) console.log('x'.repeat(80))"],
      { cwd: process.cwd(), timeoutMs: 60_000, envAllowlist: null, maxOutputBytes: 4096 },
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(6000);
  });

  it("redacts credential-shaped output before it is stored", async () => {
    const result = await run(
      [process.execPath, "-e", "console.log('token=ghp_0123456789abcdefghijklmnopqrstuvwxyz')"],
      { cwd: process.cwd(), timeoutMs: 30_000, envAllowlist: null },
    );
    expect(result.stdout).not.toContain("ghp_0123456789");
    expect(result.stdout).toContain("[redacted]");
  });
});

describe("windows batch shims", () => {
  it("quotes arguments the way the C runtime parses them back", () => {
    expect(quoteForCommandLine("simple")).toBe("simple");
    expect(quoteForCommandLine("with space")).toBe('"with space"');
    expect(quoteForCommandLine('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("refuses a batch argument cmd.exe would expand", () => {
    expect(() => buildCmdCommandLine("C:\\tools\\thing.cmd", ["%PATH%"])).toThrow(UnsafeBatchArgumentError);
  });

  it("keeps the executable quoted so a spaced path survives", () => {
    const line = buildCmdCommandLine("C:\\Program Files\\tool\\run.cmd", ["build"]);
    expect(line.startsWith("/d /s /c ")).toBe(true);
    expect(line).toContain('"C:\\Program Files\\tool\\run.cmd"');
  });

  it("leaves non-batch executables alone on every platform", () => {
    const plan = planSpawn("/usr/bin/node", ["-v"], "linux");
    expect(plan.strategy).toBe("direct");
    expect(plan.windowsVerbatimArguments).toBe(false);
  });
});

describe("the local store", () => {
  let home: string;
  let store: CompanionStore;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "iwomc-store-"));
    store = CompanionStore.openAt(join(home, "s.sqlite"), join(home, "k"));
  });

  afterEach(async () => {
    store.close();
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it("keeps the device private key out of the database in plaintext", async () => {
    const identity = ensureDeviceIdentity(store, () => NOW);
    expect(identity.keyPair.privateKeyPem).toContain("PRIVATE KEY");

    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(join(home, "s.sqlite"));
    expect(bytes.includes(Buffer.from("BEGIN PRIVATE KEY"))).toBe(false);

    // It still round-trips for the process that owns the key file.
    const reopened = CompanionStore.openAt(join(home, "s.sqlite"), join(home, "k"));
    expect(reopened.loadDevice()?.privateKeyPem).toBe(identity.keyPair.privateKeyPem);
    reopened.close();
  });

  it("keeps exactly one device row when enrollment replaces the local id", () => {
    const identity = ensureDeviceIdentity(store, () => NOW);

    // Enrollment gives this machine the id the control plane issued. The row is
    // replaced, not duplicated, or `loadDevice` would pick an arbitrary one.
    store.saveDevice({
      id: "control-plane-issued-id",
      personId: "github:1234",
      displayName: identity.displayName,
      publicKey: identity.publicKey,
      privateKeyPem: identity.keyPair.privateKeyPem,
      state: "active",
      enrolledAt: identity.enrolledAt,
      platformOs: identity.platform.os,
      platformArch: identity.platform.arch,
      workspaceId: "workspace-1",
    });

    const loaded = store.loadDevice();
    expect(loaded?.id).toBe("control-plane-issued-id");
    expect(loaded?.workspaceId).toBe("workspace-1");
    expect(loaded?.personId).toBe("github:1234");
    // The private key survived the replacement.
    expect(loaded?.privateKeyPem).toBe(identity.keyPair.privateKeyPem);
  });

  it("chains the local audit log", () => {
    store.appendAudit({ id: "1", workspaceId: null, at: NOW, actor: "a", action: "x", subject: "s", detail: {} });
    store.appendAudit({ id: "2", workspaceId: null, at: NOW, actor: "a", action: "y", subject: "s", detail: {} });
    expect(store.verifyAuditChain().ok).toBe(true);
    const events = store.listAudit();
    expect(events[0]?.previousDigest).toBe(events[1]?.digest);
  });

  it("remembers which idempotency keys already succeeded, per checkout", () => {
    store.createRun({
      id: "run-1",
      projectId: "p",
      contractId: "c",
      commit: "a".repeat(40),
      checkoutPath: "/work/one",
      state: "requested",
      startedAt: NOW,
    });
    store.appendJournal({ runId: "run-1", seq: 0, at: NOW, stepId: "s1", idempotencyKey: "key-1", phase: "succeeded", detail: {} });
    store.appendJournal({ runId: "run-1", seq: 1, at: NOW, stepId: "s2", idempotencyKey: "key-2", phase: "failed", detail: {} });

    const done = store.completedIdempotencyKeys("p", "c", "/work/one");
    expect(done.has("key-1")).toBe(true);
    // A step that failed was not applied, so a resume must run it again.
    expect(done.has("key-2")).toBe(false);

    // Two checkouts of one project can sit side by side. Work applied to one
    // has plainly not been applied to the other, and treating it as done would
    // make the second rescue install nothing while reporting success.
    const elsewhere = store.completedIdempotencyKeys("p", "c", "/work/two");
    expect(elsewhere.has("key-1")).toBe(false);
  });

  it("tracks spend as an append-only ledger", () => {
    store.recordSpend({ id: "1", provider: "modal", amountUsd: 0.25, at: NOW, reference: "r" });
    store.recordSpend({ id: "2", provider: "modal", amountUsd: 0.25, at: NOW, reference: "r" });
    expect(store.totalSpend("modal")).toBeCloseTo(0.5, 6);
    expect(store.totalSpend("other")).toBe(0);
  });
});

describe("the materialization executor", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "iwomc-mat-"));
    await mkdir(join(dir, MANAGED_DIR), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  function contractWithStep(step: MaterializationStep) {
    const keys = generateDeviceKeyPair();
    const sealed = sealContract({
      schemaVersion: 1,
      id: "c",
      workspaceId: null,
      projectId: "p",
      source: {
        commit: "a".repeat(40),
        canonicalRemoteDigest: DIGEST,
        subdirectory: ".",
        declaredFileDigests: [],
        worktreeDirty: false,
      },
      targets: [{ os: currentPlatform().os, arch: currentPlatform().arch }],
      support: "native",
      requirements: { runtimes: [], packages: [], systemTools: [], secrets: [] },
      steps: [step],
      proof: {
        id: "proof",
        argv: ["node", "--version"],
        workDir: ".",
        timeoutMs: 30_000,
        expectedExitCodes: [0],
        envAllowlist: [],
        description: "check",
        maxOutputBytes: 4096,
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
      authoredBy: { deviceId: "d", identity: "i" },
    });
    return signContract(sealed, keys, "device", NOW);
  }

  async function runSteps(step: MaterializationStep, trackedPaths: string[] = []) {
    return await materialize({
      contract: contractWithStep(step),
      registry: defaultRegistry(),
      context: {
        projectDir: dir,
        files: { entries: [], read: async () => null, exists: async () => false },
        platform: currentPlatform(),
        probe: async () => ({ ok: false, exitCode: null, stdout: "", stderr: "", timedOut: false, notFound: true }),
        managedDir: MANAGED_DIR,
        availableSecretNames: [],
      },
      completedKeys: new Set(),
      emit: () => {},
      journal: () => {},
      trackedPaths: new Set(trackedPaths),
    });
  }

  it("refuses to write outside the managed directory", async () => {
    const result = await runSteps({
      id: "w",
      kind: "write_project_local_file",
      adapterId: "node.npm",
      workDir: ".",
      idempotencyKey: "k".repeat(10),
      description: "write",
      path: "package.json",
      content: "{}",
      contentDigest: DIGEST,
    });
    expect(result.blocker?.code).toBe("policy_denied");
    expect(result.blocker?.message).toContain(MANAGED_DIR);
  });

  it("refuses content that does not match its digest", async () => {
    const result = await runSteps({
      id: "w",
      kind: "write_project_local_file",
      adapterId: "node.npm",
      workDir: ".",
      idempotencyKey: "k".repeat(10),
      description: "write",
      path: `${MANAGED_DIR}/note.txt`,
      content: "hello",
      contentDigest: DIGEST,
    });
    expect(result.blocker?.code).toBe("signature_invalid");
  });

  it("refuses to create an environment over a tracked path", async () => {
    const result = await runSteps(
      {
        id: "v",
        kind: "create_virtual_environment",
        adapterId: "python.pip",
        workDir: ".",
        idempotencyKey: "k".repeat(10),
        description: "venv",
        manager: "venv",
        path: "vendor",
        runtimeSpec: "*",
      },
      ["vendor"],
    );
    expect(result.blocker?.code).toBe("policy_denied");
    expect(result.blocker?.message).toContain("tracked by Git");
  });

  it("blocks on a runtime that is not present", async () => {
    const result = await runSteps({
      id: "r",
      kind: "ensure_runtime",
      adapterId: "node.npm",
      workDir: ".",
      idempotencyKey: "k".repeat(10),
      description: "runtime",
      runtime: "definitely-not-a-runtime",
      versionSpec: ">=1",
      strategy: "probe",
      probeArgv: ["definitely-not-a-runtime", "--version"],
    });
    expect(result.blocker?.code).toBe("missing_runtime");
    expect(result.blocker?.nextAction).toContain("Install");
  });

  it("refuses a recipe whose command no longer matches its review", async () => {
    const { commandDigest } = await import("@iwomc/contracts");
    const argv = ["node", "--version"];
    const good: MaterializationStep = {
      id: "recipe",
      kind: "run_reviewed_recipe",
      adapterId: "generic.recipe",
      workDir: ".",
      idempotencyKey: "k".repeat(10),
      description: "setup",
      argv,
      commandDigest: commandDigest(argv),
      envAllowlist: ["PATH"],
      timeoutMs: 30_000,
      expectedExitCodes: [0],
      review: { reviewedBy: "someone", reviewedAt: NOW, approvedCommandDigest: commandDigest(argv) },
    };
    // Sealing already refuses this, so tamper with the sealed contract the way
    // a modified payload arriving over the wire would, and prove the executor
    // catches it too.
    const contract = contractWithStep(good);
    const tampered = {
      ...contract,
      steps: [{ ...good, review: { ...good.review, approvedCommandDigest: `sha256:${"e".repeat(64)}` } }],
    };

    const result = await materialize({
      contract: tampered,
      registry: defaultRegistry(),
      context: {
        projectDir: dir,
        files: { entries: [], read: async () => null, exists: async () => false },
        platform: currentPlatform(),
        probe: async () => ({ ok: false, exitCode: null, stdout: "", stderr: "", timedOut: false, notFound: true }),
        managedDir: MANAGED_DIR,
        availableSecretNames: [],
      },
      completedKeys: new Set(),
      emit: () => {},
      journal: () => {},
      trackedPaths: new Set(),
    });
    expect(result.blocker?.code).toBe("recipe_not_reviewed");
  });

  it("refuses to seal a contract whose recipe was modified after review", async () => {
    const { commandDigest } = await import("@iwomc/contracts");
    const argv = ["node", "--version"];
    expect(() =>
      contractWithStep({
        id: "recipe",
        kind: "run_reviewed_recipe",
        adapterId: "generic.recipe",
        workDir: ".",
        idempotencyKey: "k".repeat(10),
        description: "setup",
        argv,
        commandDigest: commandDigest(argv),
        envAllowlist: ["PATH"],
        timeoutMs: 30_000,
        expectedExitCodes: [0],
        review: { reviewedBy: "someone", reviewedAt: NOW, approvedCommandDigest: `sha256:${"e".repeat(64)}` },
      }),
    ).toThrow(/approved command digest/u);
  });

  it("writes a managed file when everything checks out", async () => {
    const { digestBytes } = await import("@iwomc/contracts");
    const content = "managed by IWOMC\n";
    const result = await runSteps({
      id: "w",
      kind: "write_project_local_file",
      adapterId: "node.npm",
      workDir: ".",
      idempotencyKey: "k".repeat(10),
      description: "write",
      path: `${MANAGED_DIR}/note.txt`,
      content,
      contentDigest: digestBytes(content),
    });
    expect(result.blocker).toBeNull();
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(dir, MANAGED_DIR, "note.txt"), "utf8")).toBe(content);
  });
});

describe("proof execution", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "iwomc-proof-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("passes only when the command exits as expected", async () => {
    await writeFile(join(dir, "ok.mjs"), "process.exit(0)\n", "utf8");
    const proof = draftProofCommand({ commandLine: `${JSON.stringify(process.execPath)} ok.mjs` });
    const result = await runProof({ proof, projectDir: dir, assurance: "locally_checked" });
    expect(result.passed).toBe(true);
    expect(result.attempt.assurance).toBe("locally_checked");
  });

  it("reports a failing proof as unverified with a next action", async () => {
    await writeFile(join(dir, "bad.mjs"), "process.exit(4)\n", "utf8");
    const proof = draftProofCommand({ commandLine: `${JSON.stringify(process.execPath)} bad.mjs` });
    const result = await runProof({ proof, projectDir: dir, assurance: "locally_checked" });
    expect(result.passed).toBe(false);
    expect(result.attempt.exitCode).toBe(4);
    expect(result.attempt.assurance).toBe("unverified");
    expect(result.blocker?.code).toBe("proof_failed");
    expect(result.blocker?.nextAction).toContain("environment was prepared");
  });

  it("reports a timeout distinctly from a failure", async () => {
    await writeFile(join(dir, "slow.mjs"), "setTimeout(() => {}, 60000)\n", "utf8");
    const proof = draftProofCommand({
      commandLine: `${JSON.stringify(process.execPath)} slow.mjs`,
      timeoutMs: 1_500,
    });
    const result = await runProof({ proof, projectDir: dir, assurance: "locally_checked" });
    expect(result.attempt.timedOut).toBe(true);
    expect(result.blocker?.code).toBe("proof_timeout");
  }, 30_000);

  it("refuses a proof whose working directory escapes the checkout", async () => {
    const proof = { ...draftProofCommand({ commandLine: "node --version" }), workDir: ".." };
    const result = await runProof({ proof, projectDir: dir, assurance: "locally_checked" });
    expect(result.passed).toBe(false);
    expect(result.blocker?.code).toBe("policy_denied");
  });
});

describe("keeping IWOMC's own directory out of the way", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "iwomc-exclude-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("excludes .iwomc locally rather than editing a tracked .gitignore", async () => {
    // .iwomc holds this project's package caches, so on a Rust or Go project
    // it is large. It must not turn up as untracked noise, and IWOMC must not
    // change a file the repository tracks in order to hide it.
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".gitignore"), "node_modules/\n", "utf8");

    expect(await excludeManagedDirLocally(dir)).toBe(true);

    const exclude = await readFile(join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(`/${MANAGED_DIR}/`);
    // The tracked file is exactly as the person left it.
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n");
  });

  it("does not write the same line twice", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    expect(await excludeManagedDirLocally(dir)).toBe(true);
    expect(await excludeManagedDirLocally(dir)).toBe(false);
    const exclude = await readFile(join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude.split(`/${MANAGED_DIR}/`).length - 1).toBe(1);
  });

  it("respects a line the person already wrote", async () => {
    await mkdir(join(dir, ".git", "info"), { recursive: true });
    await writeFile(join(dir, ".git", "info", "exclude"), `${MANAGED_DIR}/\n`, "utf8");
    expect(await excludeManagedDirLocally(dir)).toBe(false);
  });

  it("keeps whatever was already in the exclude file", async () => {
    await mkdir(join(dir, ".git", "info"), { recursive: true });
    // No trailing newline: appending carelessly would corrupt the last entry.
    await writeFile(join(dir, ".git", "info", "exclude"), "*.log", "utf8");
    expect(await excludeManagedDirLocally(dir)).toBe(true);
    const lines = (await readFile(join(dir, ".git", "info", "exclude"), "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines).toContain("*.log");
    expect(lines).toContain(`/${MANAGED_DIR}/`);
  });

  it("does nothing outside a git repository, and does not fail", async () => {
    // A worktree or submodule has a .git file rather than a directory. Guessing
    // at the real git directory would mean writing outside this folder.
    expect(await excludeManagedDirLocally(dir)).toBe(false);
    await writeFile(join(dir, ".git"), "gitdir: ../elsewhere/.git\n", "utf8");
    expect(await excludeManagedDirLocally(dir)).toBe(false);
  });
});

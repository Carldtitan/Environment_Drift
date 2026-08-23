import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callMcp, createNodeProject, createSandbox, runIwomc, type NodeProjectResult, type Sandbox } from "@iwomc/testkit";
import { run } from "@iwomc/companion";

/**
 * The agent surface (task 5.2, 10.3).
 *
 * A coding agent drives the same Companion the CLI drives, so a tool result and
 * a command result must agree. These tests speak JSON-RPC over stdio exactly as
 * an MCP client would.
 */

interface JsonRpcResponse {
  id?: number;
  result?: {
    tools?: { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }[];
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    instructions?: string;
    protocolVersion?: string;
    contents?: { text: string }[];
  };
  error?: { code: number; message: string };
}

function responsesById(messages: unknown[]): Map<number, JsonRpcResponse> {
  const out = new Map<number, JsonRpcResponse>();
  for (const message of messages as JsonRpcResponse[]) {
    if (typeof message.id === "number") out.set(message.id, message);
  }
  return out;
}

describe("the local MCP server", () => {
  let sandbox: Sandbox;
  let project: NodeProjectResult;
  let broken: string;

  beforeAll(async () => {
    sandbox = await createSandbox({ IWOMC_DISABLE_MEMORY: "1" });
    project = await createNodeProject({ root: sandbox.home });
    broken = await project.clone();
    await runIwomc(["init", "--proof", "npm run proof", "--json"], { cwd: project.dir, env: sandbox.env });
  }, 900_000);

  afterAll(async () => {
    await project?.cleanup();
    await sandbox?.cleanup();
  });

  it("announces itself with the workflow an agent needs", async () => {
    const messages = await callMcp(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
      { cwd: project.dir, env: sandbox.env },
    );
    const byId = responsesById(messages);

    const init = byId.get(1)?.result;
    expect(init?.protocolVersion).toBeTruthy();
    expect(init?.instructions).toContain("iwomc capture");
    expect(init?.instructions).toContain("working");

    const tools = byId.get(2)?.result?.tools ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "capture_environment",
        "diagnose_environment",
        "environment_status",
        "promote_repair",
        "rescue_environment",
        "verify_contract",
      ].sort(),
    );

    // Every tool description states its effects and its failure conditions.
    for (const tool of tools) {
      expect(tool.description.length, `${tool.name} needs a real description`).toBeGreaterThan(120);
    }
    const rescue = tools.find((tool) => tool.name === "rescue_environment");
    expect(rescue?.description).toContain("MUTATING");
    expect(rescue?.description).toContain("never edits a tracked file");
    expect(rescue?.annotations?.["readOnlyHint"]).toBe(false);
    expect((rescue?.inputSchema as { required?: string[] }).required).toContain("confirm");

    const status = tools.find((tool) => tool.name === "environment_status");
    expect(status?.annotations?.["readOnlyHint"]).toBe(true);
  }, 300_000);

  it("publishes its versioned workflow documentation as a resource", async () => {
    const messages = await callMcp(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "resources/list" },
        { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "iwomc://agent-guide" } },
      ],
      { cwd: project.dir, env: sandbox.env },
    );
    const byId = responsesById(messages);
    const guide = byId.get(3)?.result?.contents?.[0]?.text ?? "";
    expect(guide).toContain("BLOCKER CODES");
    expect(guide).toContain("TERMINAL STATES");
  }, 300_000);

  it("refuses a mutating tool without an explicit confirmation", async () => {
    const messages = await callMcp(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "rescue_environment", arguments: { dir: broken } },
        },
      ],
      { cwd: broken, env: sandbox.env },
    );
    const result = responsesById(messages).get(2)?.result;
    expect(result?.isError).toBe(true);
    const blocker = (result?.structuredContent as { blocker: { code: string; nextAction: string } }).blocker;
    expect(blocker.code).toBe("approval_required");
    expect(blocker.nextAction).toContain("confirm: true");
  }, 300_000);

  it("captures, verifies, and rescues through typed tools", async () => {
    const messages = await callMcp(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "capture_environment", arguments: { dir: project.dir } },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "verify_contract", arguments: { dir: project.dir } },
        },
      ],
      { cwd: project.dir, env: sandbox.env },
    );
    const byId = responsesById(messages);

    const capture = byId.get(2)?.result?.structuredContent as {
      contract: { state: string; support: string } | null;
      coverage: unknown[];
    };
    expect(capture.contract?.support).toBe("native");
    expect(capture.coverage.length).toBeGreaterThan(0);

    const verify = byId.get(3)?.result?.structuredContent as {
      attestation: { state: string; assurance: string } | null;
    };
    expect(verify.attestation?.state).toBe("passed");
    expect(verify.attestation?.assurance).toBe("locally_checked");
  }, 900_000);

  it("rescues the broken checkout and reports the same result the CLI would", async () => {
    await runIwomc(["init", "--json"], { cwd: broken, env: sandbox.env });

    const messages = await callMcp(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "rescue_environment", arguments: { dir: broken, confirm: true } },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "environment_status", arguments: { dir: broken } },
        },
      ],
      { cwd: broken, env: sandbox.env },
    );
    const byId = responsesById(messages);

    const rescue = byId.get(2)?.result?.structuredContent as {
      state: string;
      runId: string;
      proof: { exitCode: number } | null;
      blocker: unknown;
    };
    expect(rescue.state).toBe("working");
    expect(rescue.proof?.exitCode).toBe(0);
    expect(rescue.blocker).toBeNull();

    // The project really does work now.
    const proof = await run(["npm", "run", "proof"], { cwd: broken, timeoutMs: 120_000, envAllowlist: null });
    expect(proof.exitCode).toBe(0);

    // The agent's view and the CLI's view agree on the same run.
    const status = byId.get(3)?.result?.structuredContent as {
      recentRuns: { id: string; state: string }[];
    };
    expect(status.recentRuns[0]?.id).toBe(rescue.runId);
    expect(status.recentRuns[0]?.state).toBe("working");

    const cli = await runIwomc(["status", "--json"], { cwd: broken, env: sandbox.env });
    const cliStatus = cli.json<{ recentRuns: { id: string; state: string }[] }>();
    expect(cliStatus.recentRuns[0]?.id).toBe(rescue.runId);
    expect(cliStatus.recentRuns[0]?.state).toBe("working");
  }, 900_000);

  it("names an unknown tool instead of guessing", async () => {
    const messages = await callMcp(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "make_it_work", arguments: {} } },
      ],
      { cwd: project.dir, env: sandbox.env },
    );
    const response = responsesById(messages).get(2);
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).toContain("make_it_work");
  }, 300_000);
});

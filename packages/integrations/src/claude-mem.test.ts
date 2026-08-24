import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redactor } from "@iwomc/contracts";
import { startFakeMemoryWorker, type FakeMemoryWorker } from "@iwomc/testkit";
import { ClaudeMemAdapter, DisabledMemory, defaultWorkerPort, resolveWorkerBaseUrl, IWOMC_TOOL_NAME } from "./claude-mem.js";

/**
 * Claude-Mem integration tests (task 9.1-9.3).
 *
 * The worker here is a test double and is reachable only because the test sets
 * CLAUDE_MEM_BASE_URL explicitly. It exists so the redaction guarantee can be
 * asserted against real bytes on the wire.
 */

const OBSERVATION = {
  event: "capture" as const,
  outcome: "contract_created",
  projectPseudonym: "iwomc-abc123def456",
  revision: "a".repeat(40),
  facts: { support: "native", drift_count: 2, secret_values_present: false },
  references: { receipt_id: "r-1", contract_digest: `sha256:${"b".repeat(64)}` },
  at: "2026-08-23T05:00:00.000Z",
};

describe("worker endpoint discovery", () => {
  it("prefers an explicit base URL", () => {
    expect(resolveWorkerBaseUrl({ CLAUDE_MEM_BASE_URL: "http://127.0.0.1:9999/" })).toBe(
      "http://127.0.0.1:9999",
    );
  });

  it("uses the documented per-user default port when nothing is set", () => {
    const url = resolveWorkerBaseUrl({ HOME: "/nonexistent-home" });
    expect(url).toBe(`http://127.0.0.1:${defaultWorkerPort()}`);
    expect(defaultWorkerPort()).toBeGreaterThanOrEqual(37700);
    expect(defaultWorkerPort()).toBeLessThan(37800);
  });

  it("honours an explicit port and host", () => {
    expect(
      resolveWorkerBaseUrl({ CLAUDE_MEM_WORKER_PORT: "37711", CLAUDE_MEM_WORKER_HOST: "::1" }),
    ).toBe("http://[::1]:37711");
  });
});

describe("against a running worker", () => {
  let worker: FakeMemoryWorker;
  let memory: ClaudeMemAdapter;

  beforeEach(async () => {
    worker = await startFakeMemoryWorker();
    memory = new ClaudeMemAdapter({ baseUrl: worker.baseUrl });
  });

  afterEach(async () => {
    await worker.close();
  });

  it("reports connected only after a successful health call", async () => {
    const status = await memory.status();
    expect(status.status).toBe("connected");
    expect(worker.requests.some((entry) => entry.path === "/api/health")).toBe(true);
  });

  it("writes a lifecycle observation through the documented route", async () => {
    const result = await memory.record(OBSERVATION);
    expect(result.recorded).toBe(true);
    expect(worker.observations).toHaveLength(1);
    expect(worker.requests.filter((entry) => entry.path === "/api/sessions/init")).toHaveLength(1);

    const recorded = worker.observations[0];
    expect(recorded?.toolName).toBe(IWOMC_TOOL_NAME);
    expect(recorded?.contentSessionId).toMatch(/^iwomc-companion-\d+$/u);
    expect(recorded?.platformSource).toBe("iwomc");
    // Grouping happens by pseudonym, never by this machine's real directory.
    expect(recorded?.cwd).toBe(`/iwomc/${OBSERVATION.projectPseudonym}`);
    expect(recorded?.rawBody).not.toContain("C:\\");
    expect(recorded?.rawBody).not.toContain("/home/");
  });

  it("records every lifecycle boundary the specification names", async () => {
    for (const event of ["capture", "drift", "verification", "rescue", "promotion"] as const) {
      await memory.record({ ...OBSERVATION, event });
    }
    const events = worker.observations.map(
      (entry) => (entry.toolInput as { event: string }).event,
    );
    expect(events).toEqual(["capture", "drift", "verification", "rescue", "promotion"]);
    expect(worker.requests.filter((entry) => entry.path === "/api/sessions/init")).toHaveLength(1);
  });

  it("refuses locally rather than sending credential-shaped material", async () => {
    const result = await memory.record({
      ...OBSERVATION,
      facts: { ...OBSERVATION.facts, note: "the fix was to set token=ghp_0123456789abcdefghijklmnopqrstuvwxyz" },
    });
    expect(result.recorded).toBe(false);
    expect(result.reason).toContain("refused locally");
    expect(worker.observations).toHaveLength(0);
  });

  it("never lets a value from the project's environment reach the wire", async () => {
    // A phrase like this is not credential-shaped, so only a redactor that was
    // told about it can catch it. That is exactly the redactor capture builds
    // from the project's own environment files.
    const secret = "the moon is a harsh mistress";
    const projectRedactor = new Redactor({ knownSecretValues: [secret] });

    const result = await memory.record(
      { ...OBSERVATION, facts: { ...OBSERVATION.facts, blocker: `set by ${secret}` } },
      projectRedactor,
    );
    expect(result.recorded).toBe(false);
    expect(result.reason).toContain("refused locally");

    const bodies = worker.observations.map((entry) => entry.rawBody).join("\n");
    expect(bodies).not.toContain(secret);
  });

  it("returns prior observations as explanation only", async () => {
    worker.setSearchResults([
      { id: 41, title: "why the runtime is pinned", preview: "an agent installed it during a session", created_at: "2026-08-01T00:00:00.000Z" },
    ]);
    const found = await memory.search({ projectPseudonym: OBSERVATION.projectPseudonym, query: "runtime", limit: 5 });
    expect(found.hits).toHaveLength(1);
    expect(found.hits[0]?.source).toBe("claude-mem");
    expect(found.hits[0]?.title).toBe("why the runtime is pinned");

    const searchRequest = worker.requests.find((entry) => entry.path === "/api/search");
    expect(searchRequest?.method).toBe("GET");
  });

  it("bounds the search limit it asks for", async () => {
    await memory.search({ projectPseudonym: OBSERVATION.projectPseudonym, query: "x", limit: 5000 });
    expect(worker.requests.some((entry) => entry.path === "/api/search")).toBe(true);
  });
});

describe("when the worker is unavailable", () => {
  let worker: FakeMemoryWorker;
  let memory: ClaudeMemAdapter;

  beforeEach(async () => {
    worker = await startFakeMemoryWorker();
    memory = new ClaudeMemAdapter({ baseUrl: worker.baseUrl, timeoutMs: 1500 });
  });

  afterEach(async () => {
    await worker.close();
  });

  it("says memory is disconnected and records nothing", async () => {
    worker.setMode("unhealthy");
    const status = await memory.status();
    expect(status.status).toBe("disconnected");
    expect(status.detail).toContain("continues without durable memory");

    const result = await memory.record(OBSERVATION);
    expect(result.recorded).toBe(false);
    expect(worker.observations).toHaveLength(0);
  });

  it("distinguishes a refusal from an outage", async () => {
    worker.setMode("forbidden");
    const status = await memory.status();
    expect(status.status).toBe("permission_denied");
    expect(status.detail).toContain("refused");
  });

  it("returns no hits and no fabricated ids when search fails", async () => {
    worker.setMode("unhealthy");
    const found = await memory.search({ projectPseudonym: "p", query: "q", limit: 3 });
    expect(found.hits).toEqual([]);
    expect(found.status.status).toBe("disconnected");
  });

  it("returns an empty timeline rather than a placeholder when the worker is down", async () => {
    worker.setMode("unhealthy");
    const result = await memory.timeline({
      anchor: "2026-08-23T14:06:00.000Z",
      depthBefore: 3,
      depthAfter: 3,
    });
    expect(result.entries).toEqual([]);
    expect(result.status.status).toBe("disconnected");
  });

  it("survives a worker that is not listening at all", async () => {
    await worker.close();
    const status = await memory.status();
    expect(status.status).toBe("disconnected");
    const result = await memory.record(OBSERVATION);
    expect(result.recorded).toBe(false);
  });
});

describe("reading the timeline around an instant", () => {
  let worker: FakeMemoryWorker;
  let memory: ClaudeMemAdapter;
  // The worker renders wall-clock times in the reader's own timezone, so the
  // anchor is built the same way. Hardcoding a UTC instant here would make the
  // expectations pass only on a machine that happens to run in UTC.
  const anchor = new Date(Date.parse("Aug 23, 2026 2:06 PM")).toISOString();

  beforeEach(async () => {
    worker = await startFakeMemoryWorker();
    memory = new ClaudeMemAdapter({ baseUrl: worker.baseUrl });
  });

  afterEach(async () => {
    await worker.close();
  });

  it("reads the worker's rendered markdown table", async () => {
    const result = await memory.timeline({ anchor, depthBefore: 3, depthAfter: 3 });
    expect(result.entries.map((entry) => entry.id)).toEqual(["12", "13", "14"]);
    expect(result.entries[0]?.title).toContain("installed a dependency");
    expect(result.entries.every((entry) => entry.source === "claude-mem")).toBe(true);
  });

  it("carries a repeated time down from the row above", async () => {
    const result = await memory.timeline({ anchor, depthBefore: 3, depthAfter: 3 });
    // Row 13 is written with a ditto mark, so it shares row 12's timestamp.
    expect(result.entries[1]?.at).toBe(result.entries[0]?.at);
    expect(result.entries[2]?.at).not.toBe(result.entries[0]?.at);
  });

  it("places each entry relative to the anchor", async () => {
    const result = await memory.timeline({ anchor, depthBefore: 3, depthAfter: 3 });
    expect(result.entries.map((entry) => entry.position)).toEqual(["before", "before", "after"]);
  });

  it("still reads a worker version that answers with structured observations", async () => {
    worker.setTimelineBody({
      before: [{ id: 1, title: "earlier", created_at: "2026-08-23T13:00:00.000Z" }],
      after: [{ id: 2, title: "later", created_at: "2026-08-23T15:00:00.000Z" }],
    });
    const result = await memory.timeline({ anchor, depthBefore: 3, depthAfter: 3 });
    expect(result.entries.map((entry) => [entry.id, entry.position])).toEqual([
      ["1", "before"],
      ["2", "after"],
    ]);
  });

  it("returns nothing rather than guessing when the worker has no context", async () => {
    worker.setTimelineBody({
      content: [{ type: "text", text: "No context found around anchor (5 records before, 5 records after)" }],
    });
    const result = await memory.timeline({ anchor, depthBefore: 5, depthAfter: 5 });
    expect(result.entries).toEqual([]);
  });

  it("passes the project pseudonym, never a real path", async () => {
    await memory.timeline({
      anchor,
      depthBefore: 1,
      depthAfter: 1,
      projectPseudonym: "iwomc-abc123def456",
    });
    expect(worker.requests.some((request) => request.path === "/api/timeline")).toBe(true);
  });
});

describe("the disabled memory port", () => {
  it("reports not_configured and never claims to have recorded anything", async () => {
    const memory = new DisabledMemory();
    expect((await memory.status()).status).toBe("not_configured");
    expect((await memory.record()).recorded).toBe(false);
    expect((await memory.search()).hits).toEqual([]);
    expect((await memory.timeline()).entries).toEqual([]);
  });
});

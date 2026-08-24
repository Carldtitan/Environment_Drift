import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the Claude-Mem local worker, used ONLY by automated tests.
 *
 * It exists so the redaction guarantees can be asserted against a real HTTP
 * exchange. It is never imported by the product, and nothing in the product
 * can be pointed at it except by explicitly setting CLAUDE_MEM_BASE_URL - which
 * a test does and a user would not.
 */

export interface RecordedObservation {
  readonly contentSessionId: string;
  readonly platformSource: string | undefined;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolResponse: unknown;
  readonly cwd: string;
  /** The exact bytes the client sent, for secret-leak assertions. */
  readonly rawBody: string;
}

export interface FakeMemoryWorker {
  readonly baseUrl: string;
  readonly observations: RecordedObservation[];
  readonly requests: { method: string; path: string }[];
  /** Make the worker start refusing, to exercise the disconnected path. */
  setMode(mode: "healthy" | "unhealthy" | "forbidden"): void;
  /** Observations returned by /api/search. */
  setSearchResults(results: unknown[]): void;
  /**
   * Body returned by /api/timeline.
   *
   * The real worker answers with an MCP content envelope carrying a rendered
   * markdown table, so the default here is exactly that shape - a double that
   * returned tidy JSON would let a parser bug through.
   */
  setTimelineBody(body: unknown): void;
  close(): Promise<void>;
}

export async function startFakeMemoryWorker(): Promise<FakeMemoryWorker> {
  const observations: RecordedObservation[] = [];
  const requests: { method: string; path: string }[] = [];
  let mode: "healthy" | "unhealthy" | "forbidden" = "healthy";
  let searchResults: unknown[] = [];
  let timelineBody: unknown = { content: [{ type: "text", text: DEFAULT_TIMELINE_MARKDOWN }] };

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    requests.push({ method: req.method ?? "GET", path });

    if (mode === "forbidden") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    if (mode === "unhealthy") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "worker is not ready" }));
      return;
    }

    if (req.method === "GET" && path === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.method === "POST" && path === "/api/sessions/init") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { contentSessionId?: string };
          if (!parsed.contentSessionId) throw new Error("contentSessionId is required");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "initialized", skipped: false }));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid session init" }));
        }
      });
      return;
    }

    if (req.method === "GET" && path === "/api/timeline") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(timelineBody));
      return;
    }

    if (req.method === "GET" && path === "/api/search") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ observations: searchResults, sessions: [], prompts: [] }));
      return;
    }

    if (req.method === "POST" && path === "/api/sessions/observations") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        try {
          const parsed = JSON.parse(rawBody) as {
            contentSessionId: string;
            platformSource?: string;
            tool_name: string;
            tool_input: unknown;
            tool_response: unknown;
            cwd: string;
          };
          observations.push({
            contentSessionId: parsed.contentSessionId,
            platformSource: parsed.platformSource,
            toolName: parsed.tool_name,
            toolInput: parsed.tool_input,
            toolResponse: parsed.tool_response,
            cwd: parsed.cwd,
            rawBody,
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "queued" }));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid json" }));
        }
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `no route for ${path}` }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    observations,
    requests,
    setMode(next) {
      mode = next;
    },
    setSearchResults(results) {
      searchResults = results;
    },
    setTimelineBody(body) {
      timelineBody = body;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The exact shape a real Claude-Mem worker (13.x) returns from /api/timeline:
 * a markdown table grouped under a date heading, with a ditto mark for a
 * repeated time.
 */
const DEFAULT_TIMELINE_MARKDOWN = [
  "# Timeline around anchor: 2026-08-23T14:06:00.000Z",
  "**Window:** 3 records before -> 3 records after | **Items:** 3",
  "",
  "### Aug 23, 2026",
  "",
  "**General**",
  "| ID | Time | T | Title | Tokens |",
  "|----|------|---|-------|--------|",
  "| #12 | 2:05 PM | \u25c6 | Agent installed a dependency to unblock the test run | ~109 |",
  '| #13 | " | \u25c6 | Contract rescue passed on the second checkout | ~103 |',
  "| #14 | 2:07 PM | \u25c6 | Promotion approved by the project author | ~113 |",
  "",
].join("\n");

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertRedacted, defaultRedactor, RedactionError, type IntegrationStatus, type Redactor } from "@iwomc/contracts";
import type {
  LifecycleObservation,
  MemoryHit,
  MemoryPort,
  MemoryStatus,
  MemoryTimelineEntry,
} from "@iwomc/companion";

/**
 * Claude-Mem integration (R9).
 *
 * IWOMC talks to the documented local worker HTTP API - never to Claude-Mem's
 * database. It writes a redacted lifecycle observation at each boundary and
 * reads history back only as explanation. Memory is never inventory,
 * authorization, proof, or secret storage, and when the worker is not running
 * IWOMC says "memory disconnected" and keeps working.
 */

/** The synthetic tool name IWOMC's observations are attributed to. */
export const IWOMC_TOOL_NAME = "IWOMCContract";

export interface ClaudeMemOptions {
  readonly baseUrl?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Session id used for every IWOMC observation on this device. */
  readonly sessionId?: string;
}

interface WorkerSettings {
  readonly CLAUDE_MEM_WORKER_PORT?: string | number;
  readonly CLAUDE_MEM_WORKER_HOST?: string;
}

/**
 * Resolve the worker endpoint the way the documented integration guide says:
 * the environment first, then `~/.claude-mem/settings.json`, then the
 * per-user default port.
 */
export function resolveWorkerBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["CLAUDE_MEM_BASE_URL"];
  if (explicit && explicit.trim().length > 0) return explicit.replace(/\/+$/u, "");

  let settings: WorkerSettings = {};
  const settingsPath = join(env["CLAUDE_MEM_DATA_DIR"] ?? join(homedir(), ".claude-mem"), "settings.json");
  try {
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as WorkerSettings;
    }
  } catch {
    settings = {};
  }

  const port =
    numberOrNull(env["CLAUDE_MEM_WORKER_PORT"]) ??
    numberOrNull(settings.CLAUDE_MEM_WORKER_PORT) ??
    defaultWorkerPort();
  const host = env["CLAUDE_MEM_WORKER_HOST"] ?? settings.CLAUDE_MEM_WORKER_HOST ?? "127.0.0.1";
  return `http://${formatHost(host)}:${port}`;
}

/** The worker's documented default: 37700 + (uid % 100), with 77 as fallback. */
export function defaultWorkerPort(): number {
  const uid = typeof process.getuid === "function" ? process.getuid() : 77;
  return 37700 + (uid % 100);
}

function numberOrNull(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatHost(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host;
  return host.includes(":") ? `[${host}]` : host;
}

export class ClaudeMemAdapter implements MemoryPort {
  readonly id = "claude-mem" as const;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #sessionId: string;
  readonly #initializedSessions = new Set<string>();
  #lastStatus: MemoryStatus | null = null;

  constructor(options: ClaudeMemOptions = {}) {
    const env = options.env ?? process.env;
    this.#baseUrl = (options.baseUrl ?? resolveWorkerBaseUrl(env)).replace(/\/+$/u, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 4_000;
    this.#sessionId = options.sessionId ?? "iwomc-companion";
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async status(): Promise<MemoryStatus> {
    const result = await this.#request("GET", "/api/health");
    if (result.ok) {
      const status: MemoryStatus = {
        status: "connected",
        detail: `Claude-Mem worker responded at ${this.#baseUrl}.`,
        endpoint: this.#baseUrl,
      };
      this.#lastStatus = status;
      return status;
    }
    const status: MemoryStatus = {
      status: result.kind === "forbidden" ? "permission_denied" : "disconnected",
      detail:
        result.kind === "forbidden"
          ? `The Claude-Mem worker at ${this.#baseUrl} refused this request (${result.detail}).`
          : `No Claude-Mem worker is answering at ${this.#baseUrl} (${result.detail}). IWOMC continues without durable memory.`,
      endpoint: this.#baseUrl,
    };
    this.#lastStatus = status;
    return status;
  }

  /**
   * Write one redacted boundary observation. The payload is asserted clean
   * before it leaves the process; if the redactor still finds credential-shaped
   * material the write is refused rather than sent (R9.3).
   */
  async record(
    observation: LifecycleObservation,
    redactor: Redactor = defaultRedactor,
  ): Promise<{ recorded: boolean; reason?: string }> {
    const toolInput = {
      event: observation.event,
      project: observation.projectPseudonym,
      revision: observation.revision,
      facts: observation.facts,
      references: observation.references,
      secret_values_present: false,
    };
    const toolResponse = {
      outcome: observation.outcome,
      recorded_at: observation.at,
      source: "iwomc-companion",
    };

    const contentSessionId = projectSessionId(this.#sessionId, observation.projectPseudonym);
    try {
      assertRedacted(toolInput, redactor);
      assertRedacted(toolResponse, redactor);
    } catch (error) {
      if (error instanceof RedactionError) {
        return { recorded: false, reason: `refused locally: ${error.message}` };
      }
      throw error;
    }

    // A worker needs its documented session-init hook before it can generate
    // searchable observations. An accepted observation alone is not enough.
    const initialized = await this.#ensureSession(contentSessionId, observation.projectPseudonym, redactor);
    if (!initialized.ok) return { recorded: false, reason: initialized.reason };

    const result = await this.#request("POST", "/api/sessions/observations", {
      // `contentSessionId` is the worker's public hook contract.  It is not
      // a Claude-specific identifier; it is the opaque id that lets the
      // worker group one integration's events without receiving a real path.
      contentSessionId,
      platformSource: "iwomc",
      tool_name: IWOMC_TOOL_NAME,
      tool_input: toolInput,
      tool_response: toolResponse,
      // A pseudonymous path: Claude-Mem groups by project without ever
      // receiving this machine's real directory layout.
      cwd: `/iwomc/${observation.projectPseudonym}`,
    });

    if (!result.ok) {
      return { recorded: false, reason: result.detail };
    }
    const body = result.body as { status?: string; reason?: string } | null;
    if (body?.status === "skipped") {
      return { recorded: false, reason: `worker skipped the observation (${body.reason ?? "no reason given"})` };
    }
    return { recorded: true };
  }

  async #ensureSession(
    contentSessionId: string,
    projectPseudonym: string,
    redactor: Redactor,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.#initializedSessions.has(contentSessionId)) return { ok: true };

    const payload = {
      contentSessionId,
      project: projectPseudonym,
      // This generic prompt is deliberately separate from the redacted facts
      // in the observation below.
      prompt: "IWOMC records redacted environment-lifecycle evidence for this project.",
      platformSource: "iwomc",
      customTitle: "IWOMC environment lifecycle",
    };
    try {
      // `contentSessionId` and `project` are locally generated opaque labels,
      // never collected project content. Redact the only human-readable text
      // in this init request without mistaking an opaque correlation id for a
      // secret.
      assertRedacted({ prompt: payload.prompt, customTitle: payload.customTitle }, redactor);
    } catch (error) {
      if (error instanceof RedactionError) return { ok: false, reason: `refused locally: ${error.message}` };
      throw error;
    }

    const result = await this.#request("POST", "/api/sessions/init", payload);
    if (!result.ok) return { ok: false, reason: `session initialization failed: ${result.detail}` };
    const body = result.body as { skipped?: boolean; reason?: string } | null;
    if (body?.skipped) {
      return { ok: false, reason: `worker skipped session initialization (${body.reason ?? "no reason given"})` };
    }
    this.#initializedSessions.add(contentSessionId);
    return { ok: true };
  }

  /**
   * Explanatory history only. Results are labelled as memory in every surface
   * that renders them and are never treated as inventory or authorization.
   */
  async search(input: {
    projectPseudonym: string;
    query: string;
    limit: number;
  }): Promise<{ hits: MemoryHit[]; status: MemoryStatus }> {
    const params = new URLSearchParams({
      query: input.query,
      type: "observations",
      // The documented worker API returns structured observations in JSON.
      // `index` is a display format, not the object envelope this adapter
      // needs to render memory as explanation in the Rescue Console.
      format: "json",
      limit: String(Math.max(1, Math.min(input.limit, 25))),
      project: input.projectPseudonym,
      platformSource: "iwomc",
    });
    const result = await this.#request("GET", `/api/search?${params.toString()}`);
    if (!result.ok) {
      const status = await this.status();
      return { hits: [], status };
    }
    const body = result.body as { observations?: unknown[] } | null;
    const hits = Array.isArray(body?.observations) ? body.observations.map(toHit).filter(isHit) : [];
    return {
      hits,
      status: this.#lastStatus ?? {
        status: "connected" as IntegrationStatus,
        detail: `Claude-Mem worker responded at ${this.#baseUrl}.`,
        endpoint: this.#baseUrl,
      },
    };
  }

  /**
   * Observations around an instant, using the worker's own timeline endpoint.
   *
   * The anchor is a moment IWOMC already knows deterministically - when a
   * package version actually changed - so this asks Claude-Mem the one
   * question it is uniquely able to answer: what was the session doing then.
   * Nothing here influences what IWOMC materializes or verifies.
   */
  async timeline(input: {
    anchor: string;
    depthBefore: number;
    depthAfter: number;
    projectPseudonym?: string;
  }): Promise<{ entries: MemoryTimelineEntry[]; status: MemoryStatus }> {
    const params = new URLSearchParams({
      anchor: input.anchor,
      depth_before: String(Math.max(0, Math.min(input.depthBefore, 25))),
      depth_after: String(Math.max(0, Math.min(input.depthAfter, 25))),
      format: "json",
      platformSource: "iwomc",
    });
    if (input.projectPseudonym) params.set("project", input.projectPseudonym);

    const result = await this.#request("GET", `/api/timeline?${params.toString()}`);
    if (!result.ok) {
      return { entries: [], status: await this.status() };
    }
    const body = result.body as
      | {
          before?: unknown[];
          anchor?: unknown;
          at?: unknown[];
          after?: unknown[];
          observations?: unknown[];
          content?: unknown[];
        }
      | null;

    // The worker's own timeline endpoint answers with an MCP content envelope
    // carrying a rendered markdown table, not a list of observation objects.
    // Structured keys are still read first, because other worker versions
    // return them and neither shape should break the view.
    const entries: MemoryTimelineEntry[] = [
      ...collect(body?.before, "before"),
      ...collect(body?.at ?? (body?.anchor === undefined ? [] : [body.anchor]), "at"),
      ...collect(body?.after, "after"),
    ];
    if (entries.length === 0) entries.push(...collect(body?.observations, "at"));
    if (entries.length === 0) {
      entries.push(...parseRenderedTimeline(textOfContent(body?.content), input.anchor));
    }

    return {
      entries,
      status: this.#lastStatus ?? {
        status: "connected" as IntegrationStatus,
        detail: `Claude-Mem worker responded at ${this.#baseUrl}.`,
        endpoint: this.#baseUrl,
      },
    };
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; kind: "unreachable" | "error" | "forbidden"; detail: string }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, kind: "forbidden", detail: `HTTP ${response.status}` };
      }
      if (!response.ok) {
        return { ok: false, kind: "error", detail: `HTTP ${response.status}` };
      }
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { ok: true, body: parsed };
    } catch (error) {
      const reason = (error as Error).name === "AbortError" ? "timed out" : (error as Error).message;
      return { ok: false, kind: "unreachable", detail: reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

function toHit(raw: unknown): MemoryHit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = record["id"];
  const title = record["title"] ?? record["subject"] ?? record["summary"];
  const text = record["preview"] ?? record["text"] ?? record["body"] ?? record["narrative"] ?? record["summary"] ?? "";
  const createdAt = record["created_at"] ?? record["createdAt"] ?? null;
  if (id === undefined) return null;
  return {
    id: String(id),
    title: typeof title === "string" && title.length > 0 ? title : `observation ${String(id)}`,
    text: typeof text === "string" ? text : JSON.stringify(text),
    createdAt: typeof createdAt === "string" ? createdAt : null,
    source: "claude-mem",
  };
}

function isHit(value: MemoryHit | null): value is MemoryHit {
  return value !== null;
}

/** Join the text parts of an MCP content envelope. */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const record = part as Record<string, unknown>;
      return typeof record["text"] === "string" ? record["text"] : "";
    })
    .join("\n");
}

const DATE_HEADING = /^#{1,6}\s+(.+?)\s*$/u;
const TABLE_ROW = /^\|(.+)\|\s*$/u;

/**
 * Read the worker's rendered timeline table.
 *
 * Each row is `| #id | time | glyph | title | tokens |`, grouped under a date
 * heading, and a repeated time is written as a ditto mark. Anything that does
 * not parse into an id and a title is skipped rather than guessed at: a
 * half-read row would be narration IWOMC invented, and this pane exists only
 * to show what Claude-Mem actually recorded.
 */
export function parseRenderedTimeline(text: string, anchor: string): MemoryTimelineEntry[] {
  if (text.trim().length === 0) return [];
  const anchorMs = Date.parse(anchor);
  const entries: MemoryTimelineEntry[] = [];
  let currentDate: string | null = null;
  let lastTime: string | null = null;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("#")) {
      const heading = DATE_HEADING.exec(line)?.[1] ?? "";
      // A date heading parses as a date; a section heading does not.
      if (Number.isFinite(Date.parse(heading))) {
        currentDate = heading;
        lastTime = null;
      }
      continue;
    }
    const row = TABLE_ROW.exec(line);
    if (!row) continue;
    const cells = (row[1] as string).split("|").map((cell) => cell.trim());
    if (cells.length < 4) continue;

    const [idCell, timeCell, , titleCell] = cells;
    if (idCell === undefined || titleCell === undefined) continue;
    if (!idCell.startsWith("#")) continue; // header and separator rows
    const id = idCell.slice(1).trim();
    if (id.length === 0 || titleCell.length === 0) continue;

    // A ditto mark means "same time as the row above", which is how the
    // worker renders several observations recorded in the same minute.
    const time: string | null =
      timeCell === undefined || timeCell.length === 0 || timeCell === '"' ? lastTime : timeCell;
    if (time !== null) lastTime = time;

    const parsed = currentDate && time ? Date.parse(`${currentDate} ${time}`) : Number.NaN;
    const at = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
    const position: MemoryTimelineEntry["position"] =
      !Number.isFinite(parsed) || !Number.isFinite(anchorMs)
        ? "at"
        : parsed < anchorMs
          ? "before"
          : parsed > anchorMs
            ? "after"
            : "at";

    entries.push({ id, title: titleCell, text: titleCell, at, position, source: "claude-mem" });
  }
  return entries;
}

function collect(raw: unknown, position: MemoryTimelineEntry["position"]): MemoryTimelineEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(toHit)
    .filter(isHit)
    .map((hit) => ({
      id: hit.id,
      title: hit.title,
      text: hit.text,
      at: hit.createdAt,
      position,
      source: "claude-mem" as const,
    }));
}

/**
 * Keep worker sessions separate by pseudonymous project without placing a
 * token-like identifier on the wire. This is an opaque grouping label, not a
 * project identity or a security boundary.
 */
function projectSessionId(base: string, projectPseudonym: string): string {
  let hash = 0x811c9dc5;
  for (const character of projectPseudonym) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${base}-${hash >>> 0}`;
}

/**
 * A memory port for when the integration is switched off entirely. It reports
 * `not_configured` and records nothing - it never fabricates an observation id
 * or a connected status (R9.6).
 */
export class DisabledMemory implements MemoryPort {
  readonly id = "claude-mem" as const;
  readonly #reason: string;

  constructor(reason = "Claude-Mem integration is disabled for this process.") {
    this.#reason = reason;
  }

  async status(): Promise<MemoryStatus> {
    return { status: "not_configured", detail: this.#reason, endpoint: null };
  }

  async record(): Promise<{ recorded: boolean; reason?: string }> {
    return { recorded: false, reason: this.#reason };
  }

  async search(): Promise<{ hits: MemoryHit[]; status: MemoryStatus }> {
    return { hits: [], status: await this.status() };
  }

  async timeline(): Promise<{ entries: MemoryTimelineEntry[]; status: MemoryStatus }> {
    return { entries: [], status: await this.status() };
  }
}

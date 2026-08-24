import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { BlockedError, type Blocker } from "@iwomc/contracts";
import type { Companion } from "@iwomc/companion";
import { buildCompanion } from "./wiring.js";
import { AGENT_GUIDE, COMMAND_SPECS } from "./agent-docs.js";

/**
 * The local MCP server (task 5.2).
 *
 * It speaks JSON-RPC 2.0 over stdio and calls exactly the same Companion
 * services the CLI does, so a tool result and a command result can never
 * disagree. Every tool description states its side effects, whether it needs
 * approval, and how it can fail.
 */

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly mutating: boolean;
  readonly handler: (companion: Companion, args: Record<string, unknown>) => Promise<unknown>;
}

const DIR_PROPERTY = {
  type: "string",
  description:
    "Absolute path of the checkout to operate on. Defaults to the directory this server was started in.",
};

const CONFIRM_PROPERTY = {
  type: "boolean",
  description:
    "Explicit human confirmation. Required for any tool that changes local state; the call is refused without it.",
};

function dirOf(args: Record<string, unknown>): string {
  const value = args["dir"];
  return resolve(typeof value === "string" && value.length > 0 ? value : process.cwd());
}

function requireConfirmation(args: Record<string, unknown>, action: string): void {
  if (args["confirm"] === true) return;
  throw new BlockedError({
    code: "approval_required",
    message: `${action} changes local state, so it needs an explicit human confirmation.`,
    nextAction: `Ask the person you are helping to approve this, then call the tool again with confirm: true.`,
  });
}

export const MCP_TOOLS: readonly ToolDefinition[] = [
  {
    name: "environment_status",
    title: "Environment status",
    description:
      "Read-only. Answers whether this checkout can be rescued now, which contract applies to the exact revision, the truthful ecosystem support level, the configured proof command, and which integrations are actually connected. When several teammates captured the same revision, `agreement` reports where their machines differ - and is null when fewer than two captures are comparable, which means 'nothing to compare', not 'they agree'. Fails only when the directory is not a Git checkout. Changes nothing.",
    inputSchema: {
      type: "object",
      properties: { dir: DIR_PROPERTY },
      additionalProperties: false,
    },
    mutating: false,
    handler: async (companion, args) => await companion.status(dirOf(args)),
  },
  {
    name: "diagnose_environment",
    title: "Diagnose environment",
    description:
      "Read-only. Reports local checks, verifier availability, durable-memory status, and integration configuration with the exact next action for each problem. Runs no install command and changes nothing.",
    inputSchema: {
      type: "object",
      properties: { dir: DIR_PROPERTY },
      additionalProperties: false,
    },
    mutating: false,
    handler: async (companion, args) => await companion.doctor(dirOf(args)),
  },
  {
    name: "capture_environment",
    title: "Capture a working environment",
    description:
      "Records deterministic evidence from a checkout where the project already works and compiles a candidate, device-signed environment contract for the exact Git revision. Reads declared files and project-local inventories; runs no install command and modifies no file. Requires a proof command to be configured (pass proofCommand to set one). Reports coverage gaps rather than implying an exhaustive host snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        dir: DIR_PROPERTY,
        proofCommand: {
          type: "string",
          description:
            "The command that decides whether the project works, for example \"npm test\". Tokenized, never run through a shell.",
        },
      },
      additionalProperties: false,
    },
    mutating: false,
    handler: async (companion, args) => {
      const proofCommand = args["proofCommand"];
      const result = await companion.capture(dirOf(args), {
        ...(typeof proofCommand === "string" ? { proofCommand } : {}),
      });
      return {
        receiptId: result.receipt.id,
        contract: result.contract
          ? {
              id: result.contract.id,
              digest: result.contract.digest,
              state: result.contract.state,
              support: result.contract.support,
              steps: result.contract.steps.map((step) => ({ id: step.id, kind: step.kind, description: step.description })),
              proof: result.contract.proof.argv.join(" "),
            }
          : null,
        support: result.support,
        supportReason: result.supportReason,
        drift: result.drift,
        coverage: result.coverage,
        secretNames: result.secretNames,
        blockers: result.blockers,
      };
    },
  },
  {
    name: "verify_contract",
    title: "Verify a contract in a fresh environment",
    description:
      "Applies a contract to a brand-new directory (a temporary clone locally, or a disposable Modal sandbox when configured and within budget) and runs the proof command there. The working checkout is never touched. A passing local run is labelled `locally checked`; only a passing Modal run is `clean verified`. Fails when no contract exists for the revision, when no verifier is available, or when the project has not approved source upload for a remote verifier.",
    inputSchema: {
      type: "object",
      properties: {
        dir: DIR_PROPERTY,
        contractId: { type: "string", description: "Verify a specific contract instead of the newest one." },
        verifier: {
          type: "string",
          enum: ["modal", "local_fresh_directory"],
          description: "Force one verifier instead of preferring Modal.",
        },
      },
      additionalProperties: false,
    },
    mutating: false,
    handler: async (companion, args) => {
      const contractId = args["contractId"];
      const verifier = args["verifier"];
      const result = await companion.verify(dirOf(args), {
        ...(typeof contractId === "string" ? { contractId } : {}),
        ...(verifier === "modal" || verifier === "local_fresh_directory" ? { verifier } : {}),
      });
      return {
        attestation: result.attestation,
        verifier: result.verifierId,
        verifierDetail: result.verifierDetail,
        contractState: result.contract?.state ?? null,
        blocker: result.blocker,
      };
    },
  },
  {
    name: "rescue_environment",
    title: "Rescue this checkout",
    description:
      "MUTATING - requires confirm: true. Applies an approved contract for the exact Git revision to this checkout, creating project-local state only (node_modules, .venv, .iwomc), then runs the project's proof command. It never edits a tracked file, never installs globally, and never copies a secret value. Returns exactly one of working, blocked, failed, unsupported, or inconclusive; `working` requires the proof command to pass. Fails or blocks with a machine-readable blocker code and one concrete next action.",
    inputSchema: {
      type: "object",
      properties: {
        dir: DIR_PROPERTY,
        contractId: {
          type: "string",
          description:
            "Apply a specific contract. Needed when no contract exists for the exact revision; a nearest-revision contract is never applied automatically.",
        },
        confirm: CONFIRM_PROPERTY,
      },
      required: ["confirm"],
      additionalProperties: false,
    },
    mutating: true,
    handler: async (companion, args) => {
      requireConfirmation(args, "Rescue");
      const contractId = args["contractId"];
      const result = await companion.rescue(dirOf(args), {
        approve: true,
        ...(typeof contractId === "string" ? { contractId } : {}),
      });
      if ("runId" in result && result.runId === null) {
        return { state: "blocked", blocker: result.blocker };
      }
      const full = result as Awaited<ReturnType<Companion["rescue"]>> & {
        state: string;
        runId: string;
        blocker: Blocker | null;
      };
      return {
        state: full.state,
        runId: full.runId,
        blocker: full.blocker,
        proof: (full as unknown as { proof?: unknown }).proof ?? null,
        outcome: (full as unknown as { outcome?: unknown }).outcome ?? null,
        explanations: (full as unknown as { explanations?: unknown }).explanations ?? [],
        memory: (full as unknown as { memoryDetail?: string }).memoryDetail ?? "",
        events: ((full as unknown as { events?: readonly unknown[] }).events ?? []).slice(-80),
      };
    },
  },
  {
    name: "promote_repair",
    title: "Promote a repository repair",
    description:
      "Turns environment facts the capture observed but the repository does not declare into an ordinary reviewable file diff. Without confirm it only returns the proposed diff and writes nothing. With confirm: true it writes exactly the files in that diff and nothing else. Fails when a target file changed since the diff was produced.",
    inputSchema: {
      type: "object",
      properties: {
        dir: DIR_PROPERTY,
        confirm: {
          type: "boolean",
          description: "Set true to write the reviewed diff. Omit to preview only.",
        },
      },
      additionalProperties: false,
    },
    mutating: true,
    handler: async (companion, args) => {
      const apply = args["confirm"] === true;
      const result = await companion.promote(dirOf(args), { apply });
      return {
        repair: result.repair,
        findings: result.findings,
        applied: result.applied,
        blocker: result.blocker,
        note: apply
          ? "The listed files were written. Review with `git diff` before committing."
          : "Nothing was written. Call again with confirm: true to apply exactly this diff.",
      };
    },
  },
  {
    name: "record_package_observation",
    title: "Record what is installed right now",
    description:
      "Takes one observation of the project's installed packages and appends any install, upgrade, downgrade, or removal since the last observation to the local package log. Reads project-local package directories only; it runs no package manager and looks at no other project. Changes no repository file. Call this after you install or change a dependency so the timeline records when it happened.",
    inputSchema: {
      type: "object",
      properties: { dir: DIR_PROPERTY },
      additionalProperties: false,
    },
    mutating: false,
    handler: async (companion, args) => {
      const { result } = await companion.sweepOnce(dirOf(args));
      return {
        at: result.at,
        commit: result.commit,
        installedPackages: result.packageCount,
        changes: result.events.map((event) => ({
          name: event.name,
          manager: event.manager,
          kind: event.kind,
          fromVersion: event.fromVersion,
          toVersion: event.toVersion,
          window: event.window,
        })),
        unavailable: result.unavailable,
      };
    },
  },
  {
    name: "package_timeline",
    title: "What was installed at a moment or a revision",
    description:
      "Read-only. Replays the local package log to answer what versions were installed at an instant, or while a given Git revision was checked out. The package state is deterministic and comes only from IWOMC's own log; durable memory is queried separately and returned under `memory` as narration, never as environment truth. When a revision was never observed on this device it says so instead of estimating from a nearby one, and every answer lists the periods it could not see.",
    inputSchema: {
      type: "object",
      properties: {
        dir: DIR_PROPERTY,
        at: { type: "string", description: "ISO instant. Defaults to now." },
        commit: { type: "string", description: "Exact Git revision. Takes precedence over `at`." },
        explain: {
          type: "boolean",
          description: "Set false to skip the durable-memory lookup entirely. Defaults to true.",
        },
      },
      additionalProperties: false,
    },
    mutating: false,
    handler: async (companion, args) => {
      const at = args["at"];
      const commit = args["commit"];
      return await companion.timeline(dirOf(args), {
        ...(typeof at === "string" ? { at } : {}),
        ...(typeof commit === "string" ? { commit } : {}),
        explain: args["explain"] !== false,
      });
    },
  },
  {
    name: "package_timeline_diff",
    title: "What changed between two points",
    description:
      "Read-only. Reports the installs, upgrades, downgrades, and removals that separate two revisions, or two instants. Both sides must be the same kind. Returns `missing` instead of a diff when a requested revision was never observed on this device.",
    inputSchema: {
      type: "object",
      properties: {
        dir: DIR_PROPERTY,
        fromCommit: { type: "string", description: "Starting revision." },
        toCommit: { type: "string", description: "Ending revision." },
        since: { type: "string", description: "Starting ISO instant, for a time comparison." },
        until: { type: "string", description: "Ending ISO instant. Defaults to now." },
      },
      additionalProperties: false,
    },
    mutating: false,
    handler: async (companion, args) => {
      const fromCommit = args["fromCommit"];
      const toCommit = args["toCommit"];
      const since = args["since"];
      const until = args["until"];
      if (typeof fromCommit === "string" && typeof toCommit === "string") {
        return await companion.timelineDiff(dirOf(args), { commit: fromCommit }, { commit: toCommit });
      }
      if (typeof since === "string") {
        return await companion.timelineDiff(
          dirOf(args),
          { at: since },
          typeof until === "string" ? { at: until } : {},
        );
      }
      // A malformed call is a caller error, not an environment blocker: it has
      // no next action a person could take on the machine.
      throw new Error(
        "A comparison needs two points of the same kind: pass fromCommit and toCommit, or since (and optionally until).",
      );
    },
  },
];

export async function runMcpServer(): Promise<void> {
  const companion = await buildCompanion();
  const reader = createInterface({ input: process.stdin });

  const write = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const respond = (id: string | number | null | undefined, result: unknown): void => {
    if (id === undefined || id === null) return;
    write({ jsonrpc: "2.0", id, result });
  };

  const fail = (id: string | number | null | undefined, code: number, message: string, data?: unknown): void => {
    if (id === undefined || id === null) return;
    write({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  };

  for await (const raw of reader) {
    const text = raw.trim();
    if (text.length === 0) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(text) as JsonRpcRequest;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }

    try {
      switch (request.method) {
        case "initialize":
          respond(request.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "iwomc", version: "0.1.0" },
            instructions: AGENT_GUIDE,
          });
          break;

        case "notifications/initialized":
          break;

        case "ping":
          respond(request.id, {});
          break;

        case "tools/list":
          respond(request.id, {
            tools: MCP_TOOLS.map((tool) => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema: tool.inputSchema,
              annotations: {
                readOnlyHint: !tool.mutating,
                destructiveHint: false,
                idempotentHint: !tool.mutating,
                openWorldHint: tool.name === "verify_contract",
              },
            })),
          });
          break;

        case "tools/call": {
          const name = request.params?.["name"];
          const args = (request.params?.["arguments"] ?? {}) as Record<string, unknown>;
          const tool = MCP_TOOLS.find((entry) => entry.name === name);
          if (!tool) {
            fail(request.id, -32602, `Unknown tool "${String(name)}"`, {
              available: MCP_TOOLS.map((entry) => entry.name),
            });
            break;
          }
          try {
            const result = await tool.handler(companion, args);
            respond(request.id, {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              structuredContent: result,
              isError: false,
            });
          } catch (error) {
            const blocker =
              error instanceof BlockedError
                ? error.blocker
                : {
                    code: "internal_error" as const,
                    message: (error as Error).message,
                    nextAction: "Call diagnose_environment for a full report.",
                  };
            respond(request.id, {
              content: [{ type: "text", text: JSON.stringify({ blocker }, null, 2) }],
              structuredContent: { blocker },
              isError: true,
            });
          }
          break;
        }

        case "resources/list":
          respond(request.id, {
            resources: [
              {
                uri: "iwomc://agent-guide",
                name: "IWOMC agent guide",
                description: "Versioned workflow documentation generated from the command and contract schemas.",
                mimeType: "text/plain",
              },
              {
                uri: "iwomc://commands",
                name: "IWOMC command metadata",
                description: "Every CLI command with its effects, approval rule, flags, and exit codes.",
                mimeType: "application/json",
              },
            ],
          });
          break;

        case "resources/read": {
          const uri = request.params?.["uri"];
          if (uri === "iwomc://agent-guide") {
            respond(request.id, {
              contents: [{ uri, mimeType: "text/plain", text: AGENT_GUIDE }],
            });
          } else if (uri === "iwomc://commands") {
            respond(request.id, {
              contents: [
                { uri, mimeType: "application/json", text: JSON.stringify(COMMAND_SPECS, null, 2) },
              ],
            });
          } else {
            fail(request.id, -32602, `Unknown resource "${String(uri)}"`);
          }
          break;
        }

        default:
          fail(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (error) {
      fail(request.id, -32603, (error as Error).message);
    }
  }

  companion.close();
}

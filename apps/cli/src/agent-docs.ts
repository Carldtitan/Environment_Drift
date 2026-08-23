import { BLOCKER_CODES, RESCUE_TERMINAL_STATES, SUPPORT_LEVELS } from "@iwomc/contracts";
import { heading, style } from "./render.js";

/**
 * Versioned agent documentation, generated from the same command metadata the
 * CLI and the MCP server use (task 5.3). An agent that reads this can drive the
 * whole workflow without a hand-written project prompt.
 */

export interface CommandFlag {
  readonly name: string;
  readonly value?: string;
  readonly description: string;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly effects: string;
  readonly approval: string;
  readonly flags: readonly CommandFlag[];
  readonly exitCodes: readonly { readonly code: number; readonly meaning: string }[];
  readonly nextActions: readonly string[];
}

const COMMON_EXITS = [
  { code: 0, meaning: "the command succeeded (for rescue: the proof command passed)" },
  { code: 1, meaning: "failed - work was done but the project still does not pass its proof" },
  { code: 2, meaning: "blocked - a precondition was not met; nothing was changed" },
  { code: 3, meaning: "unsupported - IWOMC has no approved way to materialize this project" },
  { code: 4, meaning: "inconclusive - the run could not determine whether the project works" },
  { code: 64, meaning: "usage error" },
] as const;

export const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    name: "init",
    summary: "Bind this checkout to an IWOMC project and set its proof command.",
    usage: 'iwomc init [--name <project>] [--proof "<command>"] [--env A,B]',
    effects: "Writes a project binding to the local encrypted store. Does not touch the repository.",
    approval: "None. It changes no project file.",
    flags: [
      { name: "--name", value: "<project>", description: "Display name; defaults to the directory name." },
      {
        name: "--proof",
        value: '"<command>"',
        description:
          "The command that decides whether the project works. Tokenized, never run through a shell.",
      },
      { name: "--proof-timeout", value: "<ms>", description: "Timeout for the proof command." },
      {
        name: "--env",
        value: "A,B",
        description: "Environment variable NAMES the proof may read. Values are never stored.",
      },
    ],
    exitCodes: COMMON_EXITS,
    nextActions: ["Run `iwomc capture` on a checkout where the project already works."],
  },
  {
    name: "status",
    summary: "Answer: can this checkout be rescued right now, and with which contract?",
    usage: "iwomc status [--json]",
    effects: "Read-only.",
    approval: "None.",
    flags: [{ name: "--json", description: "Machine-readable output." }],
    exitCodes: COMMON_EXITS,
    nextActions: ["If no contract exists for this revision, ask a teammate to run `iwomc capture`."],
  },
  {
    name: "capture",
    summary: "Record evidence from a working checkout and compile a candidate environment contract.",
    usage: 'iwomc capture [--proof "<command>"] [--json]',
    effects:
      "Reads declared files and project-local inventories, writes a receipt and a device-signed contract to the local store. Runs no install command.",
    approval: "None. Capture never changes the project.",
    flags: [
      { name: "--proof", value: '"<command>"', description: "Set or replace the proof command first." },
      { name: "--json", description: "Machine-readable output." },
    ],
    exitCodes: COMMON_EXITS,
    nextActions: [
      "Run `iwomc verify` to check the contract in a fresh directory.",
      "Share the contract with the team once a control plane is configured.",
    ],
  },
  {
    name: "verify",
    summary: "Apply the contract to a fresh checkout and run the proof command there.",
    usage: "iwomc verify [--contract <id>] [--verifier modal|local_fresh_directory] [--json]",
    effects:
      "Creates a temporary clone outside the project, installs into it, and deletes it. The working checkout is untouched.",
    approval: "None for the local verifier. Modal verification consumes the configured budget.",
    flags: [
      { name: "--contract", value: "<id>", description: "Verify a specific contract instead of the newest." },
      { name: "--verifier", value: "<id>", description: "Force one verifier." },
      { name: "--json", description: "Machine-readable output." },
    ],
    exitCodes: COMMON_EXITS,
    nextActions: ["A passing local verification marks the contract `locally_checked`; Modal marks it `clean_verified`."],
  },
  {
    name: "rescue",
    summary: "Prepare this broken checkout from an approved contract, then prove it works.",
    usage: "iwomc rescue [--contract <id>] [--approve] [--json]",
    effects:
      "Creates project-local state only (node_modules, .venv, .iwomc). Never edits a tracked file. Never copies a secret value.",
    approval:
      "Required when the contract policy sets requireHumanApproval; pass --approve, or approve the run in the console.",
    flags: [
      {
        name: "--contract",
        value: "<id>",
        description: "Apply a specific contract. Needed when no contract exists for the exact revision.",
      },
      { name: "--approve", description: "Give the explicit confirmation a mutating run requires." },
      { name: "--json", description: "Machine-readable output including every run event." },
    ],
    exitCodes: COMMON_EXITS,
    nextActions: [
      "On `failed`, read the proof output: the environment was prepared but the project's own check did not pass.",
      "On `blocked`, follow the blocker's nextAction verbatim.",
    ],
  },
  {
    name: "promote",
    summary: "Turn observed-but-undeclared environment facts into a reviewable repository diff.",
    usage: "iwomc promote [--apply] [--json]",
    effects: "Without --apply it only prints a diff. With --apply it writes exactly the files in that diff.",
    approval: "--apply is the explicit human confirmation.",
    flags: [
      { name: "--apply", description: "Write the reviewed changes to the working tree." },
      { name: "--json", description: "Machine-readable output including the unified diff." },
    ],
    exitCodes: COMMON_EXITS,
    nextActions: ["Review the diff, commit it, then run `iwomc capture` and `iwomc verify` again."],
  },
  {
    name: "doctor",
    summary: "Report what is configured, what is connected, and what is blocked.",
    usage: "iwomc doctor [--json]",
    effects: "Read-only. Performs live health checks against configured integrations.",
    approval: "None.",
    flags: [{ name: "--json", description: "Machine-readable output." }],
    exitCodes: COMMON_EXITS,
    nextActions: ["Follow each check's nextAction."],
  },
  {
    name: "login",
    summary: "Sign in with GitHub so this device can join a workspace.",
    usage: "iwomc login [--json]",
    effects: "Starts a GitHub App device flow. Stores no long-lived token in the repository.",
    approval: "The user completes the flow in a browser.",
    flags: [{ name: "--json", description: "Machine-readable output." }],
    exitCodes: COMMON_EXITS,
    nextActions: ["After signing in, run `iwomc join <invitation>` to enroll this device."],
  },
  {
    name: "join",
    summary: "Enroll this device in a workspace using a single-use invitation.",
    usage: "iwomc join <invitation-token> [--url <control-plane>]",
    effects: "Generates nothing new locally except a workspace association; the device key already exists.",
    approval: "Possessing the invitation token is the authorization.",
    flags: [
      { name: "--url", value: "<control-plane>", description: "Control plane base URL." },
      { name: "--json", description: "Machine-readable output." },
    ],
    exitCodes: COMMON_EXITS,
    nextActions: ["Run `iwomc status` to confirm the device is active in the workspace."],
  },
  {
    name: "serve",
    summary: "Run the Rescue Console and its control plane on this machine.",
    usage: "iwomc serve [--port <n>] [--host <addr>] [--public-url <origin>]",
    effects: "Starts an HTTP server bound to localhost by default.",
    approval: "None.",
    flags: [
      { name: "--port", value: "<n>", description: "Port to listen on." },
      { name: "--host", value: "<addr>", description: "Interface to bind. Defaults to 127.0.0.1." },
      { name: "--public-url", value: "<origin>", description: "Reachable HTTP(S) origin placed in teammate invitations; required with a wildcard host." },
    ],
    exitCodes: COMMON_EXITS,
    nextActions: ["Open the printed URL to see the console."],
  },
  {
    name: "agent",
    summary: "Keep this enrolled teammate device connected for signed dashboard jobs.",
    usage: "iwomc agent [--url <control-plane>]",
    effects: "Registers local bindings, polls outbound for signed jobs, and may run an approved capture, verification, rescue, or promotion preview on a pre-registered checkout.",
    approval: "A dashboard job is already signed and workspace-scoped; local rescue still follows the contract's approval policy.",
    flags: [{ name: "--url", value: "<control-plane>", description: "Override the control plane saved by iwomc join." }],
    exitCodes: COMMON_EXITS,
    nextActions: ["Run this in the product checkout on each teammate machine after iwomc join."],
  },
  {
    name: "mcp",
    summary: "Run the local MCP server so a coding agent can drive IWOMC with typed tools.",
    usage: "iwomc mcp",
    effects: "Speaks JSON-RPC over stdio. Exposes the same Companion services as the CLI.",
    approval: "Mutating tools require an explicit confirm argument.",
    flags: [],
    exitCodes: COMMON_EXITS,
    nextActions: ["Register it with your agent as a stdio MCP server running `iwomc mcp`."],
  },
  {
    name: "agent-docs",
    summary: "Print this documentation, optionally as JSON.",
    usage: "iwomc agent-docs [--json]",
    effects: "Read-only.",
    approval: "None.",
    flags: [{ name: "--json", description: "Machine-readable command metadata." }],
    exitCodes: COMMON_EXITS,
    nextActions: [],
  },
];

export const AGENT_GUIDE = `IWOMC Rescue - agent guide (schema v1)

WHAT IT IS
  A teammate's checkout of agent-written code does not run. IWOMC applies an
  approved, project-local environment contract captured from a checkout where it
  DID run, then proves the result with the project's own proof command.

THE TWO COMMANDS THAT MATTER
  iwomc capture   on a checkout that works    -> receipt + candidate contract
  iwomc rescue    on a checkout that is broken -> working | blocked | failed |
                                                  unsupported | inconclusive

RULES YOU CAN RELY ON
  - "working" is produced only by a passing proof command. Installing is not
    success.
  - Rescue creates project-local state only. It never edits a tracked file and
    never copies a secret value; contracts carry secret NAMES only.
  - A contract binds to an exact Git revision. A nearest-revision contract is a
    suggestion that requires an explicit --contract choice.
  - Support levels are truthful: ${SUPPORT_LEVELS.join(", ")}. Only native and
    reviewed-recipe contracts are applied automatically.
  - Every stop has a machine-readable blocker code and one concrete nextAction.

TERMINAL STATES
  ${RESCUE_TERMINAL_STATES.join(", ")}

BLOCKER CODES
  ${BLOCKER_CODES.join(", ")}

TYPICAL SEQUENCE
  1. iwomc status --json          - is a contract available for this revision?
  2. iwomc rescue --json          - apply it and run the proof command
  3. read .blocker.nextAction     - if the run did not reach "working"
  4. iwomc promote --json         - when the repository is missing a declaration

EVERY COMMAND ACCEPTS --json AND RETURNS A STRUCTURED RESULT.
`;

export function renderRootHelp(): string {
  const lines: string[] = [];
  lines.push(style.bold("iwomc") + " - make a teammate's broken checkout runnable from a verified contract.");
  lines.push("");
  lines.push(style.bold("Usage:") + " iwomc <command> [options]");
  lines.push("");
  lines.push(style.bold("Commands"));
  const width = Math.max(...COMMAND_SPECS.map((spec) => spec.name.length));
  for (const spec of COMMAND_SPECS) {
    lines.push(`  ${spec.name.padEnd(width)}  ${spec.summary}`);
  }
  lines.push("");
  lines.push(style.bold("Global options"));
  lines.push("  --dir <path>   Operate on another directory instead of the working directory.");
  lines.push("  --json         Machine-readable output.");
  lines.push("  --help         Show this help, or `iwomc help <command>` for one command.");
  lines.push("");
  lines.push(style.dim("Run `iwomc agent-docs` for the agent-facing workflow description."));
  return lines.join("\n");
}

export function renderCommandHelp(name: string): string {
  const spec = COMMAND_SPECS.find((entry) => entry.name === name);
  if (!spec) return renderRootHelp();
  const lines: string[] = [];
  lines.push(heading(`iwomc ${spec.name}`));
  lines.push(`  ${spec.summary}`);
  lines.push("");
  lines.push(`  ${style.bold("Usage")}     ${spec.usage}`);
  lines.push(`  ${style.bold("Effects")}   ${spec.effects}`);
  lines.push(`  ${style.bold("Approval")}  ${spec.approval}`);
  if (spec.flags.length > 0) {
    lines.push("");
    lines.push(`  ${style.bold("Options")}`);
    for (const flag of spec.flags) {
      const label = flag.value ? `${flag.name} ${flag.value}` : flag.name;
      lines.push(`    ${label.padEnd(24)} ${flag.description}`);
    }
  }
  lines.push("");
  lines.push(`  ${style.bold("Exit codes")}`);
  for (const exit of spec.exitCodes) {
    lines.push(`    ${String(exit.code).padEnd(4)} ${exit.meaning}`);
  }
  if (spec.nextActions.length > 0) {
    lines.push("");
    lines.push(`  ${style.bold("Next")}`);
    for (const next of spec.nextActions) lines.push(`    - ${next}`);
  }
  return lines.join("\n");
}

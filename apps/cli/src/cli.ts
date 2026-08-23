import { resolve } from "node:path";
import { BlockedError, BLOCKER_LABELS, type Blocker, type RescueEvent } from "@iwomc/contracts";
import { Companion, NotAGitRepositoryError, formatCommand } from "@iwomc/companion";
import { buildCompanion } from "./wiring.js";
import { renderStatus, renderCapture, renderDoctor, renderRescue, renderVerify, renderPromote } from "./views.js";
import { bullet, heading, line, style, wrapText } from "./render.js";
import { AGENT_GUIDE, COMMAND_SPECS, renderCommandHelp, renderRootHelp } from "./agent-docs.js";

/**
 * Exit codes are part of the CLI contract, so an agent or a CI job can branch
 * on them without parsing text.
 */
export const EXIT = {
  ok: 0,
  failed: 1,
  blocked: 2,
  unsupported: 3,
  inconclusive: 4,
  usage: 64,
  internal: 70,
} as const;

export interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return { command, positional, flags };
}

function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function flagBool(flags: ParsedArgs["flags"], name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

export async function runCli(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const args = parseArgs(argv);
  const json = flagBool(args.flags, "json");
  const dir = resolve(flagString(args.flags, "dir") ?? process.cwd());

  if (args.command === "help" || args.command === "--help" || args.command === "-h" || flagBool(args.flags, "help")) {
    const topic = args.positional[0] ?? flagString(args.flags, "help");
    if (typeof topic === "string" && COMMAND_SPECS.some((spec) => spec.name === topic)) {
      io.out(renderCommandHelp(topic));
      return EXIT.ok;
    }
    io.out(renderRootHelp());
    return EXIT.ok;
  }

  if (args.command === "--version" || args.command === "-v" || args.command === "version") {
    io.out("iwomc 0.1.0");
    return EXIT.ok;
  }

  if (args.command === "agent-docs") {
    io.out(json ? JSON.stringify({ guide: AGENT_GUIDE, commands: COMMAND_SPECS }, null, 2) : AGENT_GUIDE);
    return EXIT.ok;
  }

  if (args.command === "mcp") {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
    return EXIT.ok;
  }

  if (args.command === "serve") {
    const { runServe } = await import("./serve.js");
    return await runServe(
      {
        port: Number(flagString(args.flags, "port") ?? 0) || undefined,
        host: flagString(args.flags, "host"),
        open: flagBool(args.flags, "open"),
      },
      io,
    );
  }

  let companion: Companion | null = null;
  try {
    companion = await buildCompanion();
    return await dispatch(args, companion, { dir, json, io });
  } catch (error) {
    if (error instanceof BlockedError) {
      return emitBlocker(error.blocker, json, io);
    }
    if (error instanceof NotAGitRepositoryError) {
      if (json) {
        io.out(JSON.stringify({ ok: false, blocker: { code: "no_project_binding", message: error.message } }, null, 2));
      } else {
        io.err(line("danger", "Not a Git repository", error.message));
        io.err(wrapText("IWOMC binds a project to a Git remote and revision, so it needs a checkout. Run `git init` or open an existing repository."));
      }
      return EXIT.blocked;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      io.out(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      io.err(line("danger", "IWOMC hit an unexpected error", message));
      io.err(bullet("Run `iwomc doctor` for a diagnostic report."));
    }
    return EXIT.internal;
  } finally {
    companion?.close();
  }
}

async function dispatch(
  args: ParsedArgs,
  companion: Companion,
  ctx: { dir: string; json: boolean; io: CliIo },
): Promise<number> {
  const { dir, json, io } = ctx;

  switch (args.command) {
    case "status": {
      const status = await companion.status(dir);
      if (json) io.out(JSON.stringify(status, null, 2));
      else io.out(renderStatus(status));
      return status.projectError ? EXIT.blocked : EXIT.ok;
    }

    case "init": {
      const result = await companion.init(dir, {
        ...(flagString(args.flags, "name") ? { projectName: flagString(args.flags, "name") as string } : {}),
        ...(flagString(args.flags, "proof") ? { proofCommand: flagString(args.flags, "proof") as string } : {}),
        ...(flagString(args.flags, "proof-timeout")
          ? { proofTimeoutMs: Number(flagString(args.flags, "proof-timeout")) }
          : {}),
        ...(flagString(args.flags, "env")
          ? { envAllowlist: (flagString(args.flags, "env") as string).split(",").map((name) => name.trim()) }
          : {}),
      });
      if (json) {
        io.out(JSON.stringify(result, null, 2));
        return EXIT.ok;
      }
      io.out(heading("Project bound"));
      io.out(
        line("ready", result.binding.projectName, `project ${result.binding.projectId.slice(0, 8)} in this workspace`),
      );
      io.out(bullet(`Subdirectory: ${result.binding.subdirectory}`));
      io.out(bullet(`Ecosystem support: ${result.support.level} - ${result.support.reason}`));
      if (result.proof) {
        io.out(bullet(`Proof command: ${formatCommand(result.proof.argv)}`));
      } else {
        io.out("");
        io.out(line("attention", "No proof command configured"));
        io.out(
          wrapText(
            "IWOMC reports `working` only when a command you choose passes. Set it with: iwomc init --proof \"npm test\"",
          ),
        );
      }
      io.out("");
      io.out(style.dim("Next: run `iwomc capture` on a checkout where the project works."));
      return EXIT.ok;
    }

    case "proof": {
      const command = args.positional.join(" ") || flagString(args.flags, "command");
      if (!command) {
        io.err("Usage: iwomc proof \"<command>\"");
        return EXIT.usage;
      }
      const proof = await companion.setProofCommand(dir, command, {
        ...(flagString(args.flags, "env")
          ? { envAllowlist: (flagString(args.flags, "env") as string).split(",").map((name) => name.trim()) }
          : {}),
      });
      if (json) io.out(JSON.stringify(proof, null, 2));
      else io.out(line("ready", "Proof command set", formatCommand(proof.argv)));
      return EXIT.ok;
    }

    case "capture": {
      const result = await companion.capture(dir, {
        ...(flagString(args.flags, "proof") ? { proofCommand: flagString(args.flags, "proof") as string } : {}),
        allowSourceUpload: flagBool(args.flags, "allow-source-upload"),
      });
      if (json) {
        io.out(
          JSON.stringify(
            {
              receipt: result.receipt,
              contract: result.contract,
              support: result.support,
              supportReason: result.supportReason,
              drift: result.drift,
              coverage: result.coverage,
              secretNames: result.secretNames,
              blockers: result.blockers,
            },
            null,
            2,
          ),
        );
      } else {
        io.out(renderCapture(result));
      }
      return result.contract ? EXIT.ok : EXIT.unsupported;
    }

    case "verify": {
      const result = await companion.verify(dir, {
        ...(flagString(args.flags, "contract") ? { contractId: flagString(args.flags, "contract") as string } : {}),
        ...(flagString(args.flags, "verifier")
          ? { verifier: flagString(args.flags, "verifier") as "modal" | "local_fresh_directory" }
          : {}),
        ...(json
          ? {}
          : {
              onEvent: (event) => io.out(`  ${style.dim(event.phase.padEnd(18))} ${event.message}`),
            }),
      });
      if (json) io.out(JSON.stringify(result, null, 2));
      else io.out(renderVerify(result));
      if (result.blocker) return result.attestation ? EXIT.failed : EXIT.blocked;
      return EXIT.ok;
    }

    case "rescue": {
      const result = await companion.rescue(dir, {
        ...(flagString(args.flags, "contract") ? { contractId: flagString(args.flags, "contract") as string } : {}),
        approve: flagBool(args.flags, "approve"),
        ...(json ? {} : { onEvent: (event: RescueEvent) => io.out(formatEvent(event)) }),
      });
      if ("runId" in result && result.runId === null) {
        return emitBlocker(result.blocker, json, io);
      }
      const full = result as Awaited<ReturnType<Companion["rescue"]>> & { state: string };
      if (json) io.out(JSON.stringify(full, null, 2));
      else io.out(renderRescue(full as never));
      switch (full.state) {
        case "working":
          return EXIT.ok;
        case "failed":
          return EXIT.failed;
        case "blocked":
          return EXIT.blocked;
        case "unsupported":
          return EXIT.unsupported;
        default:
          return EXIT.inconclusive;
      }
    }

    case "promote": {
      const result = await companion.promote(dir, { apply: flagBool(args.flags, "apply") });
      if (json) io.out(JSON.stringify(result, null, 2));
      else io.out(renderPromote(result, flagBool(args.flags, "apply")));
      if (result.blocker) return EXIT.blocked;
      return EXIT.ok;
    }

    case "approve": {
      const contractId = args.positional[0] ?? flagString(args.flags, "contract");
      if (!contractId) {
        io.err("Usage: iwomc approve <contract-id>");
        return EXIT.usage;
      }
      const contract = companion.approveContract(contractId, flagString(args.flags, "note"));
      if (json) io.out(JSON.stringify(contract, null, 2));
      else io.out(line("ready", "Contract approved", `${contract.id} is now ${contract.state}`));
      return EXIT.ok;
    }

    case "doctor": {
      const report = await companion.doctor(dir);
      if (json) io.out(JSON.stringify(report, null, 2));
      else io.out(renderDoctor(report));
      return report.checks.some((check) => check.status === "fail") ? EXIT.blocked : EXIT.ok;
    }

    case "login": {
      const { runLogin } = await import("./account.js");
      return await runLogin(companion, { json, io });
    }

    case "join": {
      const { runJoin } = await import("./account.js");
      return await runJoin(companion, {
        json,
        io,
        ...(args.positional[0] ? { invitation: args.positional[0] } : {}),
        ...(flagString(args.flags, "url") ? { controlPlaneUrl: flagString(args.flags, "url") as string } : {}),
      });
    }

    default:
      io.err(`Unknown command "${args.command}".`);
      io.err(renderRootHelp());
      return EXIT.usage;
  }
}

function emitBlocker(blocker: Blocker, json: boolean, io: CliIo): number {
  if (json) {
    io.out(JSON.stringify({ ok: false, state: "blocked", blocker }, null, 2));
    return EXIT.blocked;
  }
  io.err("");
  io.err(line("attention", BLOCKER_LABELS[blocker.code], blocker.message));
  io.err("");
  io.err(`  ${style.bold("Next:")} ${blocker.nextAction}`);
  return EXIT.blocked;
}

function formatEvent(event: RescueEvent): string {
  const prefix = style.dim(`  ${String(event.seq).padStart(3, "0")}`);
  switch (event.kind) {
    case "step_output":
    case "proof_output":
      return `${prefix} ${style.dim(event.stream === "stderr" ? "err" : "out")} ${event.message}`;
    case "blocked":
      return `${prefix} ${line("attention", event.message)}`;
    case "run_finished":
      return `${prefix} ${event.message}`;
    default:
      return `${prefix} ${style.dim(event.kind.padEnd(16))} ${event.message}`;
  }
}

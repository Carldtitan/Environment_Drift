import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { BlockedError, BLOCKER_LABELS, type Blocker, type RescueEvent } from "@iwomc/contracts";
import {
  Companion,
  NotAGitRepositoryError,
  RecorderBusyError,
  clearDaemonRecord,
  daemonLogPath,
  daemonStatus,
  startDaemon,
  stopDaemon,
  installAutostart,
  removeAutostart,
  autostartStatus,
  formatCommand,
  type SweepResult,
} from "@iwomc/companion";
import { buildCompanion } from "./wiring.js";
import {
  renderStatus,
  renderCapture,
  renderDoctor,
  renderRescue,
  renderVerify,
  renderPromote,
  renderSweep,
  renderTimeline,
  renderTimelineDiff,
} from "./views.js";
import { bullet, heading, line, style, wrapText } from "./render.js";
import { AGENT_GUIDE, COMMAND_SPECS, renderCommandHelp, renderRootHelp } from "./agent-docs.js";
import {
  hydrateContractForCheckout,
  publishCapture,
  publishRescue,
  publishVerifiedContract,
  syncProjectBinding,
} from "./team-sync.js";

/**
 * Exit codes are part of the CLI contract, so an agent or a CI job can branch
 * on them without parsing text.
 */
/**
 * The published package version.
 *
 * Kept beside the command that prints it so `iwomc --version` and the npm
 * package can never disagree; `scripts/package-cli.mjs` checks this matches
 * what it is about to publish.
 */
export const CLI_VERSION = "0.3.0";

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
    io.out(`iwomc ${CLI_VERSION}`);
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
        publicUrl: flagString(args.flags, "public-url"),
        open: flagBool(args.flags, "open"),
      },
      io,
    );
  }

  if (args.command === "host") {
    const { runHostedControlPlane } = await import("./host.js");
    return await runHostedControlPlane(defaultIo);
  }

  let companion: Companion | null = null;
  try {
    companion = await buildCompanion();
    ensureRecording(companion, args.command, json, io);
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
  const { dir, json } = ctx;
  let io = ctx.io;

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
      const team = await syncProjectBinding(companion, result.binding);
      const syncedResult = { ...result, binding: team.binding };
      if (json) {
        io.out(JSON.stringify({ ...syncedResult, teamSynced: team.synced }, null, 2));
        return EXIT.ok;
      }
      io.out(heading("Project bound"));
      io.out(
        line("ready", syncedResult.binding.projectName, `project ${syncedResult.binding.projectId.slice(0, 8)} in this workspace`),
      );
      io.out(bullet(`Subdirectory: ${syncedResult.binding.subdirectory}`));
      io.out(bullet(`Ecosystem support: ${syncedResult.support.level} - ${syncedResult.support.reason}`));
      if (syncedResult.proof) {
        io.out(bullet(`Proof command: ${formatCommand(syncedResult.proof.argv)}`));
      } else {
        io.out("");
        io.out(line("attention", "No proof command configured"));
        io.out(
          wrapText(
            "IWOMC reports `working` only when a command you choose passes. Set it with: iwomc init --proof \"npm test\"",
          ),
        );
      }
      if (team.synced) io.out(bullet("Shared project binding: connected"));
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
      const shared = await publishCapture(companion, result);
      const output = shared.contract ? { ...result, contract: shared.contract } : result;
      if (json) {
        io.out(
          JSON.stringify(
            {
              receipt: output.receipt,
              contract: output.contract,
              support: output.support,
              supportReason: output.supportReason,
              drift: output.drift,
              coverage: output.coverage,
              secretNames: output.secretNames,
              blockers: output.blockers,
              teamPublished: shared.published,
            },
            null,
            2,
          ),
        );
      } else {
        io.out(renderCapture(output));
        if (shared.published) io.out(line("ready", "Shared with the team", "The exact revision contract is ready for teammates."));
      }
      return output.contract ? EXIT.ok : EXIT.unsupported;
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
      const shared = result.attestation?.state === "passed"
        ? await publishVerifiedContract(companion, result.contract)
        : { published: false, contract: result.contract };
      const output = shared.contract ? { ...result, contract: shared.contract } : result;
      if (json) io.out(JSON.stringify({ ...output, teamPublished: shared.published }, null, 2));
      else {
        io.out(renderVerify(output));
        if (shared.published) io.out(line("ready", "Verified contract shared", "Teammates can now rescue this exact revision."));
      }
      if (output.blocker) return output.attestation ? EXIT.failed : EXIT.blocked;
      return EXIT.ok;
    }

    case "rescue": {
      await hydrateContractForCheckout(companion, dir);
      const result = await companion.rescue(dir, {
        ...(flagString(args.flags, "contract") ? { contractId: flagString(args.flags, "contract") as string } : {}),
        approve: flagBool(args.flags, "approve"),
        ...(json ? {} : { onEvent: (event: RescueEvent) => io.out(formatEvent(event)) }),
      });
      if ("runId" in result && result.runId === null) {
        return emitBlocker(result.blocker, json, io);
      }
      const full = result as Awaited<ReturnType<Companion["rescue"]>> & { state: string };
      if ("outcome" in full) await publishRescue(companion, full.outcome);
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

    case "watch": {
      const interval = Number(
        flagString(args.flags, "interval") ?? String(companion.config.autocaptureIntervalSeconds),
      );
      if (!Number.isFinite(interval) || interval < 5) {
        io.err("Usage: iwomc watch [--interval <seconds, at least 5>]");
        return EXIT.usage;
      }

      // Running detached: there is no terminal to write to, and the record of
      // which process is recording has to be cleared when it stops so the next
      // command does not think a dead process is still watching.
      const asDaemon = flagBool(args.flags, "daemon");
      if (asDaemon) {
        const logPath = process.env["IWOMC_RECORDER_LOG"] ?? daemonLogPath();
        const append = (text: string): void => {
          try {
            appendFileSync(logPath, `${new Date().toISOString()} ${text}
`, "utf8");
          } catch {
            // A log we cannot write is not a reason to stop recording.
          }
        };
        io = { out: append, err: append };
        const release = () => clearDaemonRecord();
        process.once("exit", release);
        process.once("SIGINT", release);
        process.once("SIGTERM", release);
      }
      // Resolves when every recorder this command started has stopped, so a
      // checkout that disappears ends the command instead of leaving it
      // waiting on nothing.
      let running = 0;
      let noneLeft = () => {};
      const allStopped = new Promise<void>((resolveStopped) => {
        noneLeft = resolveStopped;
      });

      const watchOptions = {
        sweepIntervalMs: Math.round(interval * 1000),
        onSweep: (result: SweepResult) => {
          if (result.events.length === 0) return;
          if (json) {
            io.out(JSON.stringify({ event: "sweep", ...result }));
            return;
          }
          io.out(renderSweep(result));
        },
        onError: (error: Error) => io.err(line("attention", "Watch error", error.message)),
        onStopped: (reason: string) => {
          running -= 1;
          if (reason !== "interrupted" && !json) {
            io.out(line("attention", "Stopped watching", reason));
          }
          if (running <= 0) noneLeft();
        },
      };

      const all = flagBool(args.flags, "all");
      const started: { name: string; watcher: { stop: (reason?: string) => Promise<void> } }[] = [];

      if (all) {
        const result = await companion.watchAll(watchOptions);
        for (const entry of result.watchers) started.push({ name: entry.projectName, watcher: entry.watcher });
        if (json) {
          io.out(JSON.stringify({ event: "watching", projects: result.watchers.map((entry) => entry.projectName), unavailable: result.unavailable }));
        } else {
          io.out(heading("Watching"));
          if (started.length === 0) {
            io.out(line("attention", "No checkout could be watched"));
            io.out(wrapText("Run `iwomc init` inside a Git checkout first."));
          }
          for (const entry of started) io.out(line("ready", entry.name));
          for (const entry of result.unavailable) {
            io.out(line("attention", entry.projectName, entry.reason));
          }
        }
      } else {
        try {
          const single = await companion.watch(dir, watchOptions);
          started.push({ name: single.project.projectName, watcher: single.watcher });
          if (!json) {
            io.out(heading("Watching"));
            io.out(line("ready", single.project.projectName));
          }
        } catch (error) {
          if (!(error instanceof RecorderBusyError)) throw error;
          // Not a failure. The log is already being kept, and a second
          // recorder would write every change down twice.
          if (json) {
            io.out(JSON.stringify({ event: "already_watching", heldBy: error.heldBy ?? null }));
          } else {
            io.out(line("ready", "Already being watched", "another IWOMC recorder has this project"));
            io.out(
              wrapText(
                error.heldBy
                  ? `It started at ${error.heldBy.startedAt} and last checked at ${error.heldBy.lastSeenAt}. Nothing is missing; stop that one first if you want to watch from here.`
                  : "Nothing is missing. Stop the other recorder first if you want to watch from here.",
              ),
            );
          }
          return EXIT.ok;
        }
      }

      if (started.length === 0) return EXIT.blocked;
      running = started.length;

      if (!json) {
        io.out(bullet(`Sweeping every ${interval}s, and immediately when a package directory changes.`));
        io.out(bullet("Reads project-local package directories only. It never runs a package manager."));
        io.out(style.dim("  Press Ctrl+C to stop. Stopping records the end of this observation window."));
      }

      // A watch session that is never closed makes every later fold read as
      // "IWOMC might still have been looking", so stopping cleanly is part of
      // the honesty of coverage reporting, not just tidiness.
      const interrupted = new Promise<void>((resolveStop) => {
        const finish = () => {
          process.off("SIGINT", finish);
          process.off("SIGTERM", finish);
          resolveStop();
        };
        process.once("SIGINT", finish);
        process.once("SIGTERM", finish);
      });
      await Promise.race([interrupted, allStopped]);
      for (const entry of started) await entry.watcher.stop("interrupted");
      if (!json) {
        io.out(line("ready", "Stopped", `${started.length} observation window(s) closed`));
      }
      return EXIT.ok;
    }

    case "sweep": {
      const sweep = await companion.sweepOnce(dir);
      if (json) {
        io.out(JSON.stringify({ ...sweep.result, recorded: sweep.recorded, heldBy: sweep.heldBy ?? null }, null, 2));
        return EXIT.ok;
      }
      io.out(renderSweep(sweep.result));
      if (!sweep.recorded) {
        io.out("");
        io.out(line("ready", "Not recorded here", "a resident `iwomc watch` is already keeping this log"));
        io.out(wrapText("The reading above is current. Writing it from two processes would put one change in the history twice."));
      }
      return EXIT.ok;
    }

    case "timeline": {
      const result = await companion.timeline(dir, {
        ...(flagString(args.flags, "at") ? { at: flagString(args.flags, "at") as string } : {}),
        ...(flagString(args.flags, "commit") ?? args.positional[0]
          ? { commit: (flagString(args.flags, "commit") ?? args.positional[0]) as string }
          : {}),
        explain: !flagBool(args.flags, "no-explain"),
      });
      if (json) io.out(JSON.stringify(result, null, 2));
      else io.out(renderTimeline(result));
      return "kind" in result.state ? EXIT.blocked : EXIT.ok;
    }

    case "diff": {
      const [first, second] = args.positional;
      const fromCommit = flagString(args.flags, "from") ?? first;
      const toCommit = flagString(args.flags, "to") ?? second;
      const fromAt = flagString(args.flags, "since");
      const toAt = flagString(args.flags, "until");
      if ((!fromCommit && !fromAt) || (fromCommit && !toCommit)) {
        // Comparing a revision against a wall-clock instant would silently mix
        // two different questions, so both sides must be the same kind.
        io.err("Usage: iwomc diff <from-commit> <to-commit>   or   iwomc diff --since <iso> [--until <iso>]");
        return EXIT.usage;
      }
      const result = await companion.timelineDiff(
        dir,
        fromCommit ? { commit: fromCommit } : { at: fromAt as string },
        toCommit ? { commit: toCommit } : (toAt ? { at: toAt } : {}),
      );
      if (json) io.out(JSON.stringify(result, null, 2));
      else io.out(renderTimelineDiff(result));
      return result.missing.length > 0 ? EXIT.blocked : EXIT.ok;
    }

    case "daemon": {
      const action = args.positional[0] ?? "status";
      const entry = cliEntry();

      if (action === "status") {
        const status = daemonStatus();
        const autostart = autostartStatus({ entry });
        if (json) {
          io.out(JSON.stringify({ ...status, autostart, autocapture: companion.config.autocapture }, null, 2));
          return EXIT.ok;
        }
        io.out(heading("Background recorder"));
        io.out(line(status.running ? "ready" : "attention", status.running ? "Recording" : "Not running", status.detail));
        io.out(bullet(`Autocapture is ${companion.config.autocapture ? "on" : "off"} for this device.`));
        io.out(bullet(autostart.installed ? `Starts at login. ${autostart.detail}` : "Does not start at login."));

        // What it watches, and what it does not. Someone relying on a recorder
        // deserves to know its edges without reading the source: a gap you
        // know about is a different thing from one you discover later.
        const watched = companion.registry.all
          .filter((adapter) => adapter.manifest.support === "native" && adapter.manifest.capabilities.inventory)
          .map((adapter) => adapter.manifest.manager);
        io.out("");
        io.out(style.dim("  It records:"));
        io.out(bullet(`Packages installed, upgraded, downgraded, or removed (${watched.join(", ")}).`, "    "));
        io.out(bullet("Which revision was checked out when each change happened.", "    "));
        io.out(bullet("A record of what was installed each time you move to another revision.", "    "));
        io.out(style.dim("  It does not record:"));
        io.out(bullet("Runtime version switches - `iwomc capture` records those into a contract.", "    "));
        io.out(bullet("Anything installed globally, or outside a registered checkout.", "    "));
        io.out(bullet("Environment variable values, ever.", "    "));
        io.out(style.dim(`  Log: ${status.logPath}`));
        return EXIT.ok;
      }

      if (action === "start") {
        const result = startDaemon({ entry });
        if (json) io.out(JSON.stringify(result, null, 2));
        else io.out(line(result.started || result.alreadyRunning ? "ready" : "danger", result.detail));
        return result.started || result.alreadyRunning ? EXIT.ok : EXIT.failed;
      }

      if (action === "stop") {
        const result = stopDaemon();
        if (json) io.out(JSON.stringify(result, null, 2));
        else io.out(line("ready", result.detail));
        return EXIT.ok;
      }

      if (action === "enable" || action === "disable") {
        // Two separate things, deliberately changed together: whether IWOMC may
        // start a recorder at all, and whether the operating system brings one
        // back after a reboot.
        const enable = action === "enable";
        companion.setAutocapture(enable);
        const autostart = enable
          ? installAutostart({ entry, iwomcHome: process.env["IWOMC_HOME"] ?? null })
          : removeAutostart({ entry });
        if (!enable) stopDaemon();
        const started = enable ? startDaemon({ entry }) : null;

        if (json) {
          io.out(JSON.stringify({ autocapture: enable, autostart, started }, null, 2));
          return EXIT.ok;
        }
        io.out(heading(enable ? "Autocapture on" : "Autocapture off"));
        io.out(
          line(
            enable ? "ready" : "attention",
            enable ? "IWOMC will keep a recorder running" : "IWOMC will not start a recorder",
          ),
        );
        io.out(bullet(autostart.detail));
        if (autostart.evidence) io.out(style.dim(`  ${autostart.evidence}`));
        if (started) io.out(bullet(started.detail));
        return autostart.ok ? EXIT.ok : EXIT.failed;
      }

      io.err("Usage: iwomc daemon <status|start|stop|enable|disable>");
      return EXIT.usage;
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

    case "agent": {
      const { runAgent } = await import("./agent.js");
      return await runAgent(companion, {
        io,
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

/**
 * Absolute path of this CLI's entry point.
 *
 * A detached recorder is spawned as `node <entry> watch --all --daemon`, so it
 * has to be a real path rather than whatever `iwomc` happens to resolve to on
 * the caller's PATH - which may not be on the PATH of a login session at all.
 */
export function cliEntry(): string {
  return fileURLToPath(new URL("./bin.js", import.meta.url));
}

/**
 * Commands that mean somebody is working on a project.
 *
 * These are the moments worth having a recorder for. Reading the help, asking
 * the version, or managing the recorder itself are not - starting a background
 * process because someone typed `iwomc help` would be absurd.
 */
const COMMANDS_WORTH_RECORDING = new Set([
  "init",
  "status",
  "capture",
  "verify",
  "rescue",
  "promote",
  "timeline",
  "diff",
  "sweep",
  "approve",
  "proof",
]);

/**
 * Start the background recorder if it should be running and is not.
 *
 * The whole point of autocapture is that nobody has to remember: a log that
 * only exists when someone thought to start it is missing exactly when it
 * matters, because nobody starts a recorder *before* the install that breaks
 * their teammate. Nobody knows which install that is until afterwards.
 *
 * It says so the first time. A background process that appeared on someone's
 * machine without telling them is the kind of thing this product exists not to
 * do, so this is announced once, shown by `iwomc daemon status`, and switched
 * off by `iwomc daemon disable`.
 */
function ensureRecording(companion: Companion, command: string, json: boolean, io: CliIo): void {
  if (!companion.config.autocapture) return;
  if (!COMMANDS_WORTH_RECORDING.has(command)) return;
  // Nothing to record until at least one checkout is registered.
  if (companion.listBindings().length === 0) return;
  if (daemonStatus().running) return;

  const result = startDaemon({ entry: cliEntry() });
  if (!result.started || json) return;

  const announced = companion.store.getMeta("autocapture_announced") === "yes";
  if (announced) return;
  companion.store.setMeta("autocapture_announced", "yes");

  io.err(line("ready", "IWOMC is now recording package changes in the background"));
  io.err(
    wrapText(
      "It records installs, upgrades, downgrades, and removals for the checkouts you have registered, so `iwomc timeline` can tell you what your machine had at any commit. It reads those projects' package folders and nothing else.",
    ),
  );
  io.err(style.dim("  Stop it with `iwomc daemon disable`. Check it with `iwomc daemon status`."));
  io.err("");
}

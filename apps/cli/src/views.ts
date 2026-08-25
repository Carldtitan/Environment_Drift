import { BLOCKER_LABELS } from "@iwomc/contracts";
import type { Companion } from "@iwomc/companion";
import { bullet, heading, humanLabel, keyValue, line, style, terminalTone, wrapText, type Tone } from "./render.js";

type StatusResult = Awaited<ReturnType<Companion["status"]>>;
type CaptureResult = Awaited<ReturnType<Companion["capture"]>>;
type VerifyResult = Awaited<ReturnType<Companion["verify"]>>;
type PromoteResult = Awaited<ReturnType<Companion["promote"]>>;
type DoctorResult = Awaited<ReturnType<Companion["doctor"]>>;

export function renderStatus(status: StatusResult): string {
  const out: string[] = [];

  out.push(heading("This checkout"));
  if (!status.project) {
    out.push(line("attention", "No IWOMC project here", status.projectError ?? "unknown"));
    out.push("");
    out.push(style.bold("  First run"));
    out.push(bullet("1. Open a Git checkout of the project.", "     "));
    out.push(bullet('2. iwomc init --proof "<the command that proves it works>"', "     "));
    out.push(bullet("3. iwomc capture   (on a machine where it already works)", "     "));
    out.push(bullet("4. iwomc rescue    (on the machine where it does not)", "     "));
    return out.join("\n");
  }

  out.push(
    keyValue([
      ["Project", status.project.projectName],
      ["Revision", `${status.project.commit.slice(0, 12)}${status.project.branch ? ` on ${status.project.branch}` : ""}`],
      ["Subdirectory", status.project.subdirectory],
      ["Worktree", status.project.worktreeDirty ? `${status.project.dirtyPathCount} uncommitted change(s)` : "clean"],
      ["Remote", status.project.remoteConfigured ? "configured" : "none (local-only project)"],
    ]),
  );

  out.push(heading("Can this checkout be rescued now?"));
  out.push(
    line(
      status.canRescueNow.possible ? "ready" : "attention",
      status.canRescueNow.possible ? "Yes" : "Not yet",
    ),
  );
  out.push(wrapText(status.canRescueNow.reason));
  if (status.canRescueNow.possible) {
    out.push("");
    out.push(`  ${style.signal(style.bold("iwomc rescue"))}  ${style.dim("<- the one action that matters here")}`);
  }

  if (status.agreement) out.push(renderAgreement(status.agreement));

  out.push(heading("Contract"));
  if (status.exactContract) {
    const contract = status.exactContract;
    out.push(
      line(
        terminalTone(contract.state),
        humanLabel(contract.state),
        `${humanLabel(contract.support)} support, ${contract.stepCount} step(s)`,
      ),
    );
    out.push(
      keyValue([
        ["Digest", contract.digest.slice(0, 26)],
        ["Assurance", assuranceLabel(contract.assurance)],
        ["Signed by", contract.signedBy ?? "unsigned"],
        ["Proof", contract.proofCommand],
      ]),
    );
  } else if (status.nearestContract) {
    out.push(line("attention", "No contract for this exact revision"));
    out.push(
      wrapText(
        `The newest contract is for ${status.nearestContract.commit.slice(0, 12)}. Applying it is a deliberate choice: iwomc rescue --contract ${status.nearestContract.id}`,
      ),
    );
  } else {
    out.push(line("neutral", "No contract stored for this project yet"));
    out.push(wrapText("Run `iwomc capture` on a checkout where the project works."));
  }

  out.push(heading("Ecosystem support"));
  out.push(line(supportTone(status.support.level), humanLabel(status.support.level), status.support.reason));
  for (const entry of status.support.recognized) {
    out.push(bullet(`${entry.manager} (${humanLabel(entry.support)}) - ${entry.note}`));
  }

  out.push(heading("Proof command"));
  if (status.proof.configured) {
    out.push(line("ready", "Configured", status.proof.command ?? ""));
  } else {
    out.push(line("attention", "Not configured", "IWOMC cannot report `working` without one."));
    out.push(wrapText('Set it with: iwomc proof "npm test"'));
  }

  if (status.recentRuns.length > 0) {
    out.push(heading("Recent rescue runs"));
    for (const run of status.recentRuns.slice(0, 5)) {
      out.push(
        line(terminalTone(run.state), humanLabel(run.state).padEnd(13), `${run.commit.slice(0, 12)}  ${run.startedAt}`),
      );
    }
  }

  out.push(heading("Device and integrations"));
  out.push(
    keyValue([
      ["Mode", status.mode === "team" ? "team" : "local only"],
      ["Device", `${status.device.displayName} (${status.device.state}, ${status.device.platform})`],
      [
        "Identity",
        status.device.localOnly
          ? `${status.device.identity} (local team identity; GitHub carries source)`
          : status.device.identity,
      ],
      ["Memory", `${status.memory.status} - ${status.memory.detail}`],
    ]),
  );
  for (const integration of status.integrations) {
    out.push(
      line(
        integration.status === "connected" ? "ready" : integration.configured ? "info" : "neutral",
        `${integration.label.padEnd(24)} ${humanLabel(integration.status)}`,
      ),
    );
    if (integration.status !== "connected") {
      out.push(bullet(integration.nextAction, "     "));
    }
  }

  if (status.driftCount > 0) {
    out.push(heading("Drift"));
    out.push(
      line(
        "attention",
        `${status.driftCount} finding(s) at this revision`,
        "run `iwomc promote` to see a reviewable repository diff",
      ),
    );
  }

  return out.join("\n");
}

export function renderCapture(result: CaptureResult): string {
  const out: string[] = [];
  out.push(heading("Captured"));
  out.push(
    keyValue([
      ["Project", result.project.projectName],
      ["Revision", result.project.commit.slice(0, 12)],
      ["Receipt", result.receipt.id],
      ["Evidence items", String(result.receipt.evidence.length)],
      ["Inventories", String(result.receipt.inventories.length)],
      ["Secret names", result.secretNames.length > 0 ? result.secretNames.join(", ") : "none found"],
    ]),
  );


  if (result.contract) {
    out.push(heading("Candidate contract"));
    out.push(
      line(
        terminalTone(result.contract.state),
        humanLabel(result.contract.state),
        `${humanLabel(result.contract.support)} support`,
      ),
    );
    out.push(
      keyValue([
        ["Id", result.contract.id],
        ["Digest", result.contract.digest.slice(0, 26)],
        ["Steps", String(result.contract.steps.length)],
        ["Proof", result.contract.proof.argv.join(" ")],
        ["Signed by", result.contract.signature?.signer ?? "unsigned"],
      ]),
    );
    for (const step of result.contract.steps) {
      out.push(bullet(`${humanLabel(step.kind)}: ${step.description}`));
    }
  } else {
    out.push(heading("No contract was produced"));
    out.push(line("attention", "Evidence only", result.supportReason));
  }

  if (result.drift.length > 0) {
    out.push(heading("Drift found"));
    for (const finding of result.drift) {
      out.push(line("attention", humanLabel(finding.kind), finding.summary));
      out.push(bullet(`review file: ${finding.affectedDeclaration}`, "     "));
    }
    out.push("");
    out.push(style.dim("  Run `iwomc promote` to turn these into a reviewable repository diff."));
  }

  if (result.coverage.length > 0) {
    out.push(heading("What this capture could not see"));
    for (const gap of result.coverage.slice(0, 12)) {
      out.push(bullet(`${style.bold(gap.area)}: ${gap.reason}`));
    }
  }

  if (result.blockers.length > 0) {
    out.push(heading("Limits on this capture"));
    for (const blocker of result.blockers) out.push(line("attention", blocker));
  }

  return out.join("\n");
}

export function renderVerify(result: VerifyResult): string {
  const out: string[] = [];
  out.push(heading("Verification"));
  if (!result.attestation) {
    out.push(line("attention", BLOCKER_LABELS[result.blocker?.code ?? "internal_error"], result.blocker?.message ?? ""));
    if (result.blocker) out.push(`\n  ${style.bold("Next:")} ${result.blocker.nextAction}`);
    return out.join("\n");
  }
  const attestation = result.attestation;
  out.push(
    line(
      attestation.state === "passed" ? "ready" : "danger",
      humanLabel(attestation.state),
      `${humanLabel(attestation.verifier)} - ${assuranceLabel(attestation.assurance)}`,
    ),
  );
  const provedOn = `${attestation.platform.os}/${attestation.platform.arch}`;
  const targets = result.contract?.targets?.map((t) => `${t.os}/${t.arch}`) ?? [];
  const provedElsewhere = targets.length > 0 && !targets.includes(provedOn);

  out.push(
    keyValue([
      ["Contract", attestation.contractDigest.slice(0, 26)],
      // Which machine the proof actually ran on. A remote verifier runs Linux
      // whatever the contract targets, and "clean verified" without this reads
      // as "verified for you" to someone on another platform.
      ["Proved on", provedOn],
      ["Proof exit", String(attestation.proofExitCode ?? "not reached")],
      ["Steps run", String(attestation.stepExitCodes.length)],
      ["Cleanup", attestation.cleanup],
      ...(attestation.cost ? ([["Cost", `USD ${attestation.cost.amount.toFixed(4)} (${attestation.cost.basis})`]] as [string, string][]) : []),
    ]),
  );
  if (provedElsewhere) {
    out.push("");
    out.push(
      wrapText(
        `This contract targets ${targets.join(", ")}, and the proof ran on ${provedOn}. That shows its steps are sound and reproducible on a clean machine; it is not evidence about ${targets.join(", ")} specifically.`,
      ),
    );
  }

  if (attestation.failureReason) {
    out.push("");
    out.push(wrapText(attestation.failureReason));
  }
  if (result.contract && attestation.state === "passed") {
    out.push("");
    out.push(line("ready", `Contract is now ${result.contract.state}`));
  }
  return out.join("\n");
}

interface RescueLike {
  readonly state: string;
  readonly runId: string;
  readonly blocker: { code: keyof typeof BLOCKER_LABELS; message: string; nextAction: string } | null;
  readonly proof: { exitCode: number | null; durationMs: number } | null;
  readonly outcome: { stepsApplied: readonly string[]; assurance: string; journalDigest: string };
  readonly explanations: readonly { title: string; text: string; createdAt: string | null }[];
  readonly memoryDetail: string;
}

export function renderRescue(result: RescueLike): string {
  const out: string[] = [];
  out.push(heading("Result"));
  out.push(line(terminalTone(result.state), style.bold(result.state.toUpperCase())));

  if (result.state === "working") {
    out.push(
      wrapText(
        `The proof command passed on this checkout (exit ${result.proof?.exitCode ?? 0}, ${Math.round((result.proof?.durationMs ?? 0) / 100) / 10}s). ${result.outcome.stepsApplied.length} step(s) were applied.`,
      ),
    );
  } else if (result.blocker) {
    out.push(wrapText(result.blocker.message));
    out.push("");
    out.push(`  ${style.bold("Next:")} ${result.blocker.nextAction}`);
  }

  out.push("");
  out.push(
    keyValue([
      ["Run", result.runId],
      ["Assurance", assuranceLabel(result.outcome.assurance)],
      ["Journal", result.outcome.journalDigest.slice(0, 26)],
    ]),
  );

  if (result.explanations.length > 0) {
    out.push(heading("Why this environment looks like this"));
    out.push(style.dim("  From durable memory. Explanation only - never used as environment truth."));
    for (const hit of result.explanations.slice(0, 3)) {
      out.push(bullet(`${hit.title}${hit.createdAt ? style.dim(` (${hit.createdAt})`) : ""}`));
      out.push(wrapText(hit.text.slice(0, 240), 74, "      "));
    }
  }
  return out.join("\n");
}

export function renderPromote(result: PromoteResult, applied: boolean): string {
  const out: string[] = [];
  out.push(heading("Proposed repository repair"));
  if (result.blocker) {
    out.push(line("attention", BLOCKER_LABELS[result.blocker.code], result.blocker.message));
    out.push(`\n  ${style.bold("Next:")} ${result.blocker.nextAction}`);
    return out.join("\n");
  }
  if (!result.repair) {
    out.push(line("neutral", "Nothing to promote"));
    return out.join("\n");
  }
  out.push(wrapText(result.repair.description));
  out.push("");
  for (const file of result.repair.files) {
    out.push(style.bold(`  ${file.path}`));
    for (const diffLine of file.unifiedDiff.split("\n")) {
      const tone: Tone = diffLine.startsWith("+") ? "ready" : diffLine.startsWith("-") ? "danger" : "neutral";
      out.push(`    ${tone === "ready" ? style.ready(diffLine) : tone === "danger" ? style.danger(diffLine) : style.dim(diffLine)}`);
    }
    out.push("");
  }
  if (applied) {
    out.push(line("ready", `Applied to ${result.applied.length} file(s)`, result.applied.join(", ")));
    out.push(wrapText("Review with `git diff`, commit, then run `iwomc capture` and `iwomc verify` again."));
  } else {
    out.push(style.dim("  Nothing was written. Re-run with --apply to write exactly these files."));
  }
  return out.join("\n");
}

export function renderDoctor(report: DoctorResult): string {
  const out: string[] = [];
  out.push(heading("Local checks"));
  for (const check of report.checks) {
    out.push(line(check.status === "ok" ? "ready" : check.status === "warn" ? "attention" : "danger", check.name, check.detail));
    if (check.nextAction) out.push(`      ${style.bold("Next:")} ${check.nextAction}`);
  }

  out.push(heading("Verifiers"));
  for (const verifier of report.verifiers) {
    out.push(
      line(verifier.available ? "ready" : "attention", verifier.label, verifier.detail),
    );
    if (verifier.remainingBudgetUsd !== undefined) {
      out.push(bullet(`Remaining budget: USD ${verifier.remainingBudgetUsd.toFixed(2)}`, "     "));
    }
  }

  out.push(heading("Durable memory"));
  out.push(line(report.memory.status === "connected" ? "ready" : "attention", report.memory.status, report.memory.detail));

  out.push(heading("Integrations"));
  for (const integration of report.integrations) {
    out.push(
      line(
        integration.status === "connected" ? "ready" : integration.configured ? "info" : "neutral",
        `${integration.label} - ${integration.status}`,
      ),
    );
    for (const requirement of integration.requirements) {
      out.push(
        bullet(
          `${requirement.present ? style.ready("set") : style.dim("missing")}  ${requirement.name} ${style.dim(requirement.description)}`,
          "     ",
        ),
      );
    }
    out.push(`      ${style.bold("Next:")} ${integration.nextAction}`);
  }
  return out.join("\n");
}

function assuranceLabel(assurance: string): string {
  switch (assurance) {
    case "clean_verified":
      return "clean verified (Modal)";
    case "locally_checked":
      return "locally checked (fresh directory on this machine)";
    default:
      return "unverified";
  }
}

function supportTone(level: string): Tone {
  return level === "native" ? "ready" : level === "recipe" ? "attention" : "neutral";
}

// ---------------------------------------------------------------------------
// The package timeline
// ---------------------------------------------------------------------------

type TimelineResult = Awaited<ReturnType<Companion["timeline"]>>;
type TimelineDiffResult = Awaited<ReturnType<Companion["timelineDiff"]>>;
type SweepResult = Awaited<ReturnType<Companion["sweepOnce"]>>["result"];

const KIND_TONE: Readonly<Record<string, Tone>> = {
  installed: "ready",
  upgraded: "info",
  downgraded: "attention",
  removed: "danger",
};

const KIND_ARROW: Readonly<Record<string, string>> = {
  installed: "+",
  upgraded: "^",
  downgraded: "v",
  removed: "-",
};

/**
 * A package.json without a `version` is unusual but legal, and local packages
 * do it. Rendering the gap as blank leaves a reader guessing whether something
 * failed, so it is named instead.
 */
function versionLabel(version: string | null): string {
  if (version === null) return "";
  return version.trim().length === 0 ? "unknown version" : version;
}

function versionMove(fromVersion: string | null, toVersion: string | null): string {
  if (fromVersion === null) return versionLabel(toVersion);
  if (toVersion === null) return `${versionLabel(fromVersion)} removed`;
  return `${versionLabel(fromVersion)} -> ${versionLabel(toVersion)}`;
}

export function renderTimeline(result: TimelineResult): string {
  const out: string[] = [];
  const state = result.state;

  out.push(heading("Point in time"));
  if ("kind" in state) {
    out.push(line("attention", "This revision was never observed here", state.commit.slice(0, 12)));
    out.push(wrapText(state.message));
    out.push("");
    out.push(
      wrapText(
        "A teammate who did have it checked out while watching can share their log. IWOMC will not estimate the answer from a nearby revision.",
      ),
    );
    return out.join("\n");
  }

  out.push(
    keyValue([
      ["At", state.at],
      ["Revision", state.commit ? state.commit.slice(0, 12) : "not recorded"],
      ["Packages", String(state.packages.length)],
      ["Events replayed", `${state.replayedEvents} of ${result.totalEvents} recorded`],
    ]),
  );

  if (result.recentEvents.length > 0) {
    out.push(heading("Most recent changes"));
    for (const event of [...result.recentEvents].reverse().slice(0, 12)) {
      const tone = KIND_TONE[event.kind] ?? "neutral";
      out.push(
        line(
          tone,
          `${KIND_ARROW[event.kind] ?? " "} ${event.name}`,
          `${versionMove(event.fromVersion, event.toVersion)}  ${style.dim(event.at)}`,
        ),
      );
      if (event.cause) {
        out.push(style.dim(`      ran: ${event.cause.argv.join(" ")}`));
      }
    }
  } else {
    out.push(heading("Most recent changes"));
    out.push(
      wrapText(
        "Nothing has changed since IWOMC started watching this project. Run `iwomc watch` in the background to record installs as they happen.",
      ),
    );
  }

  if (state.coverage.length > 0) {
    out.push(heading("What this answer does not cover"));
    for (const gap of state.coverage) {
      out.push(line("attention", humanLabel(gap.area)));
      out.push(wrapText(gap.reason, 74, "      "));
      if (gap.remediation) out.push(style.dim(`      ${gap.remediation}`));
    }
  }

  out.push(renderMemoryNarration(result.memory));
  return out.join("\n");
}

function renderMemoryNarration(memory: TimelineResult["memory"]): string {
  const out: string[] = [];
  out.push(heading("What the agent was doing"));
  if (memory === null) {
    out.push(style.dim("  Memory integration is not configured. The record above is unaffected."));
    return out.join("\n");
  }
  if (memory.status.status !== "connected") {
    out.push(line("attention", "Memory disconnected", memory.status.detail));
    out.push(style.dim("  The record above is deterministic and unaffected."));
    return out.join("\n");
  }
  if (memory.entries.length === 0) {
    out.push(style.dim("  Claude-Mem holds no observations near this moment."));
    return out.join("\n");
  }
  out.push(style.dim("  From durable memory. Explanation only - never used as environment truth."));
  for (const entry of memory.entries.slice(0, 6)) {
    out.push(bullet(`${entry.title}${entry.at ? style.dim(` (${entry.at})`) : ""}`));
    out.push(wrapText(entry.text.slice(0, 200), 74, "      "));
  }
  return out.join("\n");
}

export function renderTimelineDiff(result: TimelineDiffResult): string {
  const out: string[] = [];
  out.push(heading("Difference between two points"));

  if (result.missing.length > 0) {
    for (const missing of result.missing) {
      out.push(line("attention", `Revision ${missing.commit.slice(0, 12)} was never observed here`));
      out.push(wrapText(missing.message));
    }
    return out.join("\n");
  }
  if (result.diff === null) return out.join("\n");

  const label = (side: TimelineDiffResult["from"]) => side.commit?.slice(0, 12) ?? side.at ?? "unknown";
  out.push(keyValue([["From", label(result.from)], ["To", label(result.to)]]));

  if (result.diff.entries.length === 0) {
    out.push("");
    out.push(line("ready", "No package differences", "the two points hold the same installed set"));
  } else {
    out.push("");
    for (const entry of result.diff.entries) {
      out.push(
        line(
          KIND_TONE[entry.kind] ?? "neutral",
          `${KIND_ARROW[entry.kind] ?? " "} ${entry.name}`,
          `${versionMove(entry.fromVersion, entry.toVersion)}  ${style.dim(entry.manager)}`,
        ),
      );
    }
  }

  if (result.diff.coverage.length > 0) {
    out.push(heading("What this comparison does not cover"));
    for (const gap of result.diff.coverage) {
      out.push(line("attention", humanLabel(gap.area)));
      out.push(wrapText(gap.reason, 74, "      "));
    }
  }
  return out.join("\n");
}

export function renderSweep(result: SweepResult): string {
  const out: string[] = [];
  out.push(heading("Observation"));
  out.push(
    keyValue([
      ["At", result.at],
      ["Installed packages", String(result.packageCount)],
      // "Recorded" would be a false label when another recorder owns the log:
      // the changes below are real either way, they are just written down by
      // that recorder rather than by this command.
      [result.recorded ? "Changes recorded" : "Changes seen", String(result.events.length)],
      ["Revision", result.commit ? result.commit.slice(0, 12) : "not recorded"],
    ]),
  );
  for (const event of result.events) {
    out.push(
      line(
        KIND_TONE[event.kind] ?? "neutral",
        `${KIND_ARROW[event.kind] ?? " "} ${event.name}`,
        versionMove(event.fromVersion, event.toVersion),
      ),
    );
  }
  if (result.unavailable.length > 0) {
    out.push(heading("Not readable this sweep"));
    for (const entry of result.unavailable) {
      out.push(line("attention", entry.manager));
      out.push(wrapText(entry.reason, 74, "      "));
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Where the team's machines differ
// ---------------------------------------------------------------------------

type AgreementView = NonNullable<StatusResult["agreement"]>;

/**
 * Only shown when there is something to say. An empty "everything agrees"
 * panel on a one-person team would be noise, and worse, it would imply a
 * comparison happened when there was nothing to compare.
 */
export function renderAgreement(agreement: AgreementView): string {
  const out: string[] = [];
  out.push(heading("How the team's machines compare"));

  if (agreement.disputed.length === 0) {
    out.push(
      line(
        "ready",
        `${agreement.contractCount} captures agree`,
        `all ${agreement.agreedPackages} packages match across ${agreement.platform}`,
      ),
    );
  } else {
    out.push(
      line(
        "attention",
        `${agreement.contractCount} captures of this revision disagree`,
        `${agreement.disputed.length} of ${agreement.agreedPackages + agreement.disputed.length} packages differ on ${agreement.platform}`,
      ),
    );
    for (const entry of agreement.disputed.slice(0, 8)) {
      const answers = entry.variants
        .map((variant) => {
          const held = `${variant.contractIds.length}`;
          // "not required" is the interesting one: somebody has a package the
          // others have never installed.
          return variant.versionSpec === null
            ? `${held}x not required`
            : `${held}x ${variant.versionSpec}`;
        })
        .join(", ");
      out.push(line("neutral", `  ${entry.name}`, `${answers}  ${style.dim(entry.manager)}`));
    }
    if (agreement.disputed.length > 8) {
      out.push(style.dim(`      and ${agreement.disputed.length - 8} more.`));
    }
    out.push("");
    out.push(
      wrapText(
        "IWOMC does not know which machine is right. It applies the contract with the most evidence behind it; this is only telling you the team has drifted apart.",
      ),
    );
  }

  if (agreement.notCompared.length > 0) {
    out.push(
      style.dim(
        `  Not compared: captures for ${agreement.notCompared.join(", ")}. Differences between operating systems are expected.`,
      ),
    );
  }
  return out.join("\n");
}

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
          ? `${status.device.identity} (local identity - sign in with GitHub to share a workspace)`
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
      out.push(bullet(`declared in ${finding.affectedDeclaration}`, "     "));
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
  out.push(
    keyValue([
      ["Contract", attestation.contractDigest.slice(0, 26)],
      ["Proof exit", String(attestation.proofExitCode ?? "not reached")],
      ["Steps run", String(attestation.stepExitCodes.length)],
      ["Cleanup", attestation.cleanup],
      ...(attestation.cost ? ([["Cost", `USD ${attestation.cost.amount.toFixed(4)} (${attestation.cost.basis})`]] as [string, string][]) : []),
    ]),
  );
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

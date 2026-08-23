import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { blocker, digestBytes, type Blocker, type DriftFinding, type ProposedFileChange, type ProposedRepair } from "@iwomc/contracts";
import { unifiedDiff, type AdapterRegistry, type EvidenceBundle } from "@iwomc/adapters";
import { MANAGED_DIR, resolveInsideProject } from "./paths.js";
import type { ProjectContext } from "./project.js";

/**
 * Promotion (design 4.4).
 *
 * When a rescue worked but the repository still does not declare what made it
 * work, promote turns that gap into an ordinary reviewable file diff. It never
 * writes anything until a human passes `apply`, and it only touches the files
 * named in the proposal (R6.5).
 */

export interface PromotionProposal {
  readonly repair: ProposedRepair | null;
  readonly findings: readonly DriftFinding[];
  readonly blocker: Blocker | null;
}

export async function proposePromotion(input: {
  project: ProjectContext;
  registry: AdapterRegistry;
  findings: readonly DriftFinding[];
}): Promise<PromotionProposal> {
  const actionable = input.findings.filter((finding) => finding.kind !== "declared_not_installed");
  if (actionable.length === 0) {
    return {
      repair: null,
      findings: [],
      blocker: blocker(
        "policy_denied",
        "There is nothing to promote: the repository already declares everything the last capture observed.",
        "Run `iwomc capture` on a working checkout first, then promote if drift is found.",
      ),
    };
  }

  // Findings compose: each adapter sees the content earlier findings already
  // proposed for the same file, so two repairs to one manifest both survive.
  const pending = new Map<string, string>();
  const originals = new Map<string, string | null>();

  for (const finding of actionable) {
    const adapter = input.registry.byId(finding.adapterId);
    if (!adapter) continue;
    const declared = await adapter.readDeclaredState({
      projectDir: input.project.projectDir,
      files: input.project.files,
      platform: input.project.platform,
      probe: async () => ({ ok: false, exitCode: null, stdout: "", stderr: "", timedOut: false, notFound: true }),
    });
    const bundle: EvidenceBundle = {
      projectDir: input.project.projectDir,
      platform: input.project.platform,
      declared,
      observed: [],
      evidence: [],
      managedDir: MANAGED_DIR,
    };
    for (const change of await adapter.proposeRepair(bundle, finding, pending)) {
      if (!originals.has(change.path)) originals.set(change.path, change.before);
      pending.set(change.path, change.after);
    }
  }

  const files = new Map<string, ProposedFileChange>();
  for (const [path, after] of pending) {
    const before = originals.get(path) ?? null;
    if (before !== null && before === after) continue;
    files.set(path, { path, before, after, unifiedDiff: unifiedDiff(path, before ?? "", after) });
  }

  if (files.size === 0) {
    return {
      repair: null,
      findings: actionable,
      blocker: blocker(
        "unsupported_ecosystem",
        "Drift was found, but no adapter can express it as a repository change.",
        "Edit the declaration by hand, then run `iwomc capture` and `iwomc verify` again.",
      ),
    };
  }

  const changes = [...files.values()];
  return {
    repair: {
      id: randomUUID(),
      description: `Declare ${actionable.length} environment fact(s) the last capture observed but the repository does not state.`,
      files: changes,
      requiresReview: true,
    },
    findings: actionable,
    blocker: null,
  };
}

/**
 * Write a reviewed proposal to disk. Refuses when a target file changed since
 * the proposal was produced, so a review always applies to what was reviewed.
 */
export async function applyPromotion(input: {
  project: ProjectContext;
  repair: ProposedRepair;
}): Promise<{ applied: string[]; blocker: Blocker | null }> {
  const applied: string[] = [];
  for (const change of input.repair.files) {
    const target = resolveInsideProject(input.project.projectDir, change.path);
    if (target === null) {
      return {
        applied,
        blocker: blocker(
          "policy_denied",
          `The proposal names ${change.path}, which is outside the checkout.`,
          "Reject this proposal.",
        ),
      };
    }
    let current: string | null = null;
    try {
      current = await readFile(target, "utf8");
    } catch {
      current = null;
    }
    if (change.before !== null && current !== null && digestBytes(current) !== digestBytes(change.before)) {
      return {
        applied,
        blocker: blocker(
          "policy_denied",
          `${change.path} changed since the proposal was reviewed.`,
          "Run `iwomc promote` again to regenerate the diff against the current file.",
        ),
      };
    }
    await writeFile(target, change.after, "utf8");
    applied.push(change.path);
  }
  return { applied, blocker: null };
}

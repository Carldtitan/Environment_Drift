import { Card, Mono, Pill } from "./primitives.tsx";
import type { Device, TeamContract } from "../api.ts";

/**
 * Where the team's machines differ about one revision.
 *
 * A single capture says what one computer had. Several captures of the same
 * revision, from several computers, say something a single one never can:
 * whether the team is actually running the same software. When they are not,
 * this is the first place anyone finds out - before a checkout breaks, and
 * without anyone having to notice.
 *
 * It renders nothing at all when fewer than two captures are comparable.
 * "Nothing to compare" and "compared and found to agree" are different facts,
 * and a panel that showed the first as though it were the second would be
 * claiming a check that never happened.
 */

interface Variant {
  versionSpec: string | null;
  contractIds: string[];
}

export interface AgreementSummary {
  commit: string;
  contractCount: number;
  platform: string;
  agreedPackages: number;
  captures: { contractId: string; state: string; issuedAt: string; keyId: string | null }[];
  disputed: { ecosystem: string; manager: string; name: string; variants: Variant[] }[];
  notCompared: string[];
}

/**
 * Compare the captures the console already holds.
 *
 * The same rules the Companion applies: only captures for one platform are
 * compared against each other, because a difference between operating systems
 * is expected rather than suspicious.
 */
export function summarizeAgreement(
  contracts: readonly TeamContract[],
  commit: string,
): AgreementSummary | null {
  const forRevision = contracts.filter((entry) => entry.contract.source.commit === commit);
  if (forRevision.length < 2) return null;

  // Group by the platform each capture targets, and compare the largest group.
  const groups = new Map<string, TeamContract[]>();
  for (const entry of forRevision) {
    for (const target of entry.contract.targets) {
      const label = `${target.os}/${target.arch}`;
      groups.set(label, [...(groups.get(label) ?? []), entry]);
    }
  }
  const ranked = [...groups.entries()].sort((left, right) => right[1].length - left[1].length);
  const [platform, here] = ranked[0] ?? ["", []];
  if (here.length < 2) return null;

  const shape = new Map<string, { ecosystem: string; manager: string; name: string }>();
  const byContract = new Map<string, Map<string, string>>();
  for (const entry of here) {
    const requirements = new Map<string, string>();
    for (const requirement of entry.contract.requirements.packages) {
      const id = `${requirement.source}|${requirement.name}`;
      requirements.set(id, requirement.versionSpec);
      shape.set(id, {
        ecosystem: "",
        manager: requirement.source,
        name: requirement.name,
      });
    }
    byContract.set(entry.contract.id, requirements);
  }

  let agreedPackages = 0;
  const disputed: AgreementSummary["disputed"] = [];
  for (const [id, descriptor] of shape) {
    const holders = new Map<string | null, string[]>();
    for (const entry of here) {
      const spec = byContract.get(entry.contract.id)?.get(id) ?? null;
      holders.set(spec, [...(holders.get(spec) ?? []), entry.contract.id]);
    }
    if (holders.size === 1) {
      agreedPackages += 1;
      continue;
    }
    disputed.push({
      ...descriptor,
      variants: [...holders.entries()]
        .map(([versionSpec, contractIds]) => ({ versionSpec, contractIds }))
        .sort((left, right) => right.contractIds.length - left.contractIds.length),
    });
  }
  disputed.sort((left, right) => left.name.localeCompare(right.name));

  const notCompared = ranked
    .slice(1)
    .map(([label]) => label)
    .sort();

  return {
    commit,
    contractCount: here.length,
    platform,
    agreedPackages,
    captures: here.map((entry) => ({
      contractId: entry.contract.id,
      state: entry.contract.state,
      issuedAt: entry.contract.issuedAt,
      keyId: entry.contract.signature?.keyId ?? null,
    })),
    disputed,
    notCompared,
  };
}

/**
 * Name the machine behind a capture, when the roster knows it.
 *
 * A contract carries no person's name - only the opaque id of the device that
 * signed it. Resolving that against the workspace's devices is the one honest
 * way to say who; where it is unknown, the short key is shown rather than a
 * guess.
 */
function machineFor(keyId: string | null, devices: readonly Device[]): string {
  if (keyId === null) return "an unsigned capture";
  const device = devices.find((entry) => entry.id === keyId);
  return device ? device.displayName : `device ${keyId.slice(0, 8)}`;
}

/** A capture's moment, for when naming the machine would not distinguish it. */
function momentFor(issuedAt: string): string {
  const parsed = new Date(issuedAt);
  return Number.isNaN(parsed.getTime()) ? issuedAt : parsed.toLocaleString();
}

export function TeamAgreement({
  agreement,
  devices,
}: {
  agreement: AgreementSummary;
  devices: readonly Device[];
}) {
  const total = agreement.agreedPackages + agreement.disputed.length;

  // Two captures from *different* machines are best told apart by machine.
  // Two from the same one - the same person capturing twice, having changed
  // something in between - are not: naming that device on both sides of a
  // disagreement reads as nonsense. Then the distinguishing fact is when.
  const distinctMachines = new Set(agreement.captures.map((entry) => entry.keyId ?? entry.contractId));
  const byMachine = distinctMachines.size === agreement.captures.length;

  const describeHolders = (ids: readonly string[]): string => {
    const labels = ids.map((id) => {
      const capture = agreement.captures.find((entry) => entry.contractId === id);
      if (!capture) return "an unknown capture";
      return byMachine
        ? machineFor(capture.keyId, devices)
        : `the capture from ${momentFor(capture.issuedAt)}`;
    });
    return [...new Set(labels)].join(", ");
  };

  return (
    <Card
      title="How the team's machines compare"
      action={
        agreement.disputed.length === 0 ? (
          <Pill tone="ready">all agree</Pill>
        ) : (
          <Pill tone="attention">
            {agreement.disputed.length} of {total} differ
          </Pill>
        )
      }
    >
      <p className="hint">
        {agreement.contractCount} captures of <Mono>{agreement.commit.slice(0, 12)}</Mono> on{" "}
        {agreement.platform}
        {agreement.notCompared.length > 0
          ? `. Captures for ${agreement.notCompared.join(", ")} are not compared, because a difference between operating systems is expected.`
          : "."}
      </p>

      {agreement.disputed.length === 0 ? (
        <p className="hint" style={{ marginTop: 12 }}>
          Every compared capture requires the same {agreement.agreedPackages} packages at the same
          versions.
        </p>
      ) : (
        <>
          <ul className="record-list" style={{ marginTop: 12 }}>
            {agreement.disputed.map((entry) => (
              <li key={`${entry.manager}/${entry.name}`} className="record">
                <span className="record__label">{entry.name}</span>
                <span className="record__meta record__meta--wrap">
                  {entry.variants.map((variant, index) => (
                    <span key={variant.versionSpec ?? "absent"}>
                      {index > 0 ? " · " : ""}
                      {variant.versionSpec === null ? (
                        <em>not required</em>
                      ) : (
                        <Mono>{variant.versionSpec}</Mono>
                      )}{" "}
                      {byMachine ? "on" : "in"} {describeHolders(variant.contractIds)}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <p className="hint" style={{ marginTop: 14 }}>
            IWOMC does not know which machine is right. It applies the contract with the most
            evidence behind it; this only tells you the team has drifted apart.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * Where a team's machines disagree about one revision.
 *
 * On a team of one this module has nothing to say: there is a single contract
 * per revision and nothing to compare it against. On a team of ten, several
 * people capture the same commit from their own machines, and those captures
 * do not always match. One person has a package the others do not. Two people
 * are on different versions of the same thing. Everyone else agrees.
 *
 * That disagreement is the earliest warning a team gets. It appears *before*
 * anyone's checkout breaks: the moment two machines that are supposed to be
 * running the same revision are found to be running different software. IWOMC
 * already holds every ingredient - captured, signed contracts - and until now
 * simply picked one and threw the comparison away.
 *
 * Two rules keep this honest:
 *
 * Only like is compared with like. A macOS capture and a Windows capture
 * differ for good reasons, and reporting those as disagreement would bury the
 * real signal in noise. Contracts are grouped by platform first.
 *
 * Disagreement is reported, never resolved. IWOMC does not know which machine
 * is right, and says so. Which contract gets *applied* is a separate decision
 * made on evidence, in `choose-contract.ts`.
 */

import type { EnvironmentContractV1, PlatformTarget } from "@iwomc/contracts";

export interface ComparableContract {
  readonly id: string;
  readonly state?: string;
  readonly contract: EnvironmentContractV1;
}

/** One package the team's captures do not agree on. */
export interface DisputedPackage {
  readonly ecosystem: string;
  readonly manager: string;
  readonly name: string;
  /**
   * The distinct answers, the most widely held first.
   *
   * A `versionSpec` of null means those contracts do not require the package
   * at all - which is the classic case: one machine has something the others
   * have never installed.
   */
  readonly variants: readonly {
    readonly versionSpec: string | null;
    readonly contractIds: readonly string[];
  }[];
}

/** Which capture a disagreement came from, so a person can go and ask. */
export interface CaptureSource {
  readonly contractId: string;
  readonly state: string;
  readonly issuedAt: string;
  /**
   * The signing device's opaque id, or null for an unsigned capture.
   *
   * A team surface resolves this to a device and its owner. IWOMC does not
   * put a person's name in a contract, so this is the only honest link - and
   * where the roster is unknown, showing the short key is better than
   * inventing an attribution.
   */
  readonly keyId: string | null;
}

export interface Agreement {
  readonly commit: string;
  /** Captures compared. Below two there is nothing to compare. */
  readonly contractCount: number;
  /**
   * The captures being compared, in the order their ids appear elsewhere in
   * this result. "Two machines disagree" is only actionable once you know
   * which two.
   */
  readonly captures: readonly CaptureSource[];
  readonly platform: string;
  /** Packages every compared capture requires at the same version. */
  readonly agreedPackages: number;
  readonly disputed: readonly DisputedPackage[];
  /**
   * Platforms with captures that were not compared against these, because a
   * difference between operating systems is expected rather than suspicious.
   */
  readonly notCompared: readonly string[];
}

function key(manager: string, name: string): string {
  return `${manager}|${name}`;
}

function platformLabel(target: PlatformTarget): string {
  return `${target.os}/${target.arch}`;
}

/**
 * Compare the captures for one revision that apply to one platform.
 *
 * Returns null when there is nothing to say: fewer than two comparable
 * captures. A caller should show nothing at all rather than an empty panel
 * implying the team was checked and found to agree.
 */
export function agreementFor(
  contracts: readonly ComparableContract[],
  platform: PlatformTarget,
): Agreement | null {
  const here = contracts.filter((entry) =>
    entry.contract.targets.some(
      (target) => target.os === platform.os && target.arch === platform.arch,
    ),
  );
  if (here.length < 2) return null;

  const notCompared = new Set<string>();
  for (const entry of contracts) {
    if (here.includes(entry)) continue;
    for (const target of entry.contract.targets) notCompared.add(platformLabel(target));
  }

  // What each capture says about each package, and the union of everything
  // any of them mentions.
  const byContract = new Map<string, Map<string, string>>();
  const shape = new Map<string, { ecosystem: string; manager: string; name: string }>();
  for (const entry of here) {
    const requirements = new Map<string, string>();
    for (const requirement of entry.contract.requirements.packages) {
      const id = key(requirement.manager, requirement.name);
      requirements.set(id, requirement.versionSpec);
      shape.set(id, {
        ecosystem: requirement.ecosystem,
        manager: requirement.manager,
        name: requirement.name,
      });
    }
    byContract.set(entry.id, requirements);
  }

  let agreedPackages = 0;
  const disputed: DisputedPackage[] = [];

  for (const [id, descriptor] of shape) {
    const holders = new Map<string | null, string[]>();
    for (const entry of here) {
      const spec = byContract.get(entry.id)?.get(id) ?? null;
      const existing = holders.get(spec);
      if (existing) existing.push(entry.id);
      else holders.set(spec, [entry.id]);
    }

    if (holders.size === 1) {
      // Every capture said the same thing, including "all of them require it
      // at this version". A package none of them requires cannot appear here.
      agreedPackages += 1;
      continue;
    }

    const variants = [...holders.entries()]
      .map(([versionSpec, contractIds]) => ({ versionSpec, contractIds }))
      .sort((left, right) => {
        // The majority answer first; then a stable order so two machines
        // rendering the same data show the same thing.
        const byCount = right.contractIds.length - left.contractIds.length;
        if (byCount !== 0) return byCount;
        return (left.versionSpec ?? "").localeCompare(right.versionSpec ?? "");
      });

    disputed.push({ ...descriptor, variants });
  }

  disputed.sort((left, right) => key(left.manager, left.name).localeCompare(key(right.manager, right.name)));

  return {
    commit: here[0]?.contract.source.commit ?? "",
    contractCount: here.length,
    captures: here.map((entry) => ({
      contractId: entry.id,
      state: entry.state ?? entry.contract.state,
      issuedAt: entry.contract.issuedAt,
      keyId: entry.contract.signature?.keyId ?? null,
    })),
    platform: platformLabel(platform),
    agreedPackages,
    disputed,
    notCompared: [...notCompared].sort(),
  };
}

/** A one-line summary a person can read without expanding anything. */
export function describeAgreement(agreement: Agreement): string {
  const machines = `${agreement.contractCount} captures of this revision on ${agreement.platform}`;
  if (agreement.disputed.length === 0) {
    return `${machines} agree on all ${agreement.agreedPackages} packages.`;
  }
  const packages = agreement.disputed.length === 1 ? "package" : "packages";
  return `${machines} disagree on ${agreement.disputed.length} ${packages}, and agree on ${agreement.agreedPackages}.`;
}

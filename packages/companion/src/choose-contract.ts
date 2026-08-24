/**
 * Choosing which contract to apply, when a team has produced several.
 *
 * One person, one machine, one contract per revision: the choice is trivial and
 * this module barely matters. Ten people is different. Several teammates
 * capture the same revision from different machines, some on macOS and some on
 * Windows, some contracts checked and some still candidates, and each device
 * accumulates its own local captures alongside whatever it pulled from the
 * team. Picking the most recently stored one - which is what "newest first"
 * amounts to - means an unchecked candidate captured on a broken machine can
 * beat a contract that was actually verified.
 *
 * Two rules, in this order:
 *
 * 1. It has to be able to run here. A contract that targets another operating
 *    system is not a worse choice, it is not a choice at all - and when one
 *    for this platform exists, taking it is obviously right.
 * 2. Prefer the contract with the most evidence behind it. Verified on a clean
 *    machine beats checked locally, which beats merely approved, which beats a
 *    candidate nobody has looked at. Recency only breaks ties.
 *
 * A contract that was rejected or revoked is never chosen automatically. It can
 * still be named explicitly, and the caller will be told why it is refused.
 */

import type { ContractState, PlatformTarget } from "@iwomc/contracts";

/** Just enough of a stored contract to rank it. */
export interface RankableContract {
  readonly id: string;
  readonly state: ContractState;
  readonly createdAt: string;
  readonly contract: { readonly targets: readonly PlatformTarget[] };
}

/**
 * How much evidence stands behind a contract, lowest first.
 *
 * `unsupported` and `inconclusive` rank last rather than being dropped: if one
 * of them is all that exists, the caller should say *that*, not "no contract
 * exists for this revision".
 */
const TRUST_ORDER: Readonly<Record<ContractState, number>> = {
  clean_verified: 0,
  locally_checked: 1,
  approved: 2,
  candidate: 3,
  inconclusive: 4,
  unsupported: 5,
  // Never chosen for you. Naming one explicitly still works, and still fails
  // with a reason.
  rejected: 99,
  revoked: 99,
  superseded: 99,
};

export function isSelectable(state: ContractState): boolean {
  return (TRUST_ORDER[state] ?? 99) < 99;
}

export function runsOn(contract: RankableContract, platform: PlatformTarget): boolean {
  return contract.contract.targets.some(
    (target) => target.os === platform.os && target.arch === platform.arch,
  );
}

export interface ContractChoice<T extends RankableContract> {
  /** The contract to apply, or null when nothing here can be applied. */
  readonly chosen: T | null;
  /**
   * Contracts for this revision that cannot run on this machine. Non-empty
   * with `chosen: null` means the revision *is* covered - just not for this
   * platform - which is a different problem with a different answer.
   */
  readonly otherPlatforms: readonly T[];
  /** Contracts excluded because they were rejected, revoked, or superseded. */
  readonly withdrawn: readonly T[];
}

export function chooseContract<T extends RankableContract>(
  candidates: readonly T[],
  platform: PlatformTarget,
): ContractChoice<T> {
  const withdrawn = candidates.filter((entry) => !isSelectable(entry.state));
  const usable = candidates.filter((entry) => isSelectable(entry.state));
  const here = usable.filter((entry) => runsOn(entry, platform));
  const elsewhere = usable.filter((entry) => !runsOn(entry, platform));

  const ranked = [...here].sort((left, right) => {
    const byTrust = (TRUST_ORDER[left.state] ?? 99) - (TRUST_ORDER[right.state] ?? 99);
    if (byTrust !== 0) return byTrust;
    // Same evidence: the more recent capture is the better guess at what the
    // project needs now.
    return right.createdAt.localeCompare(left.createdAt);
  });

  return { chosen: ranked[0] ?? null, otherPlatforms: elsewhere, withdrawn };
}

/** Platforms a set of contracts does cover, for a message that helps. */
export function coveredPlatforms(contracts: readonly RankableContract[]): string[] {
  const seen = new Set<string>();
  for (const entry of contracts) {
    for (const target of entry.contract.targets) seen.add(`${target.os}/${target.arch}`);
  }
  return [...seen].sort();
}

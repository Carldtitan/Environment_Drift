import { describe, expect, it } from "vitest";
import { chooseContract, coveredPlatforms, isSelectable, runsOn } from "./choose-contract.js";
import type { ContractState, PlatformTarget } from "@iwomc/contracts";

/**
 * These are the situations a team of ten produces and a team of one never
 * does: several contracts for the same revision, captured on different
 * machines, checked to different degrees, arriving in an order nobody planned.
 */

const MAC: PlatformTarget = { os: "macos", arch: "x64" };
const WINDOWS: PlatformTarget = { os: "windows", arch: "x64" };
const LINUX: PlatformTarget = { os: "linux", arch: "arm64" };

function contract(
  id: string,
  state: ContractState,
  targets: PlatformTarget[],
  hoursIn: number,
): { id: string; state: ContractState; createdAt: string; contract: { targets: PlatformTarget[] } } {
  return {
    id,
    state,
    createdAt: new Date(Date.parse("2026-08-01T00:00:00.000Z") + hoursIn * 3_600_000).toISOString(),
    contract: { targets },
  };
}

describe("choosing between several teammates' contracts", () => {
  it("prefers evidence over recency", () => {
    // The failure this prevents: someone runs `iwomc capture` on the broken
    // machine, and that fresh candidate then beats the contract the team
    // actually verified.
    const choice = chooseContract(
      [
        contract("verified-yesterday", "clean_verified", [MAC], 1),
        contract("candidate-just-now", "candidate", [MAC], 20),
      ],
      MAC,
    );
    expect(choice.chosen?.id).toBe("verified-yesterday");
  });

  it("orders the whole ladder of evidence", () => {
    const all = [
      contract("candidate", "candidate", [MAC], 4),
      contract("approved", "approved", [MAC], 3),
      contract("locally-checked", "locally_checked", [MAC], 2),
      contract("clean-verified", "clean_verified", [MAC], 1),
    ];
    expect(chooseContract(all, MAC).chosen?.id).toBe("clean-verified");
    expect(chooseContract(all.slice(0, 3), MAC).chosen?.id).toBe("locally-checked");
    expect(chooseContract(all.slice(0, 2), MAC).chosen?.id).toBe("approved");
    expect(chooseContract(all.slice(0, 1), MAC).chosen?.id).toBe("candidate");
  });

  it("breaks a tie on evidence with the more recent capture", () => {
    const choice = chooseContract(
      [contract("older", "approved", [MAC], 1), contract("newer", "approved", [MAC], 9)],
      MAC,
    );
    expect(choice.chosen?.id).toBe("newer");
  });

  it("takes the contract for this machine over a better-checked one for another", () => {
    // A mixed-platform team is normal. A contract that cannot run here is not
    // a worse option, it is not an option.
    const choice = chooseContract(
      [
        contract("mac-verified", "clean_verified", [MAC], 8),
        contract("windows-approved", "approved", [WINDOWS], 3),
      ],
      WINDOWS,
    );
    expect(choice.chosen?.id).toBe("windows-approved");
  });

  it("reports a revision that is covered, but not for this machine", () => {
    const choice = chooseContract(
      [
        contract("mac-only", "clean_verified", [MAC], 1),
        contract("linux-only", "approved", [LINUX], 2),
      ],
      WINDOWS,
    );
    expect(choice.chosen).toBeNull();
    // The caller needs this to say "ask a Windows teammate" rather than "no
    // contract exists", which would be asking for work already done.
    expect(coveredPlatforms(choice.otherPlatforms)).toEqual(["linux/arm64", "macos/x64"]);
  });

  it("matches architecture, not only operating system", () => {
    const armMac: PlatformTarget = { os: "macos", arch: "arm64" };
    const choice = chooseContract([contract("intel", "clean_verified", [MAC], 1)], armMac);
    expect(choice.chosen).toBeNull();
    expect(choice.otherPlatforms).toHaveLength(1);
  });

  it("accepts a contract that targets several platforms", () => {
    const choice = chooseContract(
      [contract("universal", "approved", [MAC, WINDOWS, LINUX], 1)],
      LINUX,
    );
    expect(choice.chosen?.id).toBe("universal");
  });

  it("never chooses a contract someone withdrew", () => {
    for (const state of ["rejected", "revoked", "superseded"] as ContractState[]) {
      const choice = chooseContract([contract("withdrawn", state, [MAC], 1)], MAC);
      expect(choice.chosen, `${state} must not be chosen automatically`).toBeNull();
      expect(choice.withdrawn.map((entry) => entry.state)).toEqual([state]);
      expect(isSelectable(state)).toBe(false);
    }
  });

  it("still surfaces an unsupported contract rather than reporting nothing", () => {
    // "Unsupported" is an answer. "No contract exists" is a different, wrong
    // answer that sends someone off to capture one that already exists.
    const choice = chooseContract([contract("cannot-apply", "unsupported", [MAC], 1)], MAC);
    expect(choice.chosen?.id).toBe("cannot-apply");
  });

  it("prefers anything applicable over an unsupported or inconclusive one", () => {
    const choice = chooseContract(
      [
        contract("unsupported", "unsupported", [MAC], 9),
        contract("inconclusive", "inconclusive", [MAC], 8),
        contract("candidate", "candidate", [MAC], 1),
      ],
      MAC,
    );
    expect(choice.chosen?.id).toBe("candidate");
  });

  it("has nothing to say about a revision nobody captured", () => {
    const choice = chooseContract([], MAC);
    expect(choice.chosen).toBeNull();
    expect(choice.otherPlatforms).toEqual([]);
    expect(choice.withdrawn).toEqual([]);
  });

  it("knows whether a contract runs here", () => {
    expect(runsOn(contract("a", "approved", [MAC], 1), MAC)).toBe(true);
    expect(runsOn(contract("a", "approved", [MAC], 1), WINDOWS)).toBe(false);
  });
});

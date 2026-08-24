import { describe, expect, it } from "vitest";
import { agreementFor, describeAgreement, type ComparableContract } from "./agreement.js";
import type { EnvironmentContractV1, PlatformTarget } from "@iwomc/contracts";

const MAC: PlatformTarget = { os: "macos", arch: "x64" };
const WINDOWS: PlatformTarget = { os: "windows", arch: "x64" };

function capture(
  id: string,
  packages: [string, string][],
  target: PlatformTarget = MAC,
): ComparableContract {
  return {
    id,
    contract: {
      targets: [target],
      source: { commit: "c".repeat(40) },
      requirements: {
        packages: packages.map(([name, versionSpec]) => ({
          ecosystem: "node",
          manager: "npm",
          name,
          versionSpec,
        })),
      },
    } as unknown as EnvironmentContractV1,
  };
}

describe("comparing what a team's machines actually have", () => {
  it("has nothing to say about a single capture", () => {
    // Not "everyone agrees" - there is no-one to agree with. Showing a green
    // panel here would claim a comparison that never happened.
    expect(agreementFor([capture("only", [["a", "1.0.0"]])], MAC)).toBeNull();
    expect(agreementFor([], MAC)).toBeNull();
  });

  it("reports agreement when two machines match", () => {
    const result = agreementFor(
      [capture("one", [["a", "1.0.0"], ["b", "2.0.0"]]), capture("two", [["a", "1.0.0"], ["b", "2.0.0"]])],
      MAC,
    );
    expect(result?.contractCount).toBe(2);
    expect(result?.agreedPackages).toBe(2);
    expect(result?.disputed).toEqual([]);
    expect(describeAgreement(result!)).toContain("agree on all 2 packages");
  });

  it("finds a package one machine has and the others do not", () => {
    // The classic case: someone installed a tool with --no-save and it never
    // reached anyone else.
    const result = agreementFor(
      [
        capture("one", [["shared", "1.0.0"]]),
        capture("two", [["shared", "1.0.0"]]),
        capture("odd-one-out", [["shared", "1.0.0"], ["extra", "9.9.9"]]),
      ],
      MAC,
    );
    expect(result?.disputed).toHaveLength(1);
    const extra = result?.disputed[0];
    expect(extra?.name).toBe("extra");
    // Majority first, and "not required" is a real answer rather than a gap.
    expect(extra?.variants[0]).toEqual({ versionSpec: null, contractIds: ["one", "two"] });
    expect(extra?.variants[1]).toEqual({ versionSpec: "9.9.9", contractIds: ["odd-one-out"] });
  });

  it("finds a version two machines disagree about", () => {
    const result = agreementFor(
      [
        capture("majority-a", [["lib", "5.0.0"]]),
        capture("majority-b", [["lib", "5.0.0"]]),
        capture("behind", [["lib", "4.0.0"]]),
      ],
      MAC,
    );
    const lib = result?.disputed[0];
    expect(lib?.variants.map((entry) => entry.versionSpec)).toEqual(["5.0.0", "4.0.0"]);
    expect(lib?.variants[0]?.contractIds).toEqual(["majority-a", "majority-b"]);
  });

  it("does not treat a difference between operating systems as drift", () => {
    // A macOS capture and a Windows capture differ for good reasons. Counting
    // those as disagreement would bury the real signal.
    const result = agreementFor(
      [
        capture("mac-one", [["shared", "1.0.0"]]),
        capture("mac-two", [["shared", "1.0.0"]]),
        capture("windows", [["shared", "1.0.0"], ["windows-only", "1.0.0"]], WINDOWS),
      ],
      MAC,
    );
    expect(result?.contractCount).toBe(2);
    expect(result?.disputed).toEqual([]);
    // But it says so, rather than pretending the Windows capture is not there.
    expect(result?.notCompared).toEqual(["windows/x64"]);
  });

  it("needs two captures for *this* platform, not two captures overall", () => {
    expect(
      agreementFor([capture("mac", [["a", "1.0.0"]]), capture("win", [["a", "1.0.0"]], WINDOWS)], MAC),
    ).toBeNull();
  });

  it("orders disagreements the same way every time", () => {
    // Two people looking at the same data must see the same list, or they
    // cannot talk to each other about it.
    const contracts = [
      capture("one", [["zebra", "1.0.0"], ["alpha", "1.0.0"], ["middle", "1.0.0"]]),
      capture("two", [["zebra", "2.0.0"], ["alpha", "2.0.0"], ["middle", "2.0.0"]]),
    ];
    const first = agreementFor(contracts, MAC);
    const second = agreementFor([...contracts].reverse(), MAC);
    expect(first?.disputed.map((entry) => entry.name)).toEqual(["alpha", "middle", "zebra"]);
    expect(second?.disputed.map((entry) => entry.name)).toEqual(["alpha", "middle", "zebra"]);
  });

  it("handles a ten-person team with a few stragglers", () => {
    const base: [string, string][] = [["express", "5.1.0"], ["zod", "3.23.8"], ["vitest", "2.1.1"]];
    const contracts = [
      ...["a", "b", "c", "d", "e", "f", "g"].map((name) => capture(name, base)),
      capture("behind", [["express", "4.18.2"], ["zod", "3.23.8"], ["vitest", "2.1.1"]]),
      capture("extra", [...base, ["ts-node", "10.9.2"]]),
    ];
    const result = agreementFor(contracts, MAC);

    expect(result?.contractCount).toBe(9);
    expect(result?.agreedPackages).toBe(2);
    expect(result?.disputed.map((entry) => entry.name)).toEqual(["express", "ts-node"]);
    // Eight machines hold the majority version of express.
    expect(result?.disputed[0]?.variants[0]?.contractIds).toHaveLength(8);
    expect(describeAgreement(result!)).toContain("disagree on 2 packages");
  });

  it("separates packages that share a name across managers", () => {
    const withManagers = (id: string, spec: string): ComparableContract => ({
      id,
      contract: {
        targets: [MAC],
        source: { commit: "c".repeat(40) },
        requirements: {
          packages: [
            { ecosystem: "node", manager: "npm", name: "shared-name", versionSpec: "1.0.0" },
            { ecosystem: "python", manager: "pip", name: "shared-name", versionSpec: spec },
          ],
        },
      } as unknown as EnvironmentContractV1,
    });
    const result = agreementFor([withManagers("one", "==2.0.0"), withManagers("two", "==3.0.0")], MAC);
    expect(result?.disputed).toHaveLength(1);
    expect(result?.disputed[0]?.manager).toBe("pip");
    expect(result?.agreedPackages).toBe(1);
  });
});

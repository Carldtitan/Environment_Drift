import { describe, expect, it } from "vitest";
import { assessPortability, describePortability } from "./portability.js";
import type { EnvironmentContractV1, PlatformTarget } from "@iwomc/contracts";

/**
 * Whether the lead's machine can fix yours when you are not on the same
 * operating system. On a team of one this never comes up; on any real team it
 * comes up immediately.
 */

const WINDOWS: PlatformTarget = { os: "windows", arch: "x64" };
const MAC_ARM: PlatformTarget = { os: "macos", arch: "arm64" };
const LINUX: PlatformTarget = { os: "linux", arch: "x64" };

function contractWith(
  targets: PlatformTarget[],
  packages: { name: string; platformConstraint?: { os?: string[]; cpu?: string[]; source?: string } }[],
): EnvironmentContractV1 {
  return {
    targets,
    requirements: {
      packages: packages.map((entry) => ({
        ecosystem: "node",
        manager: "npm",
        name: entry.name,
        versionSpec: "1.0.0",
        scope: "direct",
        source: "observed",
        evidenceRefs: [],
        declared: false,
        ...(entry.platformConstraint ? { platformConstraint: entry.platformConstraint } : {}),
      })),
    },
  } as unknown as EnvironmentContractV1;
}

describe("applying a contract captured on another operating system", () => {
  it("says nothing when it was captured right here", () => {
    const verdict = assessPortability(contractWith([WINDOWS], [{ name: "left-pad" }]), WINDOWS);
    expect(verdict.capturedHere).toBe(true);
    expect(verdict.portable).toBe(true);
    expect(describePortability(verdict, WINDOWS)).toBe("");
  });

  it("allows a contract with nothing platform-specific in it", () => {
    // The common case, and the one that was refused before: ordinary packages
    // where the package manager resolves the right build per machine.
    const verdict = assessPortability(
      contractWith([WINDOWS], [{ name: "nanoid" }, { name: "zod" }]),
      MAC_ARM,
    );
    expect(verdict.capturedHere).toBe(false);
    expect(verdict.portable).toBe(true);
    // Allowed, but the person is told - it was proven there, not here.
    expect(describePortability(verdict, MAC_ARM)).toContain("proven there, not here");
  });

  it("refuses when a pinned package only installs on the machine it came from", () => {
    // Build tools ship one binary package per platform. Pinning the Windows
    // one on a Mac does not produce a working environment.
    const verdict = assessPortability(
      contractWith(
        [WINDOWS],
        [
          { name: "vite" },
          {
            name: "@rollup/rollup-win32-x64-msvc",
            platformConstraint: { os: ["win32"], cpu: ["x64"], source: "package.json declares os win32, cpu x64" },
          },
        ],
      ),
      MAC_ARM,
    );
    expect(verdict.portable).toBe(false);
    expect(verdict.blocking.map((entry) => entry.name)).toEqual(["@rollup/rollup-win32-x64-msvc"]);
    // Names the package rather than giving a generic platform mismatch.
    expect(describePortability(verdict, MAC_ARM)).toContain("@rollup/rollup-win32-x64-msvc");
  });

  it("understands the names npm uses, not only Node's", () => {
    // npm writes `win32` and `darwin`; IWOMC records `windows` and `macos`.
    const windowsOnly = { name: "w", platformConstraint: { os: ["win32"] } };
    expect(assessPortability(contractWith([WINDOWS], [windowsOnly]), WINDOWS).portable).toBe(true);
    expect(assessPortability(contractWith([WINDOWS], [windowsOnly]), MAC_ARM).portable).toBe(false);

    const macOnly = { name: "m", platformConstraint: { os: ["darwin"] } };
    expect(assessPortability(contractWith([MAC_ARM], [macOnly]), MAC_ARM).portable).toBe(true);
    expect(assessPortability(contractWith([MAC_ARM], [macOnly]), LINUX).portable).toBe(false);
  });

  it("matches architecture as well as operating system", () => {
    const intelOnly = { name: "i", platformConstraint: { cpu: ["x64"] } };
    expect(assessPortability(contractWith([LINUX], [intelOnly]), LINUX).portable).toBe(true);
    // Same operating system, different chip - still cannot install.
    expect(assessPortability(contractWith([LINUX], [intelOnly]), MAC_ARM).portable).toBe(false);
  });

  it("reads an architecture alias the way the package manager does", () => {
    const arm = { name: "a", platformConstraint: { cpu: ["arm64"] } };
    expect(assessPortability(contractWith([MAC_ARM], [arm]), MAC_ARM).portable).toBe(true);
  });

  it("handles an exclusion, which permits everything else", () => {
    // `"os": ["!win32"]` means anywhere but Windows, not "only Windows".
    const notWindows = { name: "n", platformConstraint: { os: ["!win32"] } };
    expect(assessPortability(contractWith([LINUX], [notWindows]), LINUX).portable).toBe(true);
    expect(assessPortability(contractWith([LINUX], [notWindows]), MAC_ARM).portable).toBe(true);
    expect(assessPortability(contractWith([LINUX], [notWindows]), WINDOWS).portable).toBe(false);
  });

  it("names every package that blocks, not just the first", () => {
    const verdict = assessPortability(
      contractWith(
        [WINDOWS],
        [
          { name: "one", platformConstraint: { os: ["win32"] } },
          { name: "fine" },
          { name: "two", platformConstraint: { os: ["win32"] } },
        ],
      ),
      LINUX,
    );
    expect(verdict.blocking.map((entry) => entry.name)).toEqual(["one", "two"]);
  });

  it("reports the platforms it was actually captured on", () => {
    const verdict = assessPortability(contractWith([WINDOWS, LINUX], [{ name: "x" }]), MAC_ARM);
    expect(verdict.capturedOn).toEqual(["windows/x64", "linux/x64"]);
  });
});

/**
 * Whether a contract captured on one operating system can be applied on
 * another.
 *
 * The first version of this refused outright: a contract records the platform
 * it was captured on, and anything else was a mismatch. That is safe and, for
 * the thing this product is for, mostly wrong. A team is not all on one
 * operating system, and the lead whose machine works is often not on yours.
 *
 * What actually differs between platforms is narrower than "everything":
 *
 * - Installing the declared dependency tree is already platform-aware. `npm ci`
 *   and `pip install` resolve the right build for the machine they run on;
 *   that is their job, not IWOMC's.
 * - Requiring a runtime version is platform-neutral. Node 24 is Node 24.
 * - What is *not* neutral is a pinned package that only exists for one
 *   platform. Build tools ship their binaries that way - `@esbuild/darwin-arm64`,
 *   `@rollup/rollup-linux-x64-gnu` - each declaring `os` and `cpu`, and Python
 *   does the same with an environment marker. Pinning one of those on another
 *   machine does not produce a working environment, it produces a confusing
 *   failure.
 *
 * So the question is not "was this captured here" but "does anything in it
 * only work there". When nothing does, the contract is portable and applying
 * it elsewhere is reasonable - said out loud, because it was proven on one
 * platform and is being used on another. When something does, IWOMC refuses
 * and names it, which is a far more useful answer than a generic mismatch.
 */

import type { EnvironmentContractV1, PackageRequirement, PlatformTarget } from "@iwomc/contracts";

/** npm spells platforms differently from Node's `process.platform`. */
const OS_ALIASES: Readonly<Record<string, readonly string[]>> = {
  windows: ["win32", "windows"],
  macos: ["darwin", "macos", "mac"],
  linux: ["linux"],
};

const CPU_ALIASES: Readonly<Record<string, readonly string[]>> = {
  x64: ["x64", "x86_64", "amd64"],
  arm64: ["arm64", "aarch64"],
  x86: ["x86", "ia32"],
};

function matchesToken(token: string, accepted: readonly string[]): boolean {
  const value = token.trim().toLowerCase();
  // A leading `!` excludes: `"os": ["!win32"]` means anywhere but Windows.
  if (value.startsWith("!")) return !accepted.includes(value.slice(1));
  return accepted.includes(value);
}

function satisfiesConstraint(
  constraint: NonNullable<PackageRequirement["platformConstraint"]>,
  platform: PlatformTarget,
): boolean {
  const osAccepted = OS_ALIASES[platform.os] ?? [platform.os];
  const cpuAccepted = CPU_ALIASES[platform.arch] ?? [platform.arch];

  if (constraint.os && constraint.os.length > 0) {
    const negations = constraint.os.filter((token) => token.trim().startsWith("!"));
    // A list of exclusions permits everything not excluded; a list of
    // inclusions permits only what is listed.
    const ok =
      negations.length === constraint.os.length
        ? constraint.os.every((token) => matchesToken(token, osAccepted))
        : constraint.os.some((token) => matchesToken(token, osAccepted));
    if (!ok) return false;
  }

  if (constraint.cpu && constraint.cpu.length > 0) {
    const negations = constraint.cpu.filter((token) => token.trim().startsWith("!"));
    const ok =
      negations.length === constraint.cpu.length
        ? constraint.cpu.every((token) => matchesToken(token, cpuAccepted))
        : constraint.cpu.some((token) => matchesToken(token, cpuAccepted));
    if (!ok) return false;
  }

  return true;
}

export interface PortabilityVerdict {
  /** True when the contract's own target list already includes this machine. */
  readonly capturedHere: boolean;
  /** True when nothing in the contract restricts it to another platform. */
  readonly portable: boolean;
  /** Packages that cannot install here, with the restriction that says so. */
  readonly blocking: readonly {
    readonly name: string;
    readonly manager: string;
    readonly reason: string;
  }[];
  /** Platforms the contract was actually captured and proven on. */
  readonly capturedOn: readonly string[];
}

export function assessPortability(
  contract: EnvironmentContractV1,
  platform: PlatformTarget,
): PortabilityVerdict {
  const capturedOn = contract.targets.map((target) => `${target.os}/${target.arch}`);
  const capturedHere = contract.targets.some(
    (target) => target.os === platform.os && target.arch === platform.arch,
  );

  const blocking = contract.requirements.packages
    .filter((requirement) => requirement.platformConstraint !== undefined)
    .filter(
      (requirement) =>
        !satisfiesConstraint(
          requirement.platformConstraint as NonNullable<PackageRequirement["platformConstraint"]>,
          platform,
        ),
    )
    .map((requirement) => ({
      name: requirement.name,
      manager: requirement.manager,
      reason:
        requirement.platformConstraint?.source ??
        `restricted to ${[
          requirement.platformConstraint?.os?.join("/"),
          requirement.platformConstraint?.cpu?.join("/"),
        ]
          .filter(Boolean)
          .join(" ")}`,
    }));

  return { capturedHere, portable: blocking.length === 0, blocking, capturedOn };
}

/**
 * What to tell someone applying a contract captured on another platform.
 *
 * Returned even when it is allowed, because "this worked on a Mac and you are
 * on Windows" is something the person running it should know, not something to
 * be quietly decided for them.
 */
export function describePortability(verdict: PortabilityVerdict, platform: PlatformTarget): string {
  const here = `${platform.os}/${platform.arch}`;
  if (verdict.capturedHere) return "";
  if (verdict.portable) {
    return `This contract was captured on ${verdict.capturedOn.join(", ")} and is being applied on ${here}. Nothing in it is restricted to one platform, so the package manager resolves the right build for this machine - but it was proven there, not here.`;
  }
  const names = verdict.blocking.map((entry) => entry.name).join(", ");
  return `This contract was captured on ${verdict.capturedOn.join(", ")} and cannot be applied on ${here}: ${names} ${
    verdict.blocking.length === 1 ? "installs" : "install"
  } only on the platform it was captured on.`;
}

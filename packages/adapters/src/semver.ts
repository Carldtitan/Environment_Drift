/**
 * A small semantic-version comparator.
 *
 * IWOMC only needs to answer "does the version installed here satisfy the
 * version the contract asks for", so this implements the range grammar that
 * real manifests use (comparators, carets, tildes, wildcards, `||`
 * alternatives) rather than depending on a full range library.
 */

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

export function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_RE.exec(input.trim());
  if (!match) return null;
  const prerelease = (match[4] ?? "")
    .split(".")
    .filter((part) => part.length > 0)
    .map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease,
  };
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") return left < right ? -1 : 1;
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

interface Comparator {
  readonly operator: ">=" | ">" | "<=" | "<" | "=";
  readonly version: ParsedVersion;
}

function comparatorsFor(part: string): Comparator[] | null {
  const token = part.trim();
  if (token.length === 0) return [];
  if (token === "*" || token === "x" || token === "latest" || token === "any") return [];

  const caret = /^\^\s*(.+)$/u.exec(token);
  if (caret) {
    const version = parseVersion(caret[1] as string);
    if (!version) return null;
    const upper: ParsedVersion =
      version.major > 0
        ? { major: version.major + 1, minor: 0, patch: 0, prerelease: [] }
        : version.minor > 0
          ? { major: 0, minor: version.minor + 1, patch: 0, prerelease: [] }
          : { major: 0, minor: 0, patch: version.patch + 1, prerelease: [] };
    return [
      { operator: ">=", version },
      { operator: "<", version: upper },
    ];
  }

  const tilde = /^~\s*(.+)$/u.exec(token);
  if (tilde) {
    const version = parseVersion(tilde[1] as string);
    if (!version) return null;
    return [
      { operator: ">=", version },
      {
        operator: "<",
        version: { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] },
      },
    ];
  }

  const explicit = /^(>=|<=|>|<|=)\s*(.+)$/u.exec(token);
  if (explicit) {
    const version = parseVersion(explicit[2] as string);
    if (!version) return null;
    return [{ operator: explicit[1] as Comparator["operator"], version }];
  }

  // Bare `1.2.x` / `1.x` wildcards.
  const wildcard = /^(\d+)(?:\.(\d+|[xX*]))?(?:\.([xX*]))?$/u.exec(token);
  if (wildcard && (wildcard[2] === undefined || /[xX*]/u.test(wildcard[2]) || wildcard[3] !== undefined)) {
    const major = Number(wildcard[1]);
    if (wildcard[2] === undefined || /[xX*]/u.test(wildcard[2])) {
      return [
        { operator: ">=", version: { major, minor: 0, patch: 0, prerelease: [] } },
        { operator: "<", version: { major: major + 1, minor: 0, patch: 0, prerelease: [] } },
      ];
    }
    const minor = Number(wildcard[2]);
    return [
      { operator: ">=", version: { major, minor, patch: 0, prerelease: [] } },
      { operator: "<", version: { major, minor: minor + 1, patch: 0, prerelease: [] } },
    ];
  }

  const exact = parseVersion(token);
  if (!exact) return null;
  return [{ operator: "=", version: exact }];
}

function satisfiesComparator(version: ParsedVersion, comparator: Comparator): boolean {
  const order = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case ">=":
      return order >= 0;
    case ">":
      return order > 0;
    case "<=":
      return order <= 0;
    case "<":
      return order < 0;
    case "=":
      return order === 0;
    default:
      return false;
  }
}

export type SatisfactionResult = "satisfied" | "unsatisfied" | "unknown_range";

/**
 * Returns `unknown_range` rather than guessing when the range uses a syntax
 * this comparator does not model (a URL, a git reference, a workspace alias).
 * Callers must surface that as a coverage gap, never as a pass.
 */
export function satisfies(versionText: string, range: string): SatisfactionResult {
  const version = parseVersion(versionText);
  if (!version) return "unknown_range";
  const alternatives = range.split("||");
  let sawUsable = false;
  for (const alternative of alternatives) {
    const parts = alternative.trim().split(/\s+/u).filter(Boolean);
    if (parts.length === 0) return "satisfied";
    const comparators: Comparator[] = [];
    let usable = true;
    for (const part of parts) {
      const parsed = comparatorsFor(part);
      if (parsed === null) {
        usable = false;
        break;
      }
      comparators.push(...parsed);
    }
    if (!usable) continue;
    sawUsable = true;
    if (comparators.every((comparator) => satisfiesComparator(version, comparator))) {
      return "satisfied";
    }
  }
  return sawUsable ? "unsatisfied" : "unknown_range";
}

/** A conservative pin: the exact version, used when evidence gives one. */
export function pinExact(version: string): string {
  const parsed = parseVersion(version);
  if (!parsed) return version;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${
    parsed.prerelease.length > 0 ? `-${parsed.prerelease.join(".")}` : ""
  }`;
}

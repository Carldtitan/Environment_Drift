import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Windows batch-shim handling.
 *
 * Node refuses to spawn a `.cmd` or `.bat` file directly (it throws EINVAL),
 * because `cmd.exe` re-parses the arguments and can turn a value into a
 * command. IWOMC must still run `npm`, `uv`, and friends, and it must do so
 * without ever putting a contract value through a shell parser.
 *
 * Two resolutions, in order:
 *
 * 1. Most developer CLIs on Windows are `.cmd` wrappers around a Node script.
 *    If the wrapper names one, IWOMC runs `node <script>` directly - an
 *    ordinary argv spawn with no shell involved at all. This covers npm, npx,
 *    pnpm, yarn, and every npm-installed binary.
 * 2. Otherwise the wrapper is invoked through `cmd.exe /d /s /c` with a command
 *    line built here: each argument is quoted for the C runtime, and any
 *    argument cmd.exe could still reinterpret is refused rather than escaped
 *    with a trick that does not hold.
 */

export interface ShimPlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
  readonly strategy: "direct" | "node-script" | "cmd-wrapper";
}

export class UnsafeBatchArgumentError extends Error {
  constructor(argument: string) {
    super(
      `Refusing to run a Windows .bat/.cmd wrapper with an argument containing "%": cmd.exe would expand it and no escape reliably prevents that. Offending argument: ${JSON.stringify(argument)}`,
    );
    this.name = "UnsafeBatchArgumentError";
  }
}

/**
 * Read the Node script a `.cmd` shim finally invokes.
 *
 * The shim is parsed, never executed: `SET "NAME=value"` assignments are
 * collected, the line that forwards `%*` is located, and the variable it runs
 * is expanded. That picks npm's `npm-cli.js` over the `npm-prefix.js` the same
 * file also mentions, which a first-match regex gets wrong.
 */
export function nodeScriptForShim(shimPath: string): string | null {
  let body: string;
  try {
    body = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }

  const lines = body.split(/\r?\n/u);
  const variables = new Map<string, string>();
  const assignments: string[] = [];
  for (const line of lines) {
    const assignment = /^\s*SET\s+"?([A-Za-z_][A-Za-z0-9_]*)=([^"\r\n]*)"?\s*$/iu.exec(line);
    if (!assignment) continue;
    const name = (assignment[1] as string).toUpperCase();
    const value = assignment[2] as string;
    assignments.push(value);
    // First assignment wins: later ones are conditional overrides inside IF or
    // FOR blocks, which this parser deliberately does not evaluate.
    if (!variables.has(name)) variables.set(name, value);
  }

  const expand = (value: string, depth = 0): string => {
    if (depth > 5) return value;
    return value.replace(/%(~?)([A-Za-z_][A-Za-z0-9_]*)%?/gu, (match, tilde: string, name: string) => {
      if (tilde === "~" && name.toLowerCase() === "dp0") return `${dirname(shimPath)}/`;
      const resolved = variables.get(name.toUpperCase());
      return resolved === undefined ? match : expand(resolved, depth + 1);
    });
  };

  const candidates: string[] = [];
  const invocation = lines.filter((line) => line.includes("%*")).pop();
  if (invocation) {
    for (const token of invocation.match(/"[^"]+"|\S+/gu) ?? []) {
      const expanded = expand(token.replace(/^"|"$/gu, ""));
      if (/\.(?:js|cjs|mjs)$/iu.test(expanded)) candidates.push(expanded);
    }
  }
  // Every script the shim mentions is a fallback candidate, in file order.
  for (const value of assignments) {
    const expanded = expand(value);
    if (/\.(?:js|cjs|mjs)$/iu.test(expanded)) candidates.push(expanded);
  }

  for (const candidate of candidates) {
    const normalized = resolve(candidate.replace(/\\/gu, "/"));
    if (existsSync(normalized)) return normalized;
  }
  return null;
}

/**
 * Quote one argument the way the Microsoft C runtime parses it back.
 * This is the algorithm every correct Windows spawn implementation uses.
 */
export function quoteForCommandLine(argument: string): string {
  if (argument.length > 0 && !/[\s"]/u.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const char of argument) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      // Backslashes before a quote must be doubled, then the quote escaped.
      quoted += "\\".repeat(backslashes * 2 + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes);
    backslashes = 0;
    quoted += char;
  }
  quoted += "\\".repeat(backslashes * 2);
  quoted += '"';
  return quoted;
}

const CMD_METACHARACTERS = /[()<>&|^]/gu;

/**
 * Build the command line for `cmd.exe /d /s /c`.
 *
 * `/s` makes cmd strip exactly the outermost pair of quotes, so the inner
 * argument quoting survives. Bare tokens get their cmd metacharacters escaped;
 * `%` is refused outright because no escape for it holds on a command line.
 */
export function buildCmdCommandLine(executable: string, args: readonly string[]): string {
  const parts = [executable, ...args].map((part) => {
    if (part.includes("%")) throw new UnsafeBatchArgumentError(part);
    const quoted = quoteForCommandLine(part);
    return quoted.startsWith('"') ? quoted : quoted.replace(CMD_METACHARACTERS, (char) => `^${char}`);
  });
  return `/d /s /c "${parts.join(" ")}"`;
}

export function planSpawn(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ShimPlan {
  if (platform !== "win32" || !/\.(cmd|bat)$/iu.test(executable)) {
    return { executable, args, windowsVerbatimArguments: false, strategy: "direct" };
  }

  const script = nodeScriptForShim(executable);
  if (script !== null) {
    return {
      executable: process.execPath,
      args: [script, ...args],
      windowsVerbatimArguments: false,
      strategy: "node-script",
    };
  }

  const comspec = process.env["COMSPEC"];
  const shell = comspec && isAbsolute(comspec) ? comspec : "cmd.exe";
  return {
    executable: shell,
    args: [buildCmdCommandLine(executable, args)],
    windowsVerbatimArguments: true,
    strategy: "cmd-wrapper",
  };
}

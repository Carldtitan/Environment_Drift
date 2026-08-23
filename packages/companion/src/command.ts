/**
 * Turn a human-typed command into an argv array.
 *
 * This is a tokenizer, not a shell. It understands quoting and nothing else:
 * pipes, redirection, substitution, and chaining are rejected rather than
 * silently reinterpreted, because a contract may only carry an argv array that
 * is executed directly (R5.3).
 */

export class UnsafeCommandError extends Error {
  readonly token: string;
  constructor(token: string, reason: string) {
    super(`${reason} (found ${JSON.stringify(token)})`);
    this.name = "UnsafeCommandError";
    this.token = token;
  }
}

/**
 * Characters a shell would act on. They are compared one at a time, so every
 * entry here is a single character - `$` covers `$(...)` and `$VAR` alike.
 */
const SHELL_METACHARACTERS = new Set([
  "|",
  "&",
  ";",
  ">",
  "<",
  "`",
  "$",
  "(",
  ")",
  "\n",
  "\r",
  "\0",
]);

export function parseCommandLine(input: string): string[] {
  const text = input.trim();
  if (text.length === 0) throw new UnsafeCommandError("", "a command cannot be empty");

  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && char === "\\" && i + 1 < text.length) {
        const next = text[i + 1] as string;
        if (next === '"' || next === "\\") {
          current += next;
          i += 1;
          continue;
        }
      }
      current += char;
      started = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }

    if (char === " " || char === "\t") {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    if (SHELL_METACHARACTERS.has(char)) {
      throw new UnsafeCommandError(
        char,
        "IWOMC runs commands directly, without a shell, so shell operators are not allowed in a proof command or recipe",
      );
    }

    current += char;
    started = true;
  }

  if (quote) throw new UnsafeCommandError(quote, "unterminated quote");
  if (started) argv.push(current);
  if (argv.length === 0) throw new UnsafeCommandError(input, "a command cannot be empty");
  return argv;
}

/** Render argv back to a copyable, unambiguous single line. */
export function formatCommand(argv: readonly string[]): string {
  return argv
    .map((token) => (/^[A-Za-z0-9_./:@=+-]+$/u.test(token) ? token : JSON.stringify(token)))
    .join(" ");
}

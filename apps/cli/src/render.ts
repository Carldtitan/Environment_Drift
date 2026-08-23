/**
 * Terminal rendering.
 *
 * Every state is printed with a text label as well as a colour, so the output
 * is readable with colour disabled, in a pipe, or by a screen reader (R13.3).
 */

const useColor =
  process.env["NO_COLOR"] === undefined &&
  process.env["TERM"] !== "dumb" &&
  process.stdout.isTTY === true;

const ESC = String.fromCharCode(27);

function wrap(code: string, text: string): string {
  return useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;
}

export const style = {
  bold: (text: string) => wrap("1", text),
  dim: (text: string) => wrap("2", text),
  signal: (text: string) => wrap("38;5;173", text),
  ready: (text: string) => wrap("38;5;65", text),
  attention: (text: string) => wrap("38;5;136", text),
  danger: (text: string) => wrap("38;5;131", text),
  info: (text: string) => wrap("38;5;67", text),
  mono: (text: string) => wrap("38;5;250", text),
};

export type Tone = "ready" | "attention" | "danger" | "info" | "neutral";

const MARKS: Record<Tone, string> = {
  ready: "[ok]",
  attention: "[!]",
  danger: "[x]",
  info: "[i]",
  neutral: "[-]",
};

export function mark(tone: Tone): string {
  const text = MARKS[tone];
  switch (tone) {
    case "ready":
      return style.ready(text);
    case "attention":
      return style.attention(text);
    case "danger":
      return style.danger(text);
    case "info":
      return style.info(text);
    default:
      return style.dim(text);
  }
}

export function line(tone: Tone, label: string, detail?: string): string {
  return detail ? `${mark(tone)} ${label} ${style.dim("-")} ${detail}` : `${mark(tone)} ${label}`;
}

export function heading(text: string): string {
  return `\n${style.bold(text)}\n${style.dim("-".repeat(Math.min(text.length, 72)))}`;
}

export function keyValue(pairs: readonly [string, string][], indent = "  "): string {
  const width = Math.max(...pairs.map(([key]) => key.length), 0);
  return pairs.map(([key, value]) => `${indent}${key.padEnd(width)}  ${value}`).join("\n");
}

export function bullet(text: string, indent = "  "): string {
  return `${indent}${style.dim("-")} ${text}`;
}

/** Terminal states are printed with an explicit word, never a bare colour. */
export function terminalTone(state: string): Tone {
  switch (state) {
    case "working":
    case "passed":
    case "clean_verified":
    case "locally_checked":
    case "approved":
    case "connected":
    case "active":
    case "ok":
      return "ready";
    case "failed":
    case "revoked":
    case "cleanup_failed":
      return "danger";
    case "blocked":
    case "unsupported":
    case "inconclusive":
    case "warn":
    case "needs_approval":
      return "attention";
    default:
      return "neutral";
  }
}

/** snake_case in code, plain words in anything a person reads. */
export function humanLabel(value: string): string {
  return value.replace(/_/gu, " ");
}

export function wrapText(text: string, width = 78, indent = "  "): string {
  const words = text.split(/\s+/u);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width - indent.length) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.map((entry) => `${indent}${entry}`).join("\n");
}

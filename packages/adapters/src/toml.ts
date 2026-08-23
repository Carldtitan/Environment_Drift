/**
 * A TOML subset reader for `pyproject.toml`-shaped declarations.
 *
 * IWOMC only needs tables, string values, and arrays of strings. Anything the
 * reader does not understand is reported as `unparsed` so the adapter can
 * record a coverage gap instead of silently treating absence as evidence of
 * absence (R4.5).
 */

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

export interface TomlDocument {
  readonly root: Record<string, TomlValue>;
  /** Lines the reader could not interpret, for coverage reporting. */
  readonly unparsed: readonly string[];
}

export function parseToml(source: string): TomlDocument {
  const root: Record<string, TomlValue> = {};
  const unparsed: string[] = [];
  let table: Record<string, TomlValue> = root;

  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] as string;
    const line = stripComment(raw).trim();
    if (line.length === 0) continue;

    const tableMatch = /^\[\[?([^\]]+)\]\]?$/u.exec(line);
    if (tableMatch) {
      const isArrayTable = line.startsWith("[[");
      const path = splitKeyPath(tableMatch[1] as string);
      table = descend(root, path, isArrayTable);
      continue;
    }

    const assignment = /^([^=]+?)\s*=\s*(.*)$/u.exec(line);
    if (!assignment) {
      unparsed.push(raw);
      continue;
    }
    const keyPath = splitKeyPath(assignment[1] as string);
    let valueText = (assignment[2] ?? "").trim();

    // Multi-line array: keep consuming until brackets balance.
    if (valueText.startsWith("[") && countUnquoted(valueText, "[") !== countUnquoted(valueText, "]")) {
      let depth = countUnquoted(valueText, "[") - countUnquoted(valueText, "]");
      while (depth > 0 && index + 1 < lines.length) {
        index += 1;
        const next = stripComment(lines[index] as string);
        valueText += `\n${next}`;
        depth += countUnquoted(next, "[") - countUnquoted(next, "]");
      }
    }

    const parsed = parseValue(valueText);
    if (parsed === undefined) {
      unparsed.push(raw);
      continue;
    }
    const container = keyPath.length > 1 ? descend(table, keyPath.slice(0, -1), false) : table;
    container[keyPath[keyPath.length - 1] as string] = parsed;
  }

  return { root, unparsed };
}

function stripComment(line: string): string {
  let inString: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (inString) {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    if (char === "#") return line.slice(0, i);
  }
  return line;
}

function countUnquoted(text: string, char: string): number {
  let count = 0;
  let inString: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const current = text[i] as string;
    if (inString) {
      if (current === "\\") {
        i += 1;
        continue;
      }
      if (current === inString) inString = null;
      continue;
    }
    if (current === '"' || current === "'") {
      inString = current;
      continue;
    }
    if (current === char) count += 1;
  }
  return count;
}

function splitKeyPath(key: string): string[] {
  return key
    .split(".")
    .map((part) => part.trim().replace(/^["']|["']$/gu, ""))
    .filter((part) => part.length > 0);
}

function descend(
  root: Record<string, TomlValue>,
  path: readonly string[],
  arrayTable: boolean,
): Record<string, TomlValue> {
  let current = root;
  for (let i = 0; i < path.length; i += 1) {
    const key = path[i] as string;
    const last = i === path.length - 1;
    let next = current[key];
    if (last && arrayTable) {
      const entry: Record<string, TomlValue> = {};
      if (Array.isArray(next)) next.push(entry);
      else current[key] = [entry];
      return entry;
    }
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      next = {};
      current[key] = next;
    }
    current = next as Record<string, TomlValue>;
  }
  return current;
}

function parseValue(text: string): TomlValue | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("[")) {
    const inner = trimmed.slice(1, trimmed.lastIndexOf("]"));
    const items: TomlValue[] = [];
    for (const part of splitTopLevel(inner)) {
      const value = parseValue(part);
      if (value !== undefined) items.push(value);
    }
    return items;
  }
  if (trimmed.startsWith("{")) {
    const inner = trimmed.slice(1, trimmed.lastIndexOf("}"));
    const out: Record<string, TomlValue> = {};
    for (const part of splitTopLevel(inner)) {
      const assignment = /^([^=]+?)\s*=\s*(.*)$/u.exec(part.trim());
      if (!assignment) continue;
      const value = parseValue(assignment[2] as string);
      if (value !== undefined) out[splitKeyPath(assignment[1] as string).join(".")] = value;
    }
    return out;
  }
  if (
    (trimmed.startsWith('"""') && trimmed.endsWith('"""')) ||
    (trimmed.startsWith("'''") && trimmed.endsWith("'''"))
  ) {
    return trimmed.slice(3, -3);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return unescape(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^[+-]?\d[\d_]*$/u.test(trimmed)) return Number(trimmed.replace(/_/gu, ""));
  if (/^[+-]?\d[\d_]*\.\d[\d_]*$/u.test(trimmed)) return Number(trimmed.replace(/_/gu, ""));
  return undefined;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (inString) {
      current += char;
      if (char === "\\") {
        current += text[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      current += char;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    if (char === "]" || char === "}") depth -= 1;
    if (char === "," && depth === 0) {
      if (current.trim().length > 0) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

function unescape(value: string): string {
  return value.replace(/\\(["\\nrt])/gu, (_match, char: string) => {
    switch (char) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return char;
    }
  });
}

/** Read a dotted path such as `project.dependencies`. */
export function tomlGet(document: TomlDocument, path: string): TomlValue | undefined {
  let current: TomlValue | undefined = document.root;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, TomlValue>)[key];
  }
  return current;
}

export function tomlStringArray(document: TomlDocument, path: string): string[] | undefined {
  const value = tomlGet(document, path);
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

export function tomlString(document: TomlDocument, path: string): string | undefined {
  const value = tomlGet(document, path);
  return typeof value === "string" ? value : undefined;
}

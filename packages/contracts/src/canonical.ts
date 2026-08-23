import { createHash } from "node:crypto";

/**
 * RFC 8785 (JSON Canonicalization Scheme) serialization.
 *
 * Content addressing and signatures must not change when a field order or an
 * insignificant number format changes, so every digest in IWOMC is taken over
 * this representation.
 */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  writeValue(value, out);
  return out.join("");
}

function writeValue(value: unknown, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      out.push(serializeNumber(value));
      return;
    case "string":
      out.push(serializeString(value));
      return;
    case "object":
      break;
    default:
      throw new TypeError(`cannot canonicalize a value of type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out.push(",");
      writeValue(value[i], out);
    }
    out.push("]");
    return;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCodeUnits);
  out.push("{");
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i] as string;
    if (i > 0) out.push(",");
    out.push(serializeString(key));
    out.push(":");
    writeValue(record[key], out);
  }
  out.push("}");
}

/** RFC 8785 sorts object members by UTF-16 code unit, which `<` already does. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("cannot canonicalize a non-finite number");
  }
  if (Object.is(value, -0)) return "0";
  // ES2019+ Number#toString already produces the shortest round-tripping form
  // that RFC 8785 adopts verbatim.
  return String(value);
}

const ESCAPES = new Map<string, string>([
  ['"', '\\"'],
  ["\\", "\\\\"],
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
]);

function serializeString(value: string): string {
  let out = '"';
  for (const char of value) {
    const escape = ESCAPES.get(char);
    if (escape !== undefined) {
      out += escape;
      continue;
    }
    const code = char.codePointAt(0) as number;
    if (code < 0x20) {
      out += "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    out += char;
  }
  return out + '"';
}

/** `sha256:<hex>` over the canonical JSON form of `value`. */
export function digestOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

/** `sha256:<hex>` over raw bytes (file contents, log blobs). */
export function digestBytes(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

/**
 * Digest of a document that carries its own `digest` and `signature` fields.
 * Both are excluded so the digest is stable before and after signing.
 */
export function selfDigest<T extends Record<string, unknown>>(document: T): string {
  const { digest: _digest, signature: _signature, ...rest } = document;
  void _digest;
  void _signature;
  return digestOf(rest);
}

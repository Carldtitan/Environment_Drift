/**
 * Local redaction boundary (R4.4, R9.3, R12.1).
 *
 * Everything that leaves the developer's machine - upload payloads, bounded
 * logs, and Claude-Mem observations - passes through this module first. It is
 * deliberately conservative: it prefers destroying a harmless string over
 * letting a credential-shaped one through.
 */

export type RedactionCategory =
  | "private_key_block"
  | "url_credentials"
  | "authorization_header"
  | "bearer_token"
  | "json_web_token"
  | "vendor_token"
  | "secret_assignment"
  | "known_secret_value"
  | "high_entropy_blob";

export interface RedactionFinding {
  readonly category: RedactionCategory;
  /** Where it was found: a JSON pointer for structured payloads, or a label. */
  readonly at: string;
  /** Number of characters removed. Never the value itself. */
  readonly length: number;
}

export interface RedactionResult<T> {
  readonly value: T;
  readonly findings: readonly RedactionFinding[];
}

export const REDACTED = "[redacted]";

interface Rule {
  readonly category: RedactionCategory;
  readonly pattern: RegExp;
  /** Which capture group holds the sensitive part; 0 means the whole match. */
  readonly group: number;
}

/**
 * Key names whose *values* are always removed regardless of shape. Matched
 * case-insensitively against whole words in assignments and object keys.
 */
const SECRET_KEY_WORDS = [
  "secret",
  "password",
  "passwd",
  "pwd",
  "token",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "privatekey",
  "private_key",
  "credential",
  "credentials",
  "authorization",
  "session_id",
  "cookie",
  "signature",
  "client_secret",
  "refresh_token",
  "connection_string",
  "dsn",
];

const SECRET_KEY_RE = new RegExp(`(?:${SECRET_KEY_WORDS.join("|")})`, "iu");

const ASSIGNMENT_RE = new RegExp(
  String.raw`(["']?[A-Za-z0-9_.\-]*(?:${SECRET_KEY_WORDS.join("|")})[A-Za-z0-9_.\-]*["']?\s*[:=]\s*)(["']?)([^\s"',;}]{4,})`,
  "giu",
);

const RULES: readonly Rule[] = [
  {
    category: "private_key_block",
    pattern:
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gu,
    group: 0,
  },
  {
    // scheme://user:password@host
    category: "url_credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/giu,
    group: 3,
  },
  {
    category: "authorization_header",
    pattern: /\b(authorization\s*[:=]\s*)(["']?)([^\s"',;]+)/giu,
    group: 3,
  },
  {
    category: "bearer_token",
    pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{12,})/gu,
    group: 1,
  },
  {
    category: "json_web_token",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    group: 0,
  },
  // Vendor-issued credential shapes. These are prefix families, not a list of
  // any particular product's packages.
  {
    category: "vendor_token",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{16,}|ak-[A-Za-z0-9]{18,}|as-[A-Za-z0-9]{18,}|cm_[A-Za-z0-9]{20,})\b/gu,
    group: 0,
  },
  {
    // KEY=value / "key": "value" / key: value where the key looks secret.
    category: "secret_assignment",
    pattern: ASSIGNMENT_RE,
    group: 3,
  },
];

/**
 * Strings that look like generated credentials on their own: long, mixed-case
 * alphanumeric runs with no word structure. Used only for standalone values,
 * never for prose.
 */
const HIGH_ENTROPY_RE = /^[A-Za-z0-9_\-+/=]{32,}$/u;

function looksHighEntropy(value: string): boolean {
  if (!HIGH_ENTROPY_RE.test(value)) return false;
  const classes =
    Number(/[a-z]/u.test(value)) +
    Number(/[A-Z]/u.test(value)) +
    Number(/[0-9]/u.test(value)) +
    Number(/[_\-+/=]/u.test(value));
  if (classes < 3) return false;
  const distinct = new Set(value).size;
  return distinct >= 12;
}

/**
 * Field names whose values are IWOMC's own structural identifiers: content
 * digests, idempotency keys, record ids, and public keys. They are long and
 * high-entropy by design, and they are never secrets, so the entropy heuristic
 * is skipped for them. The name-based rules above still apply, so a field
 * called `token` is redacted no matter where it appears.
 */
const IDENTIFIER_KEYS = new Set([
  "id",
  "runid",
  "jobid",
  "stepid",
  "proofid",
  "receiptid",
  "contractid",
  "projectid",
  "workspaceid",
  "deviceid",
  "personid",
  "attestationid",
  "digest",
  "logdigest",
  "contentdigest",
  "commanddigest",
  "journaldigest",
  "previousdigest",
  "approvedcommanddigest",
  "canonicalremotedigest",
  "idempotencykey",
  "publickey",
  "keyid",
  "commit",
  "evidencerefs",
  "adapters",
  "stepsapplied",
  "sourcereceipts",
]);

export interface RedactorOptions {
  /**
   * Exact secret values known to the local process (for example values read
   * from a project `.env`). They are removed by value wherever they appear.
   */
  readonly knownSecretValues?: readonly string[];
  /** Minimum length for a known secret value to be worth matching. */
  readonly minKnownValueLength?: number;
}

export class Redactor {
  readonly #knownValues: readonly string[];

  constructor(options: RedactorOptions = {}) {
    const min = options.minKnownValueLength ?? 6;
    this.#knownValues = [...(options.knownSecretValues ?? [])]
      .filter((value) => value.trim().length >= min)
      .sort((a, b) => b.length - a.length);
  }

  get knownSecretValueCount(): number {
    return this.#knownValues.length;
  }

  withKnownSecretValues(values: readonly string[]): Redactor {
    return new Redactor({ knownSecretValues: [...this.#knownValues, ...values] });
  }

  /** Redact a free-text blob such as captured command output. */
  redactText(text: string, at = ""): RedactionResult<string> {
    const findings: RedactionFinding[] = [];
    let out = text;

    for (const value of this.#knownValues) {
      let index = out.indexOf(value);
      while (index !== -1) {
        findings.push({ category: "known_secret_value", at, length: value.length });
        out = `${out.slice(0, index)}${REDACTED}${out.slice(index + value.length)}`;
        index = out.indexOf(value, index + REDACTED.length);
      }
    }

    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      out = out.replace(rule.pattern, (match: string, ...args: unknown[]) => {
        const groups = args.slice(0, args.length - 2) as (string | undefined)[];
        const captured = rule.group === 0 ? match : groups[rule.group - 1];
        if (captured === undefined || captured.length === 0) return match;
        findings.push({ category: rule.category, at, length: captured.length });
        if (rule.group === 0) return REDACTED;
        const start = match.lastIndexOf(captured);
        return `${match.slice(0, start)}${REDACTED}${match.slice(start + captured.length)}`;
      });
    }

    return { value: out, findings };
  }

  /** Deep-redact a structured payload before upload or memory ingestion. */
  redactValue<T>(input: T, at = ""): RedactionResult<T> {
    const findings: RedactionFinding[] = [];
    const value = this.#walk(input, at, findings, false) as T;
    return { value, findings };
  }

  #walk(
    input: unknown,
    at: string,
    findings: RedactionFinding[],
    underIdentifierKey: boolean,
  ): unknown {
    if (input === null || input === undefined) return input;
    if (typeof input === "string") {
      if (!underIdentifierKey && looksHighEntropy(input) && !isDigestLike(input)) {
        findings.push({ category: "high_entropy_blob", at, length: input.length });
        return REDACTED;
      }
      const result = this.redactText(input, at);
      findings.push(...result.findings);
      return result.value;
    }
    if (typeof input === "number" || typeof input === "boolean") return input;
    if (Array.isArray(input)) {
      return input.map((item, index) =>
        this.#walk(item, `${at}/${index}`, findings, underIdentifierKey),
      );
    }
    if (typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
        const pointer = `${at}/${escapePointer(key)}`;
        if (SECRET_KEY_RE.test(key) && typeof raw === "string" && raw.length > 0) {
          findings.push({ category: "secret_assignment", at: pointer, length: raw.length });
          out[key] = REDACTED;
          continue;
        }
        out[key] = this.#walk(raw, pointer, findings, IDENTIFIER_KEYS.has(key.toLowerCase()));
      }
      return out;
    }
    return String(input);
  }
}

function isDigestLike(value: string): boolean {
  return /^(?:sha256:)?[0-9a-f]{32,64}$/u.test(value);
}

export const defaultRedactor = new Redactor();

export class RedactionError extends Error {
  readonly findings: readonly RedactionFinding[];
  constructor(message: string, findings: readonly RedactionFinding[]) {
    super(message);
    this.name = "RedactionError";
    this.findings = findings;
  }
}

/**
 * Fails closed. Used as the last gate before any network payload leaves the
 * device: if the redactor would still find something, the payload is refused.
 */
export function assertRedacted(payload: unknown, redactor: Redactor = defaultRedactor): void {
  const { findings } = redactor.redactValue(payload);
  if (findings.length > 0) {
    const categories = [...new Set(findings.map((f) => f.category))].sort().join(", ");
    const locations = [...new Set(findings.map((f) => f.at || "<root>"))].slice(0, 5).join(", ");
    throw new RedactionError(
      `refusing to send a payload that still contains credential-shaped material (${categories}) at ${locations}`,
      findings,
    );
  }
}

function escapePointer(key: string): string {
  return key.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

/**
 * Read a dotenv-style file body and return the NAMES it declares plus the raw
 * values, so the caller can (a) put names in a contract and (b) feed the values
 * to the redactor. Values must never be placed in a contract or upload.
 */
export function parseEnvNamesAndValues(body: string): {
  names: string[];
  values: string[];
} {
  const names: string[] = [];
  const values: string[] = [];
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    const name = match[1] as string;
    let value = (match[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    names.push(name);
    if (value.length > 0) values.push(value);
  }
  return { names, values };
}

/**
 * Bound a captured log so a runaway command cannot fill the local store or an
 * upload. Returns the redacted head/tail plus how much was dropped.
 */
export interface BoundedLog {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
}

export function boundLog(
  text: string,
  maxBytes: number,
  redactor: Redactor = defaultRedactor,
): BoundedLog {
  const redacted = redactor.redactText(text).value;
  const bytes = Buffer.byteLength(redacted, "utf8");
  if (bytes <= maxBytes) {
    return { text: redacted, truncated: false, originalBytes: bytes };
  }
  const half = Math.floor(maxBytes / 2);
  const buffer = Buffer.from(redacted, "utf8");
  const head = buffer.subarray(0, half).toString("utf8");
  const tail = buffer.subarray(buffer.length - half).toString("utf8");
  return {
    text: `${head}\n... [${bytes - maxBytes} bytes omitted by IWOMC output cap] ...\n${tail}`,
    truncated: true,
    originalBytes: bytes,
  };
}

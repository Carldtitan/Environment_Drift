/**
 * A small, dependency-free JSON Schema (draft 2020-12 subset) validator.
 *
 * IWOMC ships canonical schema documents for every record that crosses a trust
 * boundary. Validation must run inside the Companion, the control plane, and
 * the tests with identical semantics and no network or native dependency, so
 * the subset is implemented here rather than pulled from a validator library.
 *
 * Supported keywords: $ref (local $defs), type, enum, const, properties,
 * required, additionalProperties, patternProperties, items, prefixItems,
 * minItems, maxItems, uniqueItems, minLength, maxLength, pattern, minimum,
 * maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, format (date-time),
 * oneOf, anyOf, allOf, not, nullable via type arrays, and discriminated unions
 * expressed as oneOf + const.
 */

export interface JsonSchema {
  readonly $id?: string;
  readonly $schema?: string;
  readonly title?: string;
  readonly description?: string;
  readonly $defs?: Record<string, JsonSchema>;
  readonly $ref?: string;
  readonly type?: JsonType | readonly JsonType[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly properties?: Record<string, JsonSchema>;
  readonly patternProperties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly prefixItems?: readonly JsonSchema[];
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly not?: JsonSchema;
  readonly default?: unknown;
  readonly examples?: readonly unknown[];
}

export type JsonType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface SchemaViolation {
  /** JSON Pointer into the validated document. */
  readonly path: string;
  readonly message: string;
  readonly keyword: string;
}

export class SchemaValidationError extends Error {
  readonly violations: readonly SchemaViolation[];
  readonly schemaId: string;

  constructor(schemaId: string, violations: readonly SchemaViolation[]) {
    const preview = violations
      .slice(0, 6)
      .map((v) => `${v.path || "<root>"}: ${v.message}`)
      .join("; ");
    super(
      `${schemaId} validation failed (${violations.length} problem${
        violations.length === 1 ? "" : "s"
      }): ${preview}`,
    );
    this.name = "SchemaValidationError";
    this.violations = violations;
    this.schemaId = schemaId;
  }
}

const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class Validator {
  readonly #root: JsonSchema;
  readonly #id: string;
  readonly #patternCache = new Map<string, RegExp>();

  constructor(schema: JsonSchema) {
    this.#root = schema;
    this.#id = schema.$id ?? schema.title ?? "schema";
  }

  get schemaId(): string {
    return this.#id;
  }

  validate(value: unknown): SchemaViolation[] {
    const violations: SchemaViolation[] = [];
    this.#check(value, this.#root, "", violations);
    return violations;
  }

  isValid(value: unknown): boolean {
    return this.validate(value).length === 0;
  }

  /** Validate and narrow, throwing a structured error on failure. */
  parse<T>(value: unknown): T {
    const violations = this.validate(value);
    if (violations.length > 0) throw new SchemaValidationError(this.#id, violations);
    return value as T;
  }

  #resolve(ref: string): JsonSchema {
    if (!ref.startsWith("#/$defs/")) {
      throw new Error(`unsupported $ref "${ref}" (only local #/$defs/ refs are supported)`);
    }
    const name = ref.slice("#/$defs/".length);
    const target = this.#root.$defs?.[name];
    if (!target) throw new Error(`$ref "${ref}" does not resolve`);
    return target;
  }

  #regex(pattern: string): RegExp {
    let re = this.#patternCache.get(pattern);
    if (!re) {
      re = new RegExp(pattern, "u");
      this.#patternCache.set(pattern, re);
    }
    return re;
  }

  #check(value: unknown, schema: JsonSchema, path: string, out: SchemaViolation[]): void {
    if (schema.$ref) {
      this.#check(value, this.#resolve(schema.$ref), path, out);
      return;
    }

    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((t) => matchesType(value, t))) {
        out.push({
          path,
          keyword: "type",
          message: `expected ${types.join(" | ")}, received ${describe(value)}`,
        });
        return;
      }
    }

    if (schema.const !== undefined && !deepEqual(value, schema.const)) {
      out.push({
        path,
        keyword: "const",
        message: `expected constant ${JSON.stringify(schema.const)}`,
      });
    }

    if (schema.enum && !schema.enum.some((option) => deepEqual(option, value))) {
      out.push({
        path,
        keyword: "enum",
        message: `expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`,
      });
    }

    if (typeof value === "string") this.#checkString(value, schema, path, out);
    if (typeof value === "number") this.#checkNumber(value, schema, path, out);
    if (Array.isArray(value)) this.#checkArray(value, schema, path, out);
    if (isPlainObject(value)) this.#checkObject(value, schema, path, out);

    if (schema.allOf) {
      for (const sub of schema.allOf) this.#check(value, sub, path, out);
    }

    if (schema.anyOf) {
      const anyOk = schema.anyOf.some((sub) => {
        const local: SchemaViolation[] = [];
        this.#check(value, sub, path, local);
        return local.length === 0;
      });
      if (!anyOk) {
        out.push({ path, keyword: "anyOf", message: "value matched none of the allowed shapes" });
      }
    }

    if (schema.oneOf) {
      const branchErrors: SchemaViolation[][] = [];
      let matches = 0;
      for (const sub of schema.oneOf) {
        const local: SchemaViolation[] = [];
        this.#check(value, sub, path, local);
        if (local.length === 0) matches += 1;
        else branchErrors.push(local);
      }
      if (matches === 0) {
        // For discriminated unions the most useful message is the branch that
        // matched the discriminator, i.e. the one with the fewest violations.
        const closest = branchErrors.sort((a, b) => a.length - b.length)[0] ?? [];
        out.push({
          path,
          keyword: "oneOf",
          message: `value matched none of the ${schema.oneOf.length} allowed variants${
            closest.length > 0 ? ` (closest: ${closest[0]?.message ?? ""})` : ""
          }`,
        });
      } else if (matches > 1) {
        out.push({ path, keyword: "oneOf", message: "value matched more than one variant" });
      }
    }

    if (schema.not) {
      const local: SchemaViolation[] = [];
      this.#check(value, schema.not, path, local);
      if (local.length === 0) {
        out.push({ path, keyword: "not", message: "value matched a forbidden shape" });
      }
    }
  }

  #checkString(value: string, schema: JsonSchema, path: string, out: SchemaViolation[]): void {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      out.push({
        path,
        keyword: "minLength",
        message: `must be at least ${schema.minLength} characters`,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      out.push({
        path,
        keyword: "maxLength",
        message: `must be at most ${schema.maxLength} characters`,
      });
    }
    if (schema.pattern !== undefined && !this.#regex(schema.pattern).test(value)) {
      out.push({ path, keyword: "pattern", message: `must match ${schema.pattern}` });
    }
    if (schema.format === "date-time" && !DATE_TIME_RE.test(value)) {
      out.push({ path, keyword: "format", message: "must be an RFC 3339 date-time" });
    }
    if (schema.format === "uuid" && !UUID_RE.test(value)) {
      out.push({ path, keyword: "format", message: "must be a UUID" });
    }
  }

  #checkNumber(value: number, schema: JsonSchema, path: string, out: SchemaViolation[]): void {
    if (schema.minimum !== undefined && value < schema.minimum) {
      out.push({ path, keyword: "minimum", message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      out.push({ path, keyword: "maximum", message: `must be <= ${schema.maximum}` });
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      out.push({
        path,
        keyword: "exclusiveMinimum",
        message: `must be > ${schema.exclusiveMinimum}`,
      });
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      out.push({
        path,
        keyword: "exclusiveMaximum",
        message: `must be < ${schema.exclusiveMaximum}`,
      });
    }
    if (schema.multipleOf !== undefined && schema.multipleOf > 0) {
      const ratio = value / schema.multipleOf;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
        out.push({
          path,
          keyword: "multipleOf",
          message: `must be a multiple of ${schema.multipleOf}`,
        });
      }
    }
  }

  #checkArray(value: unknown[], schema: JsonSchema, path: string, out: SchemaViolation[]): void {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      out.push({ path, keyword: "minItems", message: `must have at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      out.push({ path, keyword: "maxItems", message: `must have at most ${schema.maxItems} items` });
    }
    if (schema.uniqueItems) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          out.push({ path, keyword: "uniqueItems", message: "items must be unique" });
          break;
        }
        seen.add(key);
      }
    }
    if (schema.prefixItems) {
      schema.prefixItems.forEach((sub, index) => {
        if (index < value.length) this.#check(value[index], sub, `${path}/${index}`, out);
      });
    }
    if (schema.items) {
      const start = schema.prefixItems?.length ?? 0;
      for (let i = start; i < value.length; i += 1) {
        this.#check(value[i], schema.items, `${path}/${i}`, out);
      }
    }
  }

  #checkObject(
    value: Record<string, unknown>,
    schema: JsonSchema,
    path: string,
    out: SchemaViolation[],
  ): void {
    for (const key of schema.required ?? []) {
      if (!(key in value) || value[key] === undefined) {
        out.push({
          path: `${path}/${escapePointer(key)}`,
          keyword: "required",
          message: `required property "${key}" is missing`,
        });
      }
    }

    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value && value[key] !== undefined) {
        this.#check(value[key], sub, `${path}/${escapePointer(key)}`, out);
      }
    }

    const patterns = Object.entries(schema.patternProperties ?? {});
    for (const [key, raw] of Object.entries(value)) {
      let matchedPattern = false;
      for (const [pattern, sub] of patterns) {
        if (this.#regex(pattern).test(key)) {
          matchedPattern = true;
          this.#check(raw, sub, `${path}/${escapePointer(key)}`, out);
        }
      }
      if (known.has(key) || matchedPattern) continue;
      if (schema.additionalProperties === false) {
        out.push({
          path: `${path}/${escapePointer(key)}`,
          keyword: "additionalProperties",
          message: `unknown property "${key}" is not allowed`,
        });
      } else if (typeof schema.additionalProperties === "object") {
        this.#check(raw, schema.additionalProperties, `${path}/${escapePointer(key)}`, out);
      }
    }
  }
}

function matchesType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value === undefined) return "undefined";
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key, index) => key === bKeys[index] && deepEqual(a[key], b[key]));
  }
  return false;
}

function escapePointer(key: string): string {
  return key.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

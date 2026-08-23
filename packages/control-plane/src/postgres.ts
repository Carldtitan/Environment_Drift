import type { ControlPlaneStore } from "./store.js";

/**
 * The Postgres store port (design 2.1).
 *
 * No Postgres instance is provisioned for this build, so this module does the
 * one thing it honestly can: validate the configuration and explain exactly
 * what is missing. It deliberately does not return a partially working store
 * or fall back to SQLite behind the operator's back - a hosted deployment that
 * asked for Postgres must fail loudly rather than write somewhere else.
 */

export interface PostgresConfig {
  readonly url: string;
  readonly schema: string;
  readonly maxConnections: number;
  readonly ssl: boolean;
}

export interface PostgresConfigProblem {
  readonly field: string;
  readonly message: string;
}

export function readPostgresConfig(env: NodeJS.ProcessEnv = process.env): PostgresConfig | null {
  const url = env["IWOMC_DATABASE_URL"];
  if (typeof url !== "string" || url.trim().length === 0) return null;
  return {
    url: url.trim(),
    schema: env["IWOMC_DATABASE_SCHEMA"] ?? "public",
    maxConnections: Number(env["IWOMC_DATABASE_MAX_CONNECTIONS"] ?? 10),
    ssl: env["IWOMC_DATABASE_SSL"] !== "false",
  };
}

export function validatePostgresConfig(config: PostgresConfig): PostgresConfigProblem[] {
  const problems: PostgresConfigProblem[] = [];
  let parsed: URL | null = null;
  try {
    parsed = new URL(config.url);
  } catch {
    problems.push({
      field: "IWOMC_DATABASE_URL",
      message: "is not a valid URL. Expected a postgres:// connection string.",
    });
  }
  if (parsed && parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    problems.push({
      field: "IWOMC_DATABASE_URL",
      message: `uses the "${parsed.protocol}" scheme; expected postgres: or postgresql:.`,
    });
  }
  if (parsed && parsed.pathname.replace(/^\//u, "").length === 0) {
    problems.push({ field: "IWOMC_DATABASE_URL", message: "does not name a database." });
  }
  if (!Number.isInteger(config.maxConnections) || config.maxConnections < 1 || config.maxConnections > 100) {
    problems.push({
      field: "IWOMC_DATABASE_MAX_CONNECTIONS",
      message: "must be an integer between 1 and 100.",
    });
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(config.schema)) {
    problems.push({ field: "IWOMC_DATABASE_SCHEMA", message: "must be a plain identifier." });
  }
  return problems;
}

export class PostgresUnavailableError extends Error {
  readonly problems: readonly PostgresConfigProblem[];
  constructor(message: string, problems: readonly PostgresConfigProblem[] = []) {
    super(message);
    this.name = "PostgresUnavailableError";
    this.problems = problems;
  }
}

/**
 * Build the Postgres-backed store. Throws with a precise reason until a driver
 * and a reachable database are provisioned; it never silently degrades.
 */
export async function createPostgresStore(config: PostgresConfig): Promise<ControlPlaneStore> {
  const problems = validatePostgresConfig(config);
  if (problems.length > 0) {
    throw new PostgresUnavailableError(
      `The Postgres configuration is not usable: ${problems.map((p) => `${p.field} ${p.message}`).join(" ")}`,
      problems,
    );
  }
  throw new PostgresUnavailableError(
    "IWOMC_DATABASE_URL is set, but this build ships no Postgres driver and no database has been provisioned. Unset IWOMC_DATABASE_URL to use the local SQLite store, or deploy with a build that includes the driver.",
  );
}

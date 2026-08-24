import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IntegrationStatus } from "@iwomc/contracts";
import { configPath, iwomcHome } from "./paths.js";

/**
 * Configuration and honest integration state (design 2.2).
 *
 * A configuration value being present makes an integration *configured*. Only a
 * successful live health or authentication call makes it *connected*. Nothing
 * in this file may return "connected" on its own.
 */

export interface IwomcConfig {
  /** Base URL of the hosted control plane, when the device has joined a team. */
  readonly controlPlaneUrl: string | null;
  readonly workspaceId: string | null;
  /** Modal profile name, or null to use the active profile. */
  readonly modalProfile: string | null;
  /** Hard ceiling on Modal spend for this installation, in USD. */
  readonly modalBudgetUsd: number;
  /** Maximum a single verification may cost, in USD. */
  readonly modalPerRunCapUsd: number;
  readonly modalCpuLimit: number;
  readonly modalMemoryMb: number;
  readonly modalTimeoutSeconds: number;
  readonly modalMaxRetries: number;
  readonly claudeMemBaseUrl: string | null;
  readonly consolePort: number;
  readonly requireApprovalForMutation: boolean;
  /**
   * Whether IWOMC keeps a recorder running by itself.
   *
   * On, a background recorder starts the first time you use IWOMC in a project
   * and keeps the package log current without anyone remembering to start it.
   * Off, nothing runs unless you run `iwomc watch` yourself.
   */
  readonly autocapture: boolean;
  /** How often the background recorder takes a full reading, in seconds. */
  readonly autocaptureIntervalSeconds: number;
}

export const DEFAULT_CONFIG: IwomcConfig = {
  controlPlaneUrl: null,
  workspaceId: null,
  modalProfile: null,
  // Enforced ceiling for this build. Verification refuses to start when the
  // remaining budget cannot cover the per-run cap.
  modalBudgetUsd: 50.0,
  modalPerRunCapUsd: 0.5,
  modalCpuLimit: 2,
  modalMemoryMb: 2048,
  modalTimeoutSeconds: 900,
  modalMaxRetries: 1,
  claudeMemBaseUrl: null,
  consolePort: 4319,
  requireApprovalForMutation: true,
  // On by default: a log that only exists when somebody remembered to start it
  // is not much of a log. It announces itself the first time and is switched
  // off with one command.
  autocapture: true,
  autocaptureIntervalSeconds: 45,
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IwomcConfig {
  const path = configPath(env);
  let fileConfig: Partial<IwomcConfig> = {};
  if (existsSync(path)) {
    try {
      fileConfig = JSON.parse(readFileSync(path, "utf8")) as Partial<IwomcConfig>;
    } catch {
      fileConfig = {};
    }
  }
  const merged: IwomcConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    controlPlaneUrl: env["IWOMC_CONTROL_PLANE_URL"] ?? fileConfig.controlPlaneUrl ?? null,
    workspaceId: env["IWOMC_WORKSPACE_ID"] ?? fileConfig.workspaceId ?? null,
    modalProfile: env["MODAL_PROFILE"] ?? fileConfig.modalProfile ?? null,
    claudeMemBaseUrl: env["CLAUDE_MEM_BASE_URL"] ?? fileConfig.claudeMemBaseUrl ?? null,
    consolePort: numberFrom(env["IWOMC_CONSOLE_PORT"]) ?? fileConfig.consolePort ?? DEFAULT_CONFIG.consolePort,
    modalBudgetUsd:
      numberFrom(env["IWOMC_MODAL_BUDGET_USD"]) ?? fileConfig.modalBudgetUsd ?? DEFAULT_CONFIG.modalBudgetUsd,
    autocapture:
      booleanFrom(env["IWOMC_AUTOCAPTURE"]) ?? fileConfig.autocapture ?? DEFAULT_CONFIG.autocapture,
    autocaptureIntervalSeconds:
      numberFrom(env["IWOMC_AUTOCAPTURE_INTERVAL"]) ??
      fileConfig.autocaptureIntervalSeconds ??
      DEFAULT_CONFIG.autocaptureIntervalSeconds,
  };
  return merged;
}

export function saveConfig(config: Partial<IwomcConfig>, env: NodeJS.ProcessEnv = process.env): IwomcConfig {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const current = loadConfig(env);
  const next = { ...current, ...config };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * Read a switch from the environment.
 *
 * Anything unrecognised returns null rather than false, so a typo falls back
 * to the configured value instead of silently turning a feature off.
 */
function booleanFrom(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const text = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return null;
}

function numberFrom(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Integration configuration validation
// ---------------------------------------------------------------------------

export interface IntegrationRequirement {
  readonly name: string;
  readonly description: string;
  readonly present: boolean;
}

export interface IntegrationReport {
  readonly id: "github" | "modal" | "claude_mem" | "control_plane" | "database" | "object_store";
  readonly label: string;
  /** All required configuration values are present. */
  readonly configured: boolean;
  /**
   * Live state. Only a component that actually performed a successful health
   * call may raise this above `not_configured`/`disconnected`.
   */
  readonly status: IntegrationStatus;
  readonly requirements: readonly IntegrationRequirement[];
  /** What a human should do next, in one sentence. */
  readonly nextAction: string;
  readonly detail?: string;
}

function requirement(
  name: string,
  description: string,
  env: NodeJS.ProcessEnv,
): IntegrationRequirement {
  const value = env[name];
  return { name, description, present: typeof value === "string" && value.trim().length > 0 };
}

/**
 * Static configuration validation. This never contacts a service, so every
 * status it can produce is `not_configured` or `disconnected` - a caller must
 * run the live probe to reach `connected`.
 */
export function validateIntegrationConfig(
  config: IwomcConfig,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationReport[] {
  const reports: IntegrationReport[] = [];

  const githubRequirements = [
    requirement("IWOMC_GITHUB_APP_ID", "Numeric GitHub App ID", env),
    requirement("IWOMC_GITHUB_APP_CLIENT_ID", "GitHub App client ID for the device flow", env),
    requirement("IWOMC_GITHUB_APP_PRIVATE_KEY", "PEM private key for installation tokens", env),
  ];
  reports.push({
    id: "github",
    label: "GitHub App",
    configured: githubRequirements.every((entry) => entry.present),
    status: githubRequirements.every((entry) => entry.present) ? "disconnected" : "not_configured",
    requirements: githubRequirements,
    nextAction: githubRequirements.every((entry) => entry.present)
      ? "Run `iwomc login` to complete the GitHub App device flow."
      : "Create a GitHub App and set IWOMC_GITHUB_APP_ID, IWOMC_GITHUB_APP_CLIENT_ID, and IWOMC_GITHUB_APP_PRIVATE_KEY.",
    detail:
      "Sign-in and private-repository access use a GitHub App installation, which is narrower than a user OAuth token.",
  });

  const modalRequirements: IntegrationRequirement[] = [
    {
      name: "MODAL_TOKEN_ID / ~/.modal.toml",
      description: "Modal token id, from the environment or an active CLI profile",
      present: modalCredentialPresent(env),
    },
    {
      name: "MODAL_TOKEN_SECRET / ~/.modal.toml",
      description: "Modal token secret, from the environment or an active CLI profile",
      present: modalCredentialPresent(env),
    },
  ];
  reports.push({
    id: "modal",
    label: "Modal clean verifier",
    configured: modalRequirements.every((entry) => entry.present),
    status: modalRequirements.every((entry) => entry.present) ? "disconnected" : "not_configured",
    requirements: modalRequirements,
    nextAction: modalRequirements.every((entry) => entry.present)
      ? "Run `iwomc doctor` to check the credentials against Modal."
      : "Run `modal token set --token-id <id> --token-secret <secret>`, or set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.",
    detail: `Clean verification is capped at USD ${config.modalBudgetUsd.toFixed(2)} for this installation.`,
  });

  reports.push({
    id: "claude_mem",
    label: "Claude-Mem worker",
    configured: true,
    status: "disconnected",
    requirements: [
      {
        name: "CLAUDE_MEM_WORKER_PORT",
        description: "Local worker port; defaults to the per-user port the worker computes",
        present: true,
      },
    ],
    nextAction:
      "Start the local Claude-Mem worker. IWOMC keeps working without it and shows memory as disconnected.",
    detail: "Used for redacted lifecycle observations and explanation only - never for environment truth.",
  });

  reports.push({
    id: "control_plane",
    label: "Team control plane",
    configured: config.controlPlaneUrl !== null,
    status: config.controlPlaneUrl !== null ? "disconnected" : "not_configured",
    requirements: [
      {
        name: "IWOMC_CONTROL_PLANE_URL",
        description: "Base URL of the hosted control plane",
        present: config.controlPlaneUrl !== null,
      },
    ],
    nextAction:
      config.controlPlaneUrl !== null
        ? "Run `iwomc join <invitation>` to enroll this device in a workspace."
        : "Run `iwomc serve` for a local control plane, or set IWOMC_CONTROL_PLANE_URL to a hosted one.",
  });

  const databaseRequirements = [requirement("IWOMC_DATABASE_URL", "Postgres connection string", env)];
  reports.push({
    id: "database",
    label: "Durable Postgres",
    configured: databaseRequirements.every((entry) => entry.present),
    status: databaseRequirements.every((entry) => entry.present) ? "disconnected" : "not_configured",
    requirements: databaseRequirements,
    nextAction: databaseRequirements.every((entry) => entry.present)
      ? "Start the control plane; it will report whether the connection succeeded."
      : "Set IWOMC_DATABASE_URL to use Postgres. Without it the control plane uses its local SQLite store.",
    detail: "The control plane runs on SQLite when no Postgres URL is configured; both use the same store interface.",
  });

  const objectStoreRequirements = [
    requirement("IWOMC_OBJECT_STORE_ENDPOINT", "S3-compatible endpoint", env),
    requirement("IWOMC_OBJECT_STORE_BUCKET", "Private bucket name", env),
    requirement("IWOMC_OBJECT_STORE_ACCESS_KEY_ID", "Access key id", env),
    requirement("IWOMC_OBJECT_STORE_SECRET_ACCESS_KEY", "Secret access key", env),
  ];
  reports.push({
    id: "object_store",
    label: "Artifact object store",
    configured: objectStoreRequirements.every((entry) => entry.present),
    status: objectStoreRequirements.every((entry) => entry.present) ? "disconnected" : "not_configured",
    requirements: objectStoreRequirements,
    nextAction: objectStoreRequirements.every((entry) => entry.present)
      ? "Start the control plane; it will report whether the bucket is reachable."
      : "Set the IWOMC_OBJECT_STORE_* values to store bounded logs off-device. Without them logs stay in the local encrypted store.",
  });

  return reports;
}

/** True when Modal credentials exist in the environment or a CLI profile. */
export function modalCredentialPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  if (
    typeof env["MODAL_TOKEN_ID"] === "string" &&
    env["MODAL_TOKEN_ID"].trim().length > 0 &&
    typeof env["MODAL_TOKEN_SECRET"] === "string" &&
    env["MODAL_TOKEN_SECRET"].trim().length > 0
  ) {
    return true;
  }
  return readModalProfileNames(env).length > 0;
}

/**
 * Profile names present in `~/.modal.toml`. Only names are read; token values
 * are never loaded into IWOMC's memory or logs.
 */
export function readModalProfileNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env["MODAL_CONFIG_PATH"] ?? `${env["HOME"] ?? env["USERPROFILE"] ?? ""}/.modal.toml`;
  try {
    if (!existsSync(home)) return [];
    const body = readFileSync(home, "utf8");
    return [...body.matchAll(/^\[([^\]]+)\]/gmu)].map((match) => match[1] as string);
  } catch {
    return [];
  }
}

export function homeDirectoryForDisplay(env: NodeJS.ProcessEnv = process.env): string {
  return iwomcHome(env);
}

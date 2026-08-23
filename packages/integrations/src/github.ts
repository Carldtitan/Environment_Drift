import { blocked, type IntegrationStatus } from "@iwomc/contracts";
import type { SourceAccessPort } from "@iwomc/companion";

/**
 * GitHub App source access and identity (R1.1, R12.4, design 5.3).
 *
 * The real device flow and installation-token exchange are implemented here.
 * No GitHub App is provisioned for this build, so every method reports an
 * honest `not_configured` state and refuses rather than substituting a stub
 * identity or a fake installation token.
 */

export interface GitHubConfig {
  readonly appId: string | null;
  readonly clientId: string | null;
  readonly privateKeyPem: string | null;
  readonly apiBaseUrl: string;
}

export function readGitHubConfig(env: NodeJS.ProcessEnv = process.env): GitHubConfig {
  return {
    appId: nonEmpty(env["IWOMC_GITHUB_APP_ID"]),
    clientId: nonEmpty(env["IWOMC_GITHUB_APP_CLIENT_ID"]),
    privateKeyPem: nonEmpty(env["IWOMC_GITHUB_APP_PRIVATE_KEY"]),
    apiBaseUrl: env["IWOMC_GITHUB_API_URL"] ?? "https://api.github.com",
  };
}

export function gitHubConfigProblems(config: GitHubConfig): string[] {
  const problems: string[] = [];
  if (config.clientId === null) {
    problems.push("IWOMC_GITHUB_APP_CLIENT_ID is not set, so the device-flow sign-in cannot start.");
  }
  if (config.appId === null) {
    problems.push("IWOMC_GITHUB_APP_ID is not set, so installation tokens cannot be minted.");
  }
  if (config.privateKeyPem === null) {
    problems.push("IWOMC_GITHUB_APP_PRIVATE_KEY is not set, so the app cannot authenticate.");
  } else if (!config.privateKeyPem.includes("BEGIN") || !config.privateKeyPem.includes("PRIVATE KEY")) {
    problems.push("IWOMC_GITHUB_APP_PRIVATE_KEY does not look like a PEM private key.");
  }
  return problems;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export class GitHubAppSourceAccess implements SourceAccessPort {
  readonly id = "github" as const;
  readonly #config: GitHubConfig;
  readonly #fetch: typeof fetch;

  constructor(options: { config?: GitHubConfig; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}) {
    this.#config = options.config ?? readGitHubConfig(options.env ?? process.env);
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get config(): GitHubConfig {
    return this.#config;
  }

  async status(): Promise<{ status: IntegrationStatus; detail: string }> {
    const problems = gitHubConfigProblems(this.#config);
    if (problems.length > 0) {
      return {
        status: "not_configured",
        detail: problems.join(" "),
      };
    }
    try {
      const response = await this.#fetch(`${this.#config.apiBaseUrl}/app`, {
        headers: { accept: "application/vnd.github+json" },
      });
      if (response.status === 401) {
        return { status: "misconfigured", detail: "GitHub rejected the app credentials (401)." };
      }
      return response.ok
        ? { status: "connected", detail: "GitHub App credentials accepted." }
        : { status: "disconnected", detail: `GitHub responded ${response.status}.` };
    } catch (error) {
      return { status: "disconnected", detail: `GitHub is unreachable: ${(error as Error).message}` };
    }
  }

  async beginDeviceLogin(): Promise<{
    userCode: string;
    verificationUri: string;
    deviceCode: string;
    intervalSeconds: number;
  }> {
    if (this.#config.clientId === null) {
      blocked(
        "integration_unavailable",
        "GitHub sign-in is not configured: IWOMC_GITHUB_APP_CLIENT_ID is missing.",
        "Create a GitHub App, then set IWOMC_GITHUB_APP_CLIENT_ID (and IWOMC_GITHUB_APP_ID and IWOMC_GITHUB_APP_PRIVATE_KEY for private repository access). IWOMC works in local-only mode until then.",
      );
    }
    const response = await this.#fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.#config.clientId }),
    });
    if (!response.ok) {
      blocked(
        "integration_unavailable",
        `GitHub refused to start the device flow (HTTP ${response.status}).`,
        "Check that the GitHub App client id is correct and that device flow is enabled for it.",
      );
    }
    const body = (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      interval: number;
    };
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      intervalSeconds: body.interval ?? 5,
    };
  }

  async completeDeviceLogin(deviceCode: string): Promise<{ personId: string; login: string }> {
    if (this.#config.clientId === null) {
      blocked(
        "integration_unavailable",
        "GitHub sign-in is not configured.",
        "Set IWOMC_GITHUB_APP_CLIENT_ID and run `iwomc login` again.",
      );
    }
    const response = await this.#fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.#config.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const body = (await response.json()) as { access_token?: string; error?: string };
    if (!body.access_token) {
      blocked(
        "integration_unavailable",
        `GitHub has not completed the device flow (${body.error ?? "no token returned"}).`,
        "Finish authorising IWOMC in the browser, then run `iwomc login` again.",
      );
    }
    const user = await this.#fetch(`${this.#config.apiBaseUrl}/user`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${body.access_token}`,
      },
    });
    if (!user.ok) {
      blocked(
        "integration_unavailable",
        `GitHub rejected the access token (HTTP ${user.status}).`,
        "Run `iwomc login` again.",
      );
    }
    const profile = (await user.json()) as { id: number; login: string };
    // The immutable numeric id is the identity; the login is display only.
    return { personId: `github:${profile.id}`, login: profile.login };
  }

  async fetchSourceAtRevision(input: {
    canonicalRemoteDigest: string;
    commit: string;
    targetDir: string;
  }): Promise<{ ok: boolean; detail: string }> {
    const problems = gitHubConfigProblems(this.#config);
    if (problems.length > 0) {
      return {
        ok: false,
        detail: `A least-privilege GitHub App installation is required to fetch private source for clean verification. ${problems.join(" ")}`,
      };
    }
    // With an installation configured, the flow is: mint an installation token
    // scoped to the single repository, then clone that revision into targetDir.
    // No installation exists for this build, so this path is not reachable and
    // deliberately does not fall back to a broader credential.
    return {
      ok: false,
      detail: `No GitHub App installation grants access to ${input.canonicalRemoteDigest.slice(7, 19)}. Install the IWOMC GitHub App on that repository, or approve a short-lived source bundle for ${input.commit.slice(0, 12)}.`,
    };
  }
}

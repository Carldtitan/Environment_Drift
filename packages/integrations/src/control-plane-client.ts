import { blocked, parseContract, type EnvironmentContractV1, type IntegrationStatus, type PlatformTarget, type RescueRequestV1 } from "@iwomc/contracts";
import type { ControlPlanePort, DeviceCredentials } from "@iwomc/companion";
import type { EnvironmentReceiptV1, RescueOutcomeV1 } from "@iwomc/contracts";

/**
 * HTTP client for the IWOMC control plane.
 *
 * The device authenticates with a bearer credential issued at enrollment; the
 * private signing key never leaves the machine. Every response that claims to
 * be a contract is re-validated against the schema before it is trusted.
 */
export class ControlPlaneClient implements ControlPlanePort {
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: { baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async health(): Promise<{ status: IntegrationStatus; detail: string }> {
    try {
      const response = await this.#raw("GET", "/api/health");
      if (!response.ok) {
        return { status: "disconnected", detail: `Control plane responded ${response.status}.` };
      }
      const body = (await response.json()) as { status?: string; version?: string };
      return {
        status: body.status === "ok" ? "connected" : "disconnected",
        detail:
          body.status === "ok"
            ? `Control plane ${body.version ?? ""} responded at ${this.baseUrl}.`
            : `Control plane at ${this.baseUrl} is not healthy.`,
      };
    } catch (error) {
      return { status: "disconnected", detail: `Control plane unreachable: ${(error as Error).message}` };
    }
  }

  async enrollDevice(input: {
    invitationToken: string;
    publicKey: string;
    displayName: string;
    platform: PlatformTarget;
  }): Promise<{ deviceId: string; deviceToken: string; workspaceId: string; personId: string; role: string }> {
    const body = await this.#json<{
      deviceId: string;
      deviceToken: string;
      workspaceId: string;
      personId: string;
      role: string;
    }>("POST", "/api/devices/enroll", null, {
      invitationToken: input.invitationToken,
      publicKey: input.publicKey,
      displayName: input.displayName,
      platform: input.platform,
    });
    return body;
  }

  async registerProjectBinding(input: {
    credentials: DeviceCredentials;
    projectId: string | null;
    projectName: string;
    canonicalRemoteDigest: string;
    subdirectory: string;
  }): Promise<{ projectId: string }> {
    return await this.#json<{ projectId: string }>("POST", "/api/projects/bind", input.credentials, {
      projectId: input.projectId,
      projectName: input.projectName,
      canonicalRemoteDigest: input.canonicalRemoteDigest,
      subdirectory: input.subdirectory,
    });
  }

  async publishReceipt(input: {
    credentials: DeviceCredentials;
    receipt: EnvironmentReceiptV1;
  }): Promise<{ accepted: boolean }> {
    return await this.#json<{ accepted: boolean }>("POST", "/api/receipts", input.credentials, input.receipt);
  }

  async publishContract(input: {
    credentials: DeviceCredentials;
    contract: EnvironmentContractV1;
  }): Promise<{ contract: EnvironmentContractV1 }> {
    const body = await this.#json<{ contract: unknown }>("POST", "/api/contracts", input.credentials, input.contract);
    return { contract: parseContract(body.contract) };
  }

  async fetchContract(input: {
    credentials: DeviceCredentials;
    projectId: string;
    commit: string;
  }): Promise<{ exact: EnvironmentContractV1 | null; nearest: EnvironmentContractV1 | null }> {
    const query = new URLSearchParams({ projectId: input.projectId, commit: input.commit });
    const body = await this.#json<{ exact: unknown | null; nearest: unknown | null }>(
      "GET",
      `/api/contracts/resolve?${query.toString()}`,
      input.credentials,
    );
    return {
      exact: body.exact ? parseContract(body.exact) : null,
      nearest: body.nearest ? parseContract(body.nearest) : null,
    };
  }

  async publishRescueOutcome(input: {
    credentials: DeviceCredentials;
    outcome: RescueOutcomeV1;
  }): Promise<{ accepted: boolean }> {
    return await this.#json<{ accepted: boolean }>(
      "POST",
      "/api/rescue-runs",
      input.credentials,
      input.outcome,
    );
  }

  async pollJobs(input: { credentials: DeviceCredentials }): Promise<RescueRequestV1[]> {
    const body = await this.#json<{ jobs: RescueRequestV1[] }>("GET", "/api/jobs/poll", input.credentials);
    return body.jobs;
  }

  async reportJobProgress(input: {
    credentials: DeviceCredentials;
    jobId: string;
    state: string;
    message: string;
  }): Promise<void> {
    await this.#json("POST", `/api/jobs/${encodeURIComponent(input.jobId)}/progress`, input.credentials, {
      state: input.state,
      message: input.message,
    });
  }

  async #raw(method: string, path: string, credentials?: DeviceCredentials | null, body?: unknown) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(credentials
            ? { authorization: `Bearer ${credentials.token}`, "x-iwomc-device": credentials.deviceId }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #json<T>(
    method: string,
    path: string,
    credentials?: DeviceCredentials | null,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#raw(method, path, credentials, body);
    } catch (error) {
      blocked(
        "integration_unavailable",
        `The control plane at ${this.baseUrl} is unreachable (${(error as Error).message}).`,
        "Start it with `iwomc serve`, or set IWOMC_CONTROL_PLANE_URL to a reachable instance.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      const detail = await safeText(response);
      blocked(
        response.status === 401 ? "device_revoked" : "workspace_forbidden",
        `The control plane refused this request (HTTP ${response.status}): ${detail}`,
        "Re-enroll this device with `iwomc join <invitation>`, or ask an owner to restore its access.",
      );
    }
    if (!response.ok) {
      const detail = await safeText(response);
      blocked(
        "integration_unavailable",
        `The control plane returned HTTP ${response.status}: ${detail}`,
        "Check the control-plane logs, then try again.",
      );
    }
    return (await response.json()) as T;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 400);
  } catch {
    return "no body";
  }
}

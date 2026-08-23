/**
 * The console's only channel to the control plane.
 *
 * The browser holds a session token and nothing else: no device credential, no
 * local filesystem path, no MCP transport. Every action it can take becomes a
 * signed job addressed to a device by id.
 */

const TOKEN_KEY = "iwomc.session";

export function readSessionToken(): string | null {
  // A fresh `iwomc serve` prints a link carrying a one-time token; it is moved
  // into storage and stripped from the address bar immediately.
  const hash = window.location.hash;
  const match = /token=([^&]+)/u.exec(hash);
  if (match) {
    const token = decodeURIComponent(match[1] as string);
    try {
      window.sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      // Private-mode storage refusal: the token still works for this page load.
    }
    const rest = hash.replace(/[#&]?token=[^&]*/u, "");
    window.history.replaceState(null, "", `${window.location.pathname}${rest || ""}`);
    return token;
  }
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearSessionToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clear.
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly blocker: { code: string; message: string; nextAction: string } | null;

  constructor(status: number, message: string, blocker: ApiError["blocker"] = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.blocker = blocker;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readSessionToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const payload = body as { error?: string; blocker?: ApiError["blocker"] } | null;
    throw new ApiError(
      response.status,
      payload?.error ?? `The control plane returned HTTP ${response.status}.`,
      payload?.blocker ?? null,
    );
  }
  return body as T;
}

// ---------------------------------------------------------------- types --

export type SupportLevel = "native" | "recipe" | "observe_only";
export type ContractState =
  | "candidate"
  | "approved"
  | "locally_checked"
  | "clean_verified"
  | "rejected"
  | "unsupported"
  | "inconclusive"
  | "superseded"
  | "revoked";

export interface Session {
  authenticated: boolean;
  detail?: string;
  personId?: string;
  person?: { id: string; displayName: string } | null;
  workspaceId?: string;
  workspace?: { id: string; name: string; createdAt: string } | null;
  role?: string;
  localDeviceId?: string | null;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  canonicalRemoteDigest: string;
  subdirectory: string;
  createdAt: string;
}

export interface TeamContract {
  contract: {
    id: string;
    digest: string;
    state: ContractState;
    support: SupportLevel;
    projectId: string;
    issuedAt: string;
    source: { commit: string; branch?: string; subdirectory: string; declaredFileDigests: { path: string }[] };
    targets: { os: string; arch: string }[];
    steps: { id: string; kind: string; description: string }[];
    proof: { argv: string[]; workDir: string; timeoutMs: number };
    requirements: {
      runtimes: { runtime: string; versionSpec: string }[];
      packages: { name: string; versionSpec: string; declared: boolean; source: string }[];
      systemTools: { name: string }[];
      secrets: { name: string; required: boolean; reference?: string }[];
    };
    signature?: { signer: string; keyId: string; signedAt: string };
    approval?: { approvedBy: string; approvedAt: string };
    adapters: string[];
  };
  receivedAt: string;
}

export interface RescueOutcome {
  runId: string;
  projectId: string;
  deviceId: string;
  contractDigest: string;
  commit: string;
  state: "working" | "blocked" | "failed" | "unsupported" | "inconclusive";
  startedAt: string;
  endedAt: string;
  stepsApplied: string[];
  assurance: string;
  proof?: { exitCode: number | null; durationMs: number; timedOut: boolean };
  blocker?: { code: string; message: string; nextAction: string };
}

export interface Device {
  id: string;
  displayName: string;
  personId: string;
  state: "unpaired" | "enrolled" | "active" | "revoked";
  enrolledAt: string;
  lastSeenAt?: string;
  platform: { os: string; arch: string };
}

export interface Job {
  request: {
    id: string;
    action: "capture" | "verify" | "rescue" | "promote";
    projectId: string;
    deviceId: string;
    issuedAt: string;
    expiresAt: string;
    requestedBy: string;
  };
  state: string;
  progress: { at: string; state: string; message: string }[];
  outcomeRunId: string | null;
}

export interface LocalStatus {
  bound: boolean;
  detail?: string;
  project?: {
    projectName: string;
    commit: string;
    branch: string | null;
    subdirectory: string;
    worktreeDirty: boolean;
    dirtyPathCount: number;
  } | null;
  projectError?: string | null;
  support?: {
    level: SupportLevel;
    reason: string;
    recognized: { manager: string; support: SupportLevel; note: string; signals: string[] }[];
  };
  proof?: { configured: boolean; command: string | null };
  canRescueNow?: { possible: boolean; reason: string };
  exactContract?: { id: string; digest: string; state: ContractState; assurance: string } | null;
  memory?: { status: string; detail: string };
  driftCount?: number;
  device?: { displayName: string; state: string; identity: string; localOnly: boolean; platform: string };
  mode?: string;
}

export interface Overview {
  projects: Project[];
  selectedProjectId: string | null;
  contracts: TeamContract[];
  runs: RescueOutcome[];
  devices: Device[];
  jobs: Job[];
  local: LocalStatus | null;
}

export interface TeamView {
  members: { personId: string; role: string; joinedAt: string; person: { displayName: string } }[];
  devices: Device[];
  invitations: { id: string; role: string; createdAt: string; expiresAt: string; acceptedAt?: string; revokedAt?: string }[];
  role: string;
}

export interface IntegrationReport {
  id: string;
  label: string;
  configured: boolean;
  status: string;
  requirements: { name: string; description: string; present: boolean }[];
  nextAction: string;
  detail?: string;
}

export interface SettingsView {
  store: string;
  servicePublicKey: string;
  localAvailable: boolean;
  integrations: {
    reports: IntegrationReport[];
    memory: { status: string; detail: string; endpoint: string | null };
    verifiers: { id: string; label: string; available: boolean; detail: string; remainingBudgetUsd?: number }[];
  } | null;
}

export interface AuditView {
  events: {
    id: string;
    at: string;
    actor: string;
    action: string;
    subject: string;
    detail: Record<string, unknown>;
    digest: string;
  }[];
  chain: { ok: boolean; brokenAt?: string };
}

export interface DriftView {
  available: boolean;
  detail?: string;
  findings: {
    id: string;
    kind: string;
    summary: string;
    affectedDeclaration: string;
    adapterId: string;
    detectedAt: string;
    commit: string;
  }[];
}

export interface CapabilityView {
  adapters:
    | {
        id: string;
        ecosystem: string;
        manager: string;
        support: SupportLevel;
        conformanceTested: boolean;
        supportNote: string;
        declaredFiles: string[];
        capabilities: Record<string, boolean>;
      }[]
    | null;
}

// -------------------------------------------------------------- endpoints --

export const api = {
  session: () => request<Session>("/api/session"),
  overview: (projectId: string | null) =>
    request<Overview>(`/api/overview${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  contracts: (projectId: string) =>
    request<{ contracts: TeamContract[] }>(`/api/contracts?projectId=${encodeURIComponent(projectId)}`),
  runs: (projectId: string | null) =>
    request<{ runs: RescueOutcome[] }>(
      `/api/rescue-runs${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),
  drift: (projectId: string | null) =>
    request<DriftView>(`/api/drift${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  team: () => request<TeamView>("/api/team"),
  jobs: () => request<{ jobs: Job[] }>("/api/jobs"),
  audit: () => request<AuditView>("/api/audit"),
  settings: () => request<SettingsView>("/api/settings"),
  capabilities: () => request<CapabilityView>("/api/capabilities"),

  createJob: (input: { projectId: string; deviceId: string; action: string; contractId?: string }) =>
    request<{ job: Job["request"] }>("/api/jobs", { method: "POST", body: JSON.stringify(input) }),
  createInvitation: (role: string) =>
    request<{ invitation: { id: string }; token: string; command: string }>("/api/invitations", {
      method: "POST",
      body: JSON.stringify({ role }),
    }),
  revokeInvitation: (id: string) =>
    request<{ revoked: boolean }>(`/api/invitations/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
  revokeDevice: (id: string) =>
    request<{ revoked: boolean }>(`/api/devices/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
  changeRole: (personId: string, role: string) =>
    request<{ updated: boolean }>(`/api/members/${encodeURIComponent(personId)}/role`, {
      method: "POST",
      body: JSON.stringify({ role }),
    }),
};

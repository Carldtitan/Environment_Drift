import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve as resolvePath } from "node:path";
import { BlockedError, WORKSPACE_ROLES, type Invitation, type WorkspaceRole } from "@iwomc/contracts";
import { ControlPlaneService, ForbiddenError, type Principal } from "./service.js";
import type { ControlPlaneStore } from "./store.js";

/**
 * The control-plane HTTP surface.
 *
 * The browser talks only to this API. It never receives a local filesystem
 * path, never speaks MCP, and never reaches the Companion directly: a console
 * action becomes a signed, expiring job addressed to a device by id (R10.4).
 */

/** Local, device-side facts the console shows next to the shared records. */
export interface LocalContext {
  status(projectId: string | null): Promise<unknown>;
  integrations(): Promise<unknown>;
  drift(projectId: string): Promise<unknown>;
  capabilities(): Promise<unknown>;
  deviceId(): string | null;
}

export interface ServerOptions {
  readonly service: ControlPlaneService;
  readonly store: ControlPlaneStore;
  /** Directory containing the built console assets. */
  readonly consoleDir?: string | null;
  readonly local?: LocalContext | null;
  readonly version?: string;
}

interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly body: unknown;
  readonly service: ControlPlaneService;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function createControlPlaneServer(options: ServerOptions): Server {
  const { service, store } = options;
  const version = options.version ?? "0.1.0";
  const consoleDir = options.consoleDir ? resolvePath(options.consoleDir) : null;

  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      sendJson(res, 500, { error: (error as Error).message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    // The console is same-origin; no cross-origin credentials are permitted.
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (!url.pathname.startsWith("/api/")) {
      await serveConsole(url.pathname, res);
      return;
    }

    let body: unknown = undefined;
    if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: (error as Error).message });
        return;
      }
    }

    const ctx: RouteContext = { req, res, url, body, service };
    try {
      await route(ctx);
    } catch (error) {
      if (error instanceof ForbiddenError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      if (error instanceof BlockedError) {
        sendJson(res, 409, { error: error.blocker.message, blocker: error.blocker });
        return;
      }
      sendJson(res, 500, { error: (error as Error).message });
    }
  }

  async function route(ctx: RouteContext): Promise<void> {
    const { req, res, url } = ctx;
    const path = url.pathname;
    const method = req.method ?? "GET";

    // -- public -----------------------------------------------------------

    if (method === "GET" && path === "/api/health") {
      sendJson(res, 200, {
        status: "ok",
        version,
        store: store.kind,
        servicePublicKey: service.servicePublicKey,
      });
      return;
    }

    if (method === "POST" && path === "/api/devices/enroll") {
      const input = ctx.body as {
        invitationToken?: string;
        publicKey?: string;
        displayName?: string;
        platform?: { os: string; arch: string };
      };
      if (!input?.invitationToken || !input.publicKey || !input.displayName || !input.platform) {
        sendJson(res, 400, { error: "invitationToken, publicKey, displayName, and platform are required." });
        return;
      }
      const result = service.enrollDevice({
        invitationToken: input.invitationToken,
        publicKey: input.publicKey,
        displayName: input.displayName,
        platform: input.platform as never,
      });
      sendJson(res, 201, result);
      return;
    }

    // -- device-authenticated ---------------------------------------------

    const bearer = readBearer(req);
    const devicePrincipal = safeDevice(service, bearer);

    if (devicePrincipal) {
      if (method === "POST" && path === "/api/projects/bind") {
        const input = ctx.body as {
          projectId?: string | null;
          projectName?: string;
          canonicalRemoteDigest?: string;
          subdirectory?: string;
        };
        if (!input?.projectName || !input.canonicalRemoteDigest || !input.subdirectory) {
          sendJson(res, 400, { error: "projectName, canonicalRemoteDigest, and subdirectory are required." });
          return;
        }
        sendJson(
          res,
          200,
          service.bindProject(devicePrincipal, {
            projectId: input.projectId ?? null,
            projectName: input.projectName,
            canonicalRemoteDigest: input.canonicalRemoteDigest,
            subdirectory: input.subdirectory,
          }),
        );
        return;
      }

      if (method === "POST" && path === "/api/receipts") {
        sendJson(res, 201, service.publishReceipt(devicePrincipal, ctx.body));
        return;
      }

      if (method === "POST" && path === "/api/contracts") {
        sendJson(res, 201, service.publishContract(devicePrincipal, ctx.body));
        return;
      }

      if (method === "GET" && path === "/api/contracts/resolve") {
        const projectId = url.searchParams.get("projectId");
        const commit = url.searchParams.get("commit");
        if (!projectId || !commit) {
          sendJson(res, 400, { error: "projectId and commit are required." });
          return;
        }
        sendJson(res, 200, service.resolveContract(devicePrincipal, { projectId, commit }));
        return;
      }

      if (method === "POST" && path === "/api/rescue-runs") {
        sendJson(res, 201, service.publishRescueOutcome(devicePrincipal, ctx.body));
        return;
      }

      if (method === "GET" && path === "/api/jobs/poll") {
        sendJson(res, 200, { jobs: service.pollJobs(devicePrincipal) });
        return;
      }

      const progressMatch = /^\/api\/jobs\/([^/]+)\/progress$/u.exec(path);
      if (method === "POST" && progressMatch) {
        const input = ctx.body as { state?: string; message?: string };
        service.reportJobProgress(
          devicePrincipal,
          decodeURIComponent(progressMatch[1] as string),
          input?.state ?? "running",
          input?.message ?? "",
        );
        sendJson(res, 202, { accepted: true });
        return;
      }
    }

    // -- console session --------------------------------------------------

    const person = service.authenticateSession(bearer ?? readCookie(req, "iwomc_session"));

    if (method === "GET" && path === "/api/session") {
      if (!person) {
        sendJson(res, 401, {
          authenticated: false,
          detail:
            "Open the Rescue Console with the link `iwomc serve` printed, or sign in with GitHub once a GitHub App is configured.",
        });
        return;
      }
      const workspace = store.getWorkspace(person.workspaceId);
      sendJson(res, 200, {
        authenticated: true,
        personId: person.personId,
        person: store.getPerson(person.personId),
        workspaceId: person.workspaceId,
        workspace,
        role: person.role,
        localDeviceId: (await options.local?.deviceId?.()) ?? options.local?.deviceId() ?? null,
      });
      return;
    }

    if (!person) {
      sendJson(res, 401, { error: "Authentication is required." });
      return;
    }

    const workspaceId = person.workspaceId;

    if (method === "GET" && path === "/api/overview") {
      const projectId = url.searchParams.get("projectId");
      const projects = service.listProjects(person, workspaceId);
      const selected = projectId ?? projects[0]?.id ?? null;
      sendJson(res, 200, {
        projects,
        selectedProjectId: selected,
        contracts: selected ? service.listContracts(person, workspaceId, selected) : [],
        runs: service.listRescueOutcomes(person, workspaceId, selected),
        devices: service.listDevices(person, workspaceId),
        jobs: service.listJobs(person, workspaceId),
        local: options.local ? await options.local.status(selected) : null,
      });
      return;
    }

    if (method === "GET" && path === "/api/projects") {
      sendJson(res, 200, { projects: service.listProjects(person, workspaceId) });
      return;
    }

    if (method === "GET" && path === "/api/contracts") {
      const projectId = url.searchParams.get("projectId");
      if (!projectId) {
        sendJson(res, 400, { error: "projectId is required." });
        return;
      }
      sendJson(res, 200, { contracts: service.listContracts(person, workspaceId, projectId) });
      return;
    }

    if (method === "GET" && path === "/api/rescue-runs") {
      const projectId = url.searchParams.get("projectId");
      sendJson(res, 200, {
        runs: service.listRescueOutcomes(person, workspaceId, projectId),
      });
      return;
    }

    if (method === "GET" && path === "/api/drift") {
      const projectId = url.searchParams.get("projectId");
      if (!options.local) {
        sendJson(res, 200, {
          available: false,
          detail:
            "Drift findings live on the device that captured them. Open the console on a machine running the Companion, or request a capture job for a device.",
          findings: [],
        });
        return;
      }
      sendJson(res, 200, {
        available: true,
        findings: await options.local.drift(projectId ?? ""),
      });
      return;
    }

    if (method === "GET" && path === "/api/team") {
      sendJson(res, 200, {
        members: service.listMembers(person, workspaceId),
        devices: service.listDevices(person, workspaceId),
        invitations: canManage(person)
          ? service.listInvitations(person, workspaceId).map(redactInvitation)
          : [],
        role: person.role,
      });
      return;
    }

    if (method === "POST" && path === "/api/invitations") {
      const input = ctx.body as { role?: string };
      const role = (input?.role ?? "developer") as WorkspaceRole;
      if (!WORKSPACE_ROLES.includes(role)) {
        sendJson(res, 400, { error: `role must be one of ${WORKSPACE_ROLES.join(", ")}.` });
        return;
      }
      const created = service.createInvitation(person, workspaceId, role);
      // The raw token is returned exactly once, here.
      sendJson(res, 201, {
        invitation: redactInvitation(created.invitation),
        token: created.token,
        command: `iwomc join ${created.token} --url ${publicOrigin(req)}`,
      });
      return;
    }

    const invitationRevoke = /^\/api\/invitations\/([^/]+)\/revoke$/u.exec(path);
    if (method === "POST" && invitationRevoke) {
      service.revokeInvitation(person, workspaceId, decodeURIComponent(invitationRevoke[1] as string));
      sendJson(res, 200, { revoked: true });
      return;
    }

    const deviceRevoke = /^\/api\/devices\/([^/]+)\/revoke$/u.exec(path);
    if (method === "POST" && deviceRevoke) {
      service.revokeDevice(person, workspaceId, decodeURIComponent(deviceRevoke[1] as string));
      sendJson(res, 200, { revoked: true });
      return;
    }

    const roleChange = /^\/api\/members\/([^/]+)\/role$/u.exec(path);
    if (method === "POST" && roleChange) {
      const input = ctx.body as { role?: string };
      const role = (input?.role ?? "developer") as WorkspaceRole;
      if (!WORKSPACE_ROLES.includes(role)) {
        sendJson(res, 400, { error: `role must be one of ${WORKSPACE_ROLES.join(", ")}.` });
        return;
      }
      service.changeRole(person, workspaceId, decodeURIComponent(roleChange[1] as string), role);
      sendJson(res, 200, { updated: true });
      return;
    }

    if (method === "GET" && path === "/api/jobs") {
      sendJson(res, 200, { jobs: service.listJobs(person, workspaceId) });
      return;
    }

    if (method === "POST" && path === "/api/jobs") {
      const input = ctx.body as {
        projectId?: string;
        deviceId?: string;
        action?: "capture" | "verify" | "rescue" | "promote";
        contractId?: string;
      };
      if (!input?.projectId || !input.deviceId || !input.action) {
        sendJson(res, 400, { error: "projectId, deviceId, and action are required." });
        return;
      }
      const request = service.createJob(person, {
        workspaceId,
        projectId: input.projectId,
        deviceId: input.deviceId,
        action: input.action,
        ...(input.contractId ? { contractId: input.contractId } : {}),
      });
      sendJson(res, 202, { job: request });
      return;
    }

    if (method === "GET" && path === "/api/audit") {
      sendJson(res, 200, {
        events: service.listAudit(person, workspaceId),
        chain: service.verifyAuditChain(person, workspaceId),
      });
      return;
    }

    if (method === "GET" && path === "/api/settings") {
      sendJson(res, 200, {
        store: store.kind,
        servicePublicKey: service.servicePublicKey,
        integrations: options.local ? await options.local.integrations() : null,
        localAvailable: options.local !== null && options.local !== undefined,
      });
      return;
    }

    if (method === "GET" && path === "/api/capabilities") {
      sendJson(res, 200, {
        adapters: options.local ? await options.local.capabilities() : null,
      });
      return;
    }

    sendJson(res, 404, { error: `No route for ${method} ${path}` });
  }

  async function serveConsole(pathname: string, res: ServerResponse): Promise<void> {
    if (consoleDir === null) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        "The Rescue Console assets have not been built.\nRun `pnpm --filter @iwomc/console run build`, then restart `iwomc serve`.\nThe API at /api/* is running.\n",
      );
      return;
    }
    const requested = pathname === "/" ? "/index.html" : pathname;
    const target = safeJoin(consoleDir, requested);
    if (target === null) {
      res.writeHead(403).end();
      return;
    }
    try {
      const info = await stat(target);
      if (info.isFile()) {
        const body = await readFile(target);
        res.writeHead(200, {
          "content-type": contentTypeFor(target),
          "cache-control": requested === "/index.html" ? "no-store" : "public, max-age=300",
        });
        res.end(body);
        return;
      }
    } catch {
      // Fall through to the SPA entry point below.
    }
    try {
      const index = await readFile(join(consoleDir, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(index);
    } catch {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("The Rescue Console assets have not been built. Run `pnpm --filter @iwomc/console run build`.\n");
    }
  }
}

function safeDevice(service: ControlPlaneService, bearer: string | null) {
  if (!bearer) return null;
  try {
    return service.authenticateDevice(bearer);
  } catch {
    // A revoked or unattached device is simply not a device principal here;
    // the person-session path below will produce the right 401.
    return null;
  }
}

function canManage(principal: Principal): boolean {
  return principal.role === "owner" || principal.role === "maintainer";
}

/** The console never receives an invitation's token hash. */
function redactInvitation(invitation: Invitation): Omit<Invitation, "tokenHash"> {
  const { tokenHash: _tokenHash, ...rest } = invitation;
  void _tokenHash;
  return rest;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage, limitBytes = 4 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > limitBytes) throw new Error("Request body is larger than the 4 MB limit.");
    chunks.push(buffer);
  }
  if (total === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

function readBearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function publicOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1";
  return `http://${host}`;
}

function safeJoin(root: string, requested: string): string | null {
  const target = resolvePath(root, `.${requested}`);
  const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
  const targetKey = process.platform === "win32" ? target.toLowerCase() : target;
  if (targetKey !== rootKey && !targetKey.startsWith(rootKey + (process.platform === "win32" ? "\\" : "/"))) {
    return null;
  }
  return target;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

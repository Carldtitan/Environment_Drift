import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BlockedError,
  generateDeviceKeyPair,
  type KeyPair,
  type RescueEvent,
  type RescueRequestV1,
} from "@iwomc/contracts";
import {
  attachToWorkspace,
  currentPlatform,
  iwomcHome,
  saveConfig,
  type Companion,
} from "@iwomc/companion";
import {
  ControlPlaneService,
  SqliteControlPlaneStore,
  createControlPlaneServer,
  createPostgresStore,
  normalizePublicOrigin,
  readPostgresConfig,
  type ControlPlaneStore,
  type LocalContext,
} from "@iwomc/control-plane";
import { ControlPlaneClient } from "@iwomc/integrations";
import { buildCompanion } from "./wiring.js";
import { bullet, heading, line, style } from "./render.js";
import type { CliIo } from "./cli.js";
import { CLI_VERSION, EXIT } from "./cli.js";

/**
 * `iwomc serve` runs the control plane and the Rescue Console on this machine.
 *
 * The architecture is the hosted one, not a shortcut: the browser talks only to
 * the HTTP API, and the local Companion connects outbound as an enrolled device
 * that polls for signed jobs. Running both processes on one machine changes the
 * address, not the trust boundary.
 */

export interface ServeOptions {
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  /** Externally reachable URL used in invitations and local device config. */
  readonly publicUrl?: string | undefined;
  readonly open?: boolean;
}

export async function runServe(options: ServeOptions, io: CliIo): Promise<number> {
  const companion = await buildCompanion();
  const home = iwomcHome();

  let store: ControlPlaneStore;
  const postgres = readPostgresConfig();
  if (postgres) {
    try {
      store = await createPostgresStore(postgres);
    } catch (error) {
      io.err(line("danger", "Postgres is configured but unusable", (error as Error).message));
      io.err(bullet("Unset IWOMC_DATABASE_URL to use the local SQLite store."));
      companion.close();
      return EXIT.blocked;
    }
  } else {
    store = new SqliteControlPlaneStore(join(home, "control-plane.sqlite"));
  }

  const service = new ControlPlaneService({ store, signingKey: loadServiceKey(home) });
  const bootstrap = bootstrapWorkspace(service, store, companion);

  const host = options.host ?? "127.0.0.1";
  let advertisedOrigin: string | null = null;
  try {
    advertisedOrigin = options.publicUrl ? normalizePublicOrigin(options.publicUrl) : null;
  } catch (error) {
    io.err(line("danger", "Invalid public URL", (error as Error).message));
    companion.close();
    store.close();
    return EXIT.usage;
  }
  if ((host === "0.0.0.0" || host === "::") && advertisedOrigin === null) {
    io.err(line("attention", "A public URL is required for a shared server", "Use --public-url http://<your-LAN-IP>:<port>."));
    companion.close();
    store.close();
    return EXIT.usage;
  }
  const port = options.port ?? companion.config.consolePort;
  const consoleDir = resolveConsoleDir();

  // The console addresses a project by id; the Companion works in a checkout.
  // Resolving here keeps the local path out of every response.
  const checkoutPathFor = (projectId: string | null): string | null => {
    const bindings = companion.listBindings();
    const binding = projectId
      ? (bindings.find((entry) => entry.projectId === projectId) ?? null)
      : (bindings[0] ?? null);
    return binding?.checkoutPath ?? null;
  };

  const local: LocalContext = {
    deviceId: () => companion.device.id,
    status: async (projectId) => {
      const bindings = companion.listBindings();
      const binding = projectId
        ? bindings.find((entry) => entry.projectId === projectId) ?? null
        : (bindings[0] ?? null);
      if (!binding) {
        return {
          bound: false,
          detail:
            "This device has no checkout registered yet. Run `iwomc init` inside a Git checkout to bind one.",
        };
      }
      try {
        const status = await companion.status(binding.checkoutPath);
        // The console never receives a local filesystem path.
        return { bound: true, ...status, home: undefined };
      } catch (error) {
        return { bound: false, detail: (error as Error).message };
      }
    },
    integrations: async () => ({
      // One shared answer, so the console and `iwomc doctor` cannot disagree.
      reports: await companion.integrationReports(),
      memory: (await companion.memory?.status()) ?? {
        status: "not_configured",
        detail: "Memory integration is not configured.",
        endpoint: null,
      },
      verifiers: await companion.verifierAvailability(),
    }),
    drift: async (projectId) => companion.listDrift(projectId),
    timeline: async (projectId, query) => {
      const checkout = checkoutPathFor(projectId);
      if (checkout === null) return null;
      return await companion.timeline(checkout, query);
    },
    timelineDiff: async (projectId, from, to) => {
      const checkout = checkoutPathFor(projectId);
      if (checkout === null) return null;
      return await companion.timelineDiff(checkout, from, to);
    },
    capabilities: async () =>
      companion.registry.all.map((adapter) => ({
        ...adapter.manifest,
        declaredFiles: [...adapter.manifest.declaredFiles],
      })),
  };

  const server = createControlPlaneServer({
    service,
    store,
    consoleDir,
    local,
    publicOrigin: advertisedOrigin,
    // So `/api/health` names the build that is serving, here as well as hosted.
    version: CLI_VERSION,
  });

  try {
    await listen(server, port, host);
  } catch (error) {
    if (isAddressInUse(error) && options.port === undefined) {
      const occupiedOrigin = `http://${host}:${port}`;
      if (await isIwomcConsole(occupiedOrigin)) {
        const consoleUrl = `${occupiedOrigin}/#token=${bootstrap.sessionToken}`;
        saveConfig({ controlPlaneUrl: occupiedOrigin, workspaceId: bootstrap.workspaceId, consolePort: port });
        io.out(heading("IWOMC Rescue Console"));
        io.out(line("ready", "Already running", occupiedOrigin));
        io.out(`  ${style.bold("Open:")} ${style.signal(consoleUrl)}`);
        io.out("");
        if (options.open) openInBrowser(consoleUrl);
        companion.close();
        store.close();
        return EXIT.ok;
      }

      // Another local app owns the preferred port. A local console does not
      // need a fixed port, so ask the OS for a free one instead of crashing.
      await listen(server, 0, host);
    } else {
      const detail = isAddressInUse(error)
        ? `Port ${port} is already in use. Pick another with \`iwomc serve --port 4320\`.`
        : (error as Error).message;
      io.err(line("danger", "Could not start the Rescue Console", detail));
      companion.close();
      store.close();
      return EXIT.blocked;
    }
  }

  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const boundOrigin = `http://${host}:${actualPort}`;
  const origin = advertisedOrigin ?? boundOrigin;
  const consoleUrl = `${origin}/#token=${bootstrap.sessionToken}`;

  saveConfig({ controlPlaneUrl: origin, workspaceId: bootstrap.workspaceId, consolePort: actualPort });

  io.out(heading("IWOMC Rescue Console"));
  io.out(line("ready", "Listening", boundOrigin));
  if (origin !== boundOrigin) io.out(bullet(`Team URL: ${origin}`));
  io.out(bullet(`Workspace: ${bootstrap.workspaceName} (${bootstrap.workspaceId})`));
  io.out(bullet(`Signed in as: ${bootstrap.personId} (${bootstrap.role})`));
  io.out(bullet(`Store: ${store.kind}`));
  if (consoleDir === null) {
    io.out(
      line(
        "attention",
        "Console assets are not built",
        "run `pnpm --filter @iwomc/console run build`, then restart. The API is running.",
      ),
    );
  }
  io.out("");
  io.out(`  ${style.bold("Open:")} ${style.signal(consoleUrl)}`);
  io.out(style.dim("  The link carries a one-time session token. Treat it like a password."));
  io.out("");
  if (options.open) openInBrowser(consoleUrl);

  const client = new ControlPlaneClient({ baseUrl: origin });
  const credentials = { deviceId: bootstrap.deviceId, token: bootstrap.deviceToken };

  await syncLocalRecords(companion, client, credentials, io);
  const stopRunner = startJobRunner(companion, client, credentials, io);

  await new Promise<void>((resolveShutdown) => {
    const shutdown = () => {
      stopRunner();
      server.close(() => resolveShutdown());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  companion.close();
  store.close();
  return EXIT.ok;
}

function listen(server: ReturnType<typeof createControlPlaneServer>, port: number, host: string): Promise<void> {
  return new Promise<void>((resolveListen, rejectListen) => {
    const fail = (error: Error) => {
      server.removeListener("listening", ready);
      rejectListen(error);
    };
    const ready = () => {
      server.removeListener("error", fail);
      resolveListen();
    };
    server.once("error", fail);
    server.once("listening", ready);
    server.listen(port, host);
  });
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EADDRINUSE";
}

async function isIwomcConsole(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown };
    return body.status === "ok";
  } catch {
    return false;
  }
}

function openInBrowser(url: string): void {
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
        : process.platform === "darwin"
          ? spawn("open", [url], { detached: true, stdio: "ignore" })
          : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // The usable one-time link has already been printed above.
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

interface Bootstrap {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly personId: string;
  readonly role: string;
  readonly sessionToken: string;
  readonly deviceId: string;
  readonly deviceToken: string;
}

/**
 * On a machine with no GitHub App configured, the console is owned by this
 * device's local owner identity. That identity is real and scoped: it can
 * administer this workspace, and it is plainly labelled as local in the UI.
 */
function bootstrapWorkspace(
  service: ControlPlaneService,
  store: ControlPlaneStore,
  companion: Companion,
): Bootstrap {
  const personId = companion.device.personId;
  const existing = store.listWorkspacesForPerson(personId)[0] ?? null;
  const workspace =
    existing ??
    (() => {
      const created = service.createWorkspace({
        name: `${companion.device.displayName} workspace`,
        person: { id: personId, displayName: companion.device.displayName },
      });
      return store.getWorkspace(created.workspaceId)!;
    })();

  const session = service.createSession({ personId, workspaceId: workspace.id });

  let deviceToken = companion.store.getMeta("device_token");
  let deviceId = companion.device.id;
  const enrolled = store.listDevices(workspace.id).find((device) => device.publicKey === companion.device.publicKey);

  if (!enrolled || !deviceToken) {
    const principal = service.authenticateSession(session.token);
    const invitation = service.createInvitation(principal!, workspace.id, "owner");
    const enrollment = service.enrollDevice({
      invitationToken: invitation.token,
      publicKey: companion.device.publicKey,
      displayName: companion.device.displayName,
      platform: currentPlatform(),
      personId,
      personDisplayName: companion.device.displayName,
    });
    deviceId = enrollment.deviceId;
    deviceToken = enrollment.deviceToken;
    companion.store.setMeta("device_token", deviceToken);
  } else {
    deviceId = enrolled.id;
  }

  // Either way, the Companion's own record must reflect the enrollment. Without
  // this a second `serve` leaves the device believing it is still local-only,
  // and `iwomc status` reports the wrong mode.
  attachToWorkspace(companion.store, companion.device, {
    workspaceId: workspace.id,
    personId,
    deviceId,
  });

  const membership = store.getMembership(workspace.id, personId);
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    personId,
    role: membership?.role ?? "owner",
    sessionToken: session.token,
    deviceId,
    deviceToken,
  };
}

function loadServiceKey(home: string): KeyPair {
  const path = join(home, "service.key");
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as KeyPair;
    } catch {
      // Regenerate a corrupt key file rather than failing to start.
    }
  }
  const key = generateDeviceKeyPair();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(key), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows inherits the user profile ACL.
  }
  return key;
}

function resolveConsoleDir(): string | null {
  const override = process.env["IWOMC_CONSOLE_DIR"];
  if (override && existsSync(join(override, "index.html"))) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "console", "dist"),
    join(here, "..", "..", "..", "apps", "console", "dist"),
    join(process.cwd(), "apps", "console", "dist"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Device side: publish what exists, then run signed jobs
// ---------------------------------------------------------------------------

export async function syncLocalRecords(
  companion: Companion,
  client: ControlPlaneClient,
  credentials: { deviceId: string; token: string },
  io: CliIo,
): Promise<void> {
  for (const binding of companion.listBindings()) {
    try {
      const registered = await client.registerProjectBinding({
        credentials,
        projectId: binding.projectId,
        projectName: binding.projectName,
        canonicalRemoteDigest: binding.canonicalRemoteDigest,
        subdirectory: binding.subdirectory,
      });
      const projectId = registered.projectId;
      if (registered.projectId !== binding.projectId || binding.workspaceId === null) {
        // The workspace has accepted this project, so the local binding is
        // adopted into it: same checkout, now workspace-scoped.
        companion.store.deleteBinding(binding.projectId);
        companion.store.saveBinding({
          ...binding,
          projectId,
          workspaceId: companion.device.workspaceId,
        });
      }

      for (const receipt of companion.listReceipts(binding.projectId).slice(0, 20)) {
        await client
          .publishReceipt({ credentials, receipt: { ...receipt, projectId } })
          .catch(() => undefined);
      }
      for (const stored of companion.listContracts(binding.projectId).slice(0, 20)) {
        await client
          .publishContract({ credentials, contract: { ...stored.contract, projectId } })
          .catch((error: unknown) => {
            if (error instanceof BlockedError) return;
          });
      }
      for (const run of companion.listRuns(binding.projectId).slice(0, 20)) {
        if (run.outcome) {
          await client
            .publishRescueOutcome({ credentials, outcome: run.outcome })
            .catch(() => undefined);
        }
      }
    } catch (error) {
      io.err(line("attention", `Could not sync ${binding.projectName}`, (error as Error).message));
    }
  }
}

export function startJobRunner(
  companion: Companion,
  client: ControlPlaneClient,
  credentials: { deviceId: string; token: string },
  io: CliIo,
): () => void {
  let stopped = false;
  const inFlight = new Set<string>();

  /**
   * How often a device asks for work.
   *
   * Fixed three seconds is right when someone is actually waiting: they
   * clicked a button in the console and want to see it start. It is wrong for
   * the other twenty-three hours, where every enrolled device on the team asks
   * a question with the same answer, all day. So the interval opens up while
   * nothing is happening and snaps back the moment something does - a team of
   * ten idles at a request every ten seconds per device instead of three,
   * without anyone waiting noticeably longer.
   */
  const BUSY_MS = 3_000;
  const IDLE_MS = 15_000;
  // Roughly a minute of nothing before backing off.
  const QUIET_POLLS_BEFORE_BACKOFF = 20;

  let quietPolls = 0;
  let currentDelay = BUSY_MS;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (delay: number): void => {
    if (stopped) return;
    currentDelay = delay;
    timer = setTimeout(() => void tick(), delay);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let jobs: RescueRequestV1[] = [];
    try {
      jobs = await client.pollJobs({ credentials });
    } catch {
      // Unreachable control plane. Back off rather than hammering it while it
      // is down, and recover as soon as it answers again.
      quietPolls += 1;
      schedule(quietPolls >= QUIET_POLLS_BEFORE_BACKOFF ? IDLE_MS : currentDelay);
      return;
    }

    for (const job of jobs) {
      if (inFlight.has(job.id)) continue;
      inFlight.add(job.id);
      void executeJob(companion, client, credentials, job, io).finally(() => inFlight.delete(job.id));
    }

    if (jobs.length > 0) {
      // Someone is using this device. Stay responsive.
      quietPolls = 0;
      schedule(BUSY_MS);
      return;
    }
    quietPolls += 1;
    schedule(quietPolls >= QUIET_POLLS_BEFORE_BACKOFF ? IDLE_MS : BUSY_MS);
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function executeJob(
  companion: Companion,
  client: ControlPlaneClient,
  credentials: { deviceId: string; token: string },
  job: RescueRequestV1,
  io: CliIo,
): Promise<void> {
  const report = (state: string, message: string) =>
    client.reportJobProgress({ credentials, jobId: job.id, state, message }).catch(() => undefined);

  if (Date.parse(job.expiresAt) <= Date.now()) {
    await report("expired", "The request expired before this device picked it up.");
    return;
  }

  const binding = companion.store.findBindingById(job.projectId);
  if (!binding) {
    await report(
      "blocked",
      `This device has no checkout registered for project ${job.projectId}. Run \`iwomc init\` in the checkout.`,
    );
    return;
  }

  io.out(style.dim(`  job ${job.action} received for ${binding.projectName}`));
  await report("running", `${job.action} started on ${companion.device.displayName}.`);

  try {
    switch (job.action) {
      case "capture": {
        const result = await companion.capture(binding.checkoutPath);
        await report(
          "finished",
          result.contract
            ? `Captured receipt ${result.receipt.id} and contract ${result.contract.digest.slice(7, 19)}.`
            : `Captured evidence only: ${result.supportReason}`,
        );
        break;
      }
      case "verify": {
        const result = await companion.verify(binding.checkoutPath, {
          ...(job.contractId ? { contractId: job.contractId } : {}),
          onEvent: (event) => void report("running", `${event.phase}: ${event.message}`),
        });
        await report(
          "finished",
          result.attestation
            ? `Verification ${result.attestation.state} via ${result.attestation.verifier} (${result.attestation.assurance}).`
            : (result.blocker?.message ?? "No verifier was available."),
        );
        break;
      }
      case "rescue": {
        const result = await companion.rescue(binding.checkoutPath, {
          approve: true,
          ...(job.contractId ? { contractId: job.contractId } : {}),
          onEvent: (event: RescueEvent) => {
            if (event.kind === "state_changed" || event.kind === "run_finished" || event.kind === "blocked") {
              void report("running", event.message);
            }
          },
        });
        if ("runId" in result && result.runId === null) {
          await report("finished", `blocked: ${result.blocker.message}`);
          break;
        }
        const full = result as { state: string; outcome?: unknown };
        if (full.outcome) {
          await client
            .publishRescueOutcome({ credentials, outcome: full.outcome as never })
            .catch(() => undefined);
        }
        await report("finished", `Rescue finished: ${full.state}.`);
        break;
      }
      case "promote": {
        const result = await companion.promote(binding.checkoutPath, { apply: false });
        await report(
          "finished",
          result.repair
            ? `Proposed a repair touching ${result.repair.files.length} file(s). Review it before applying.`
            : (result.blocker?.message ?? "Nothing to promote."),
        );
        break;
      }
      default:
        await report("finished", `Unknown action ${String(job.action)}.`);
    }
  } catch (error) {
    const message = error instanceof BlockedError ? error.blocker.message : (error as Error).message;
    await report("finished", `blocked: ${message}`);
  }

  await syncLocalRecords(companion, client, credentials, io);
}

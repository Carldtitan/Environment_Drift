import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateDeviceKeyPair, type KeyPair } from "@iwomc/contracts";
import { createControlPlaneServer, ControlPlaneService, normalizePublicOrigin, SqliteControlPlaneStore } from "@iwomc/control-plane";
import { heading, line, style } from "./render.js";
import type { CliIo } from "./cli.js";
import { CLI_VERSION, EXIT } from "./cli.js";

/**
 * Run the public IWOMC control plane. Devices keep their own encrypted local
 * evidence; this service persists only the team workspace, contracts, jobs,
 * audit log, and opaque browser-session hashes.
 *
 * A single service with a mounted volume is deliberate: it is the smallest
 * shape that is genuinely multi-device rather than a localhost demo, and it can
 * be moved behind Postgres without the callers changing.
 */
export async function runHostedControlPlane(io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const clientId = nonEmpty(env["GITHUB_CLIENT_ID"]);
  const clientSecret = nonEmpty(env["GITHUB_CLIENT_SECRET"]);
  const publicUrl = nonEmpty(env["IWOMC_PUBLIC_URL"]);
  if (!clientId || !clientSecret || !publicUrl) {
    io.err(
      line(
        "danger",
        "Hosted control plane is not configured",
        "Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and IWOMC_PUBLIC_URL before starting it.",
      ),
    );
    return EXIT.blocked;
  }

  let origin: string;
  try {
    origin = normalizePublicOrigin(publicUrl);
  } catch (error) {
    io.err(line("danger", "Invalid IWOMC_PUBLIC_URL", (error as Error).message));
    return EXIT.usage;
  }

  const home = env["IWOMC_HOME"] ?? env["RAILWAY_VOLUME_MOUNT_PATH"] ?? join(process.cwd(), ".iwomc-hosted");
  const store = new SqliteControlPlaneStore(join(home, "control-plane.sqlite"));
  const signingKey = loadHostedServiceKey(home);
  const service = new ControlPlaneService({ store, signingKey });
  const consoleDir = resolveConsoleDir();
  const port = numberFrom(env["PORT"]) ?? 3000;

  const server = createControlPlaneServer({
    service,
    store,
    consoleDir,
    publicOrigin: origin,
    // The health endpoint is the only way to tell from outside which build is
    // actually serving. Reporting a constant made "is the hosted console up to
    // date?" a question nobody could answer without redeploying to find out.
    version: CLI_VERSION,
    githubOAuth: {
      clientId,
      clientSecret,
      callbackUrl: `${origin}/auth/github/callback`,
      signingKey,
    },
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });

  io.out(heading("IWOMC Rescue hosted control plane"));
  io.out(line("ready", "Listening", `0.0.0.0:${port}`));
  io.out(`  ${style.bold("Open:")} ${style.signal(origin)}`);
  io.out(`  ${style.dim("Store:")} ${store.kind} at ${home}`);

  await new Promise<void>((resolveShutdown) => {
    const shutdown = () => server.close(() => resolveShutdown());
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  store.close();
  return EXIT.ok;
}

function loadHostedServiceKey(home: string): KeyPair {
  const path = join(home, "service.key");
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as KeyPair;
    } catch {
      // A corrupt key would invalidate every historical signature. Refuse to
      // overwrite it automatically in the hosted service.
      throw new Error(`Hosted service key at ${path} is corrupt. Restore it from the persistent volume backup.`);
    }
  }
  const key = generateDeviceKeyPair();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(key), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Railway volume permissions are controlled by the container runtime.
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
  return candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberFrom(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

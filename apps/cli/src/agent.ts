import { ControlPlaneClient } from "@iwomc/integrations";
import type { Companion } from "@iwomc/companion";
import { startJobRunner, syncLocalRecords } from "./serve.js";
import { bullet, heading, line, style } from "./render.js";
import type { CliIo } from "./cli.js";
import { EXIT } from "./cli.js";

/**
 * Runs on a teammate's machine after `iwomc join`.
 *
 * The browser never reaches this process. It polls the shared control plane
 * outbound with its revocable device credential, registers the checkout it
 * already owns, and executes only signed, project-scoped jobs.
 */
export async function runAgent(
  companion: Companion,
  ctx: { controlPlaneUrl?: string; io: CliIo },
): Promise<number> {
  const baseUrl = ctx.controlPlaneUrl ?? companion.config.controlPlaneUrl;
  const token = companion.store.getMeta("device_token");
  const workspaceId = companion.device.workspaceId;

  if (!baseUrl || !token || !workspaceId) {
    ctx.io.err(
      line(
        "attention",
        "This device is not enrolled in a shared workspace",
        "Run the invitation command first: iwomc join <token> --url <control-plane>.",
      ),
    );
    return EXIT.blocked;
  }

  const client = new ControlPlaneClient({ baseUrl });
  const credentials = { deviceId: companion.device.id, token };
  try {
    await client.pollJobs({ credentials });
  } catch (error) {
    ctx.io.err(line("danger", "Could not reach the team control plane", (error as Error).message));
    return EXIT.blocked;
  }

  await syncLocalRecords(companion, client, credentials, ctx.io);
  const stop = startJobRunner(companion, client, credentials, ctx.io);
  ctx.io.out(heading("IWOMC device agent"));
  ctx.io.out(line("ready", "Connected", baseUrl));
  ctx.io.out(bullet(`Workspace: ${workspaceId}`));
  ctx.io.out(style.dim("  Waiting for signed capture, verify, rescue, or promotion jobs. Press Ctrl+C to stop."));

  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  stop();
  return EXIT.ok;
}

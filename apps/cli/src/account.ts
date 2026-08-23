import { BlockedError } from "@iwomc/contracts";
import { attachToWorkspace, currentPlatform, saveConfig, type Companion } from "@iwomc/companion";
import { ControlPlaneClient, GitHubAppSourceAccess, gitHubConfigProblems, readGitHubConfig } from "@iwomc/integrations";
import { bullet, heading, line, style, wrapText } from "./render.js";
import type { CliIo } from "./cli.js";
import { EXIT } from "./cli.js";

/**
 * `login` and `join`.
 *
 * Both are honest about what is configured. Without a GitHub App, sign-in
 * reports exactly which configuration value is missing and IWOMC stays in
 * local-only mode; it never invents an identity.
 */

export async function runLogin(_companion: Companion, ctx: { json: boolean; io: CliIo }): Promise<number> {
  const config = readGitHubConfig();
  const problems = gitHubConfigProblems(config);
  const github = new GitHubAppSourceAccess({ config });

  if (problems.length > 0) {
    const payload = {
      ok: false,
      status: "not_configured",
      problems,
      mode: "local_only",
      detail:
        "IWOMC keeps working in local-only mode: you can bind projects, capture, verify locally, and rescue on this machine. Signing in adds workspaces, shared contracts, and device enrollment.",
    };
    if (ctx.json) {
      ctx.io.out(JSON.stringify(payload, null, 2));
      return EXIT.blocked;
    }
    ctx.io.out(heading("GitHub sign-in is not configured"));
    for (const problem of problems) ctx.io.out(bullet(problem));
    ctx.io.out("");
    ctx.io.out(wrapText(payload.detail));
    ctx.io.out("");
    ctx.io.out(`  ${style.bold("Next:")} create a GitHub App, then set IWOMC_GITHUB_APP_CLIENT_ID, IWOMC_GITHUB_APP_ID, and IWOMC_GITHUB_APP_PRIVATE_KEY.`);
    return EXIT.blocked;
  }

  try {
    const start = await github.beginDeviceLogin();
    if (ctx.json) {
      ctx.io.out(JSON.stringify({ ok: true, ...start }, null, 2));
      return EXIT.ok;
    }
    ctx.io.out(heading("Sign in with GitHub"));
    ctx.io.out(`  1. Open ${style.signal(start.verificationUri)}`);
    ctx.io.out(`  2. Enter the code ${style.bold(start.userCode)}`);
    ctx.io.out(`  3. Run ${style.bold("iwomc login")} again once you have approved it.`);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof BlockedError) {
      if (ctx.json) ctx.io.out(JSON.stringify({ ok: false, blocker: error.blocker }, null, 2));
      else {
        ctx.io.err(line("attention", error.blocker.message));
        ctx.io.err(`  ${style.bold("Next:")} ${error.blocker.nextAction}`);
      }
      return EXIT.blocked;
    }
    throw error;
  }
}

export async function runJoin(
  companion: Companion,
  ctx: { json: boolean; io: CliIo; invitation?: string; controlPlaneUrl?: string },
): Promise<number> {
  const invitation = ctx.invitation;
  if (!invitation) {
    ctx.io.err("Usage: iwomc join <invitation-token> [--url <control-plane>]");
    return EXIT.usage;
  }

  const baseUrl = ctx.controlPlaneUrl ?? companion.config.controlPlaneUrl;
  if (!baseUrl) {
    const detail =
      "No control plane is configured. Start one with `iwomc serve`, or pass --url https://<your-control-plane>.";
    if (ctx.json) ctx.io.out(JSON.stringify({ ok: false, status: "not_configured", detail }, null, 2));
    else {
      ctx.io.err(line("attention", "No control plane configured", detail));
    }
    return EXIT.blocked;
  }

  const client = new ControlPlaneClient({ baseUrl });
  try {
    const enrollment = await client.enrollDevice({
      invitationToken: invitation,
      publicKey: companion.device.publicKey,
      displayName: companion.device.displayName,
      platform: currentPlatform(),
    });
    attachToWorkspace(companion.store, companion.device, {
      workspaceId: enrollment.workspaceId,
      personId: enrollment.personId,
      deviceId: enrollment.deviceId,
    });
    companion.store.setMeta("device_token", enrollment.deviceToken);
    saveConfig({ controlPlaneUrl: baseUrl, workspaceId: enrollment.workspaceId });

    const payload = {
      ok: true,
      workspaceId: enrollment.workspaceId,
      deviceId: enrollment.deviceId,
      role: enrollment.role,
      controlPlaneUrl: baseUrl,
    };
    if (ctx.json) ctx.io.out(JSON.stringify(payload, null, 2));
    else {
      ctx.io.out(heading("Device enrolled"));
      ctx.io.out(line("ready", `Joined workspace ${enrollment.workspaceId}`, `role ${enrollment.role}`));
      ctx.io.out(bullet(`Control plane: ${baseUrl}`));
      ctx.io.out(bullet("Your private signing key stayed on this machine."));
    }
    return EXIT.ok;
  } catch (error) {
    if (error instanceof BlockedError) {
      if (ctx.json) ctx.io.out(JSON.stringify({ ok: false, blocker: error.blocker }, null, 2));
      else {
        ctx.io.err(line("attention", error.blocker.message));
        ctx.io.err(`  ${style.bold("Next:")} ${error.blocker.nextAction}`);
      }
      return EXIT.blocked;
    }
    throw error;
  }
}

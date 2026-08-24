/**
 * Making the recorder come back after a reboot.
 *
 * Each operating system has exactly one sanctioned way to run something when a
 * person logs in, and IWOMC uses that way rather than inventing its own:
 * a per-user Scheduled Task on Windows, a LaunchAgent on macOS, a systemd user
 * service on Linux. All three are per-user, need no administrator, and are
 * removable by the same command that created them.
 *
 * Nothing here runs by itself. Installing an autostart entry writes to the
 * user's account configuration, which is a bigger step than starting a process
 * for this session, so it is asked for explicitly - `iwomc daemon enable` -
 * and `iwomc daemon disable` takes it away again.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The label all three systems use to find IWOMC's entry. */
export const AUTOSTART_LABEL = "dev.iwomc.recorder";
const WINDOWS_TASK_NAME = "IWOMC Recorder";
const WINDOWS_STARTUP_FILE = "IWOMC Recorder.cmd";

/** PowerShell string literals escape a quote by doubling it. */
function psQuote(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function powerShell(script: string): { ok: boolean; output: string } {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function windowsStartupPath(home: string): string {
  return join(
    home,
    "AppData",
    "Roaming",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    WINDOWS_STARTUP_FILE,
  );
}

export type AutostartPlatform = "windows" | "macos" | "linux" | "unsupported";

export function autostartPlatform(platform: NodeJS.Platform = process.platform): AutostartPlatform {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "unsupported";
}

export interface AutostartResult {
  readonly ok: boolean;
  readonly detail: string;
  /** What was written or run, so a person can undo it by hand if they prefer. */
  readonly evidence?: string;
}

export interface AutostartInput {
  /** Absolute path of the IWOMC entry point to run. */
  readonly entry: string;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  /** IWOMC_HOME to hand the recorder, when it is not the default. */
  readonly iwomcHome?: string | null;
}

function launchAgentPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
}

function systemdUnitPath(home: string): string {
  return join(home, ".config", "systemd", "user", "iwomc-recorder.service");
}

/** XML text nodes must not carry raw markup, and a path can contain anything. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

export function autostartStatus(input: AutostartInput = { entry: "" }): {
  installed: boolean;
  platform: AutostartPlatform;
  detail: string;
} {
  const home = input.home ?? homedir();
  const platform = autostartPlatform(input.platform);

  if (platform === "macos") {
    const path = launchAgentPath(home);
    return {
      installed: existsSync(path),
      platform,
      detail: existsSync(path) ? `A LaunchAgent is installed at ${path}.` : "No LaunchAgent is installed.",
    };
  }
  if (platform === "linux") {
    const path = systemdUnitPath(home);
    return {
      installed: existsSync(path),
      platform,
      detail: existsSync(path)
        ? `A systemd user service is installed at ${path}.`
        : "No systemd user service is installed.",
    };
  }
  if (platform === "windows") {
    const query = spawnSync("schtasks", ["/query", "/tn", WINDOWS_TASK_NAME], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (query.status === 0) {
      return { installed: true, platform, detail: `A logon task named "${WINDOWS_TASK_NAME}" is registered.` };
    }
    const startup = windowsStartupPath(home);
    if (existsSync(startup)) {
      return { installed: true, platform, detail: `A startup entry is installed at ${startup}.` };
    }
    return { installed: false, platform, detail: "No logon task or startup entry is registered." };
  }
  return {
    installed: false,
    platform,
    detail: `IWOMC has no autostart mechanism for ${process.platform}. Start the recorder from your shell profile instead.`,
  };
}

export function installAutostart(input: AutostartInput): AutostartResult {
  const home = input.home ?? homedir();
  const platform = autostartPlatform(input.platform);
  const args = [input.entry, "watch", "--all", "--daemon"];

  if (platform === "macos") {
    const path = launchAgentPath(home);
    // `RunAtLoad` starts it at login; `KeepAlive` false means a deliberate
    // stop stays stopped rather than being resurrected a second later.
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "  <key>Label</key>",
      `  <string>${AUTOSTART_LABEL}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...[process.execPath, ...args].map((part) => `    <string>${xmlEscape(part)}</string>`),
      "  </array>",
      "  <key>RunAtLoad</key>",
      "  <true/>",
      "  <key>KeepAlive</key>",
      "  <false/>",
      ...(input.iwomcHome
        ? [
            "  <key>EnvironmentVariables</key>",
            "  <dict>",
            "    <key>IWOMC_HOME</key>",
            `    <string>${xmlEscape(input.iwomcHome)}</string>`,
            "  </dict>",
          ]
        : []),
      "</dict>",
      "</plist>",
      "",
    ].join("\n");

    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, plist, "utf8");
    } catch (error) {
      return { ok: false, detail: `Could not write ${path}: ${(error as Error).message}` };
    }
    // `bootstrap` is the modern verb; `load` is kept for older systems. A
    // failure here is not fatal - the agent still starts at the next login.
    spawnSync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? ""}`, path], { encoding: "utf8" });
    spawnSync("launchctl", ["load", "-w", path], { encoding: "utf8" });
    return { ok: true, detail: "The recorder will start when you log in.", evidence: path };
  }

  if (platform === "linux") {
    const path = systemdUnitPath(home);
    const unit = [
      "[Unit]",
      "Description=IWOMC package recorder",
      "After=default.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${[process.execPath, ...args].join(" ")}`,
      ...(input.iwomcHome ? [`Environment=IWOMC_HOME=${input.iwomcHome}`] : []),
      "Restart=on-failure",
      "RestartSec=30",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");

    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, unit, "utf8");
    } catch (error) {
      return { ok: false, detail: `Could not write ${path}: ${(error as Error).message}` };
    }
    const reload = spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
    const enable = spawnSync("systemctl", ["--user", "enable", "--now", "iwomc-recorder.service"], {
      encoding: "utf8",
    });
    if (enable.status !== 0) {
      // Common on a machine with no user session bus - a container, or SSH
      // without lingering enabled. The unit is written and will work once a
      // session exists, and saying so beats claiming success.
      return {
        ok: false,
        detail: `The service file was written to ${path}, but systemd would not enable it: ${
          (enable.stderr || reload.stderr || "").trim() || "no reason given"
        }. It will start once a user session is available.`,
        evidence: path,
      };
    }
    return { ok: true, detail: "The recorder will start when you log in.", evidence: path };
  }

  if (platform === "windows") {
    // A scheduled task is the tidier of the two: it starts without a console
    // window and is visible in Task Scheduler. `schtasks /create` is not used
    // for it, because that refuses without elevation on an ordinary account -
    // the PowerShell cmdlet registers the same task for the current user
    // without asking for administrator rights.
    const script = [
      `$action = New-ScheduledTaskAction -Execute ${psQuote(process.execPath)} -Argument ${psQuote(
        args.map((part) => `"${part}"`).join(" "),
      )}`,
      "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
      "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)",
      `Register-ScheduledTask -TaskName ${psQuote(
        WINDOWS_TASK_NAME,
      )} -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null`,
    ].join("; ");

    const registered = powerShell(script);
    if (registered.ok) {
      return {
        ok: true,
        detail: "The recorder will start when you log in.",
        evidence: `Scheduled Task "${WINDOWS_TASK_NAME}"`,
      };
    }

    // Locked-down machines refuse the Task Scheduler. The per-user Startup
    // folder is a plain file in the account's own profile and cannot be
    // refused the same way, at the cost of a console window at login.
    const startup = windowsStartupPath(home);
    const launcher = [
      "@echo off",
      "rem Started by `iwomc daemon enable`. Delete this file, or run",
      "rem `iwomc daemon disable`, to stop the recorder starting at login.",
      ...(input.iwomcHome ? [`set "IWOMC_HOME=${input.iwomcHome}"`] : []),
      `start "" /b "${process.execPath}" ${args.map((part) => `"${part}"`).join(" ")}`,
      "",
    ].join("\r\n");

    try {
      mkdirSync(dirname(startup), { recursive: true });
      writeFileSync(startup, launcher, "utf8");
    } catch (error) {
      return {
        ok: false,
        detail: `Windows refused the scheduled task (${registered.output || "access denied"}) and the startup folder could not be written: ${(error as Error).message}`,
      };
    }
    return {
      ok: true,
      detail: "The recorder will start when you log in, from the Startup folder.",
      evidence: startup,
    };
  }

  return {
    ok: false,
    detail: `IWOMC has no autostart mechanism for ${process.platform}. Start \`iwomc watch --all\` from your shell profile instead.`,
  };
}

export function removeAutostart(input: AutostartInput = { entry: "" }): AutostartResult {
  const home = input.home ?? homedir();
  const platform = autostartPlatform(input.platform);

  if (platform === "macos") {
    const path = launchAgentPath(home);
    spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}/${AUTOSTART_LABEL}`], {
      encoding: "utf8",
    });
    spawnSync("launchctl", ["unload", path], { encoding: "utf8" });
    try {
      rmSync(path, { force: true });
    } catch (error) {
      return { ok: false, detail: `Could not remove ${path}: ${(error as Error).message}` };
    }
    return { ok: true, detail: "The recorder will no longer start at login.", evidence: path };
  }

  if (platform === "linux") {
    const path = systemdUnitPath(home);
    spawnSync("systemctl", ["--user", "disable", "--now", "iwomc-recorder.service"], { encoding: "utf8" });
    try {
      rmSync(path, { force: true });
    } catch (error) {
      return { ok: false, detail: `Could not remove ${path}: ${(error as Error).message}` };
    }
    spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
    return { ok: true, detail: "The recorder will no longer start at login.", evidence: path };
  }

  if (platform === "windows") {
    // Either mechanism may be in place, so both are cleared.
    const task = spawnSync("schtasks", ["/delete", "/f", "/tn", WINDOWS_TASK_NAME], {
      encoding: "utf8",
      windowsHide: true,
    });
    const startup = windowsStartupPath(home);
    let removedStartup = false;
    try {
      if (existsSync(startup)) {
        rmSync(startup, { force: true });
        removedStartup = true;
      }
    } catch (error) {
      return { ok: false, detail: `Could not remove ${startup}: ${(error as Error).message}` };
    }
    if (task.status !== 0 && !removedStartup) {
      return { ok: true, detail: "The recorder was not set to start at login." };
    }
    return { ok: true, detail: "The recorder will no longer start at login." };
  }

  return { ok: false, detail: `IWOMC has no autostart mechanism for ${process.platform}.` };
}

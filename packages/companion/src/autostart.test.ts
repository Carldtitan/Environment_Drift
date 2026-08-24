import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOSTART_LABEL, autostartPlatform, installAutostart, removeAutostart } from "./autostart.js";

/**
 * The file each operating system expects, checked on any of them.
 *
 * Actually loading a LaunchAgent or a systemd unit needs that operating system
 * and a logged-in session, so those paths are exercised by CI on real macOS
 * and Linux runners. What is checked here is the part that is wrong far more
 * often: whether the file IWOMC writes is the file the system would accept,
 * with the right paths inside it.
 */

describe("starting the recorder again after a reboot", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "autostart-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it("knows which mechanism belongs to which system", () => {
    expect(autostartPlatform("win32")).toBe("windows");
    expect(autostartPlatform("darwin")).toBe("macos");
    expect(autostartPlatform("linux")).toBe("linux");
    // A platform with no per-user autostart convention IWOMC understands.
    expect(autostartPlatform("aix")).toBe("unsupported");
  });

  it("writes a LaunchAgent macOS would accept", async () => {
    const result = installAutostart({
      entry: "/opt/iwomc/bin.js",
      home,
      platform: "darwin",
      iwomcHome: "/Users/someone/.iwomc",
    });
    const path = join(home, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
    expect(existsSync(path)).toBe(true);
    expect(result.evidence).toBe(path);

    const plist = await readFile(path, "utf8");
    expect(plist).toContain("<!DOCTYPE plist");
    expect(plist).toContain(`<string>${AUTOSTART_LABEL}</string>`);
    expect(plist).toContain("<key>RunAtLoad</key>");
    // Deliberately not KeepAlive: a recorder someone stopped on purpose must
    // stay stopped rather than being restarted a second later.
    expect(plist).toContain("<key>KeepAlive</key>\n  <false/>");
    expect(plist).toContain("<string>/opt/iwomc/bin.js</string>");
    expect(plist).toContain("<string>--daemon</string>");
    expect(plist).toContain("<string>/Users/someone/.iwomc</string>");
  });

  it("writes a systemd user service Linux would accept", async () => {
    installAutostart({ entry: "/opt/iwomc/bin.js", home, platform: "linux" });
    const path = join(home, ".config", "systemd", "user", "iwomc-recorder.service");
    expect(existsSync(path)).toBe(true);

    const unit = await readFile(path, "utf8");
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    // Without this the unit is written but never started at login.
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("/opt/iwomc/bin.js watch --all --daemon");
  });

  it("removes what it installed", async () => {
    for (const platform of ["darwin", "linux"] as NodeJS.Platform[]) {
      installAutostart({ entry: "/opt/iwomc/bin.js", home, platform });
      const removed = removeAutostart({ entry: "/opt/iwomc/bin.js", home, platform });
      expect(removed.ok, `${platform} removal`).toBe(true);
    }
    expect(existsSync(join(home, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`))).toBe(false);
    expect(existsSync(join(home, ".config", "systemd", "user", "iwomc-recorder.service"))).toBe(false);
  });

  it("escapes a path that would otherwise break the plist", async () => {
    // A person's home directory can contain an ampersand, and an unescaped one
    // makes the whole file unparseable - so the agent silently never runs.
    installAutostart({ entry: "/opt/a & b/bin.js", home, platform: "darwin" });
    const plist = await readFile(join(home, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`), "utf8");
    expect(plist).toContain("/opt/a &amp; b/bin.js");
    expect(plist).not.toContain("/opt/a & b/bin.js");
  });

  it("says plainly when a platform has no mechanism it understands", () => {
    const result = installAutostart({ entry: "/opt/iwomc/bin.js", home, platform: "aix" });
    expect(result.ok).toBe(false);
    // Not a silent failure: it names the alternative.
    expect(result.detail).toContain("shell profile");
  });
});

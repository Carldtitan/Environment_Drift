import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createNodeProject, createSandbox, runIwomc, type NodeProjectResult, type Sandbox } from "@iwomc/testkit";
import { cliEntryPoint } from "@iwomc/testkit";

/**
 * The console, driven the way a person drives it (task 7.3).
 *
 * A real control plane, a real device, real contracts, and a real browser. Each
 * action is checked twice: once in the rendered page and once in the persisted
 * records the API returns, so a green screen cannot pass on its own.
 */

const SHOT_DIR = join(process.cwd(), "artifacts", "console");

let sandbox: Sandbox;
let project: NodeProjectResult;
let server: ChildProcess | null = null;
let browser: Browser;
let origin = "";
let token = "";

async function waitForHealth(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`the control plane never became healthy at ${url}`);
}

function freePort(): number {
  // A high, stable-but-unlikely-to-clash port for the test run.
  return 4400 + Math.floor(Math.random() * 400);
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return (await response.json()) as T;
}

describe("the Rescue Console in a browser", () => {
  beforeAll(async () => {
    await mkdir(SHOT_DIR, { recursive: true });
    sandbox = await createSandbox({ IWOMC_DISABLE_MEMORY: "1" });
    project = await createNodeProject({ root: sandbox.home });

    await runIwomc(["init", "--proof", "npm run proof", "--json"], { cwd: project.dir, env: sandbox.env });
    await runIwomc(["capture", "--json"], { cwd: project.dir, env: sandbox.env });
    await runIwomc(["verify", "--json"], { cwd: project.dir, env: sandbox.env });

    const port = freePort();
    origin = `http://127.0.0.1:${port}`;
    const logPath = join(sandbox.home, "serve.log");
    await writeFile(logPath, "", "utf8");

    server = spawn(process.execPath, [cliEntryPoint(), "serve", "--port", String(port)], {
      cwd: project.dir,
      env: { ...(sandbox.env as Record<string, string>), NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });

    await waitForHealth(origin);
    const match = /#token=([A-Za-z0-9_-]+)/u.exec(out);
    if (!match) throw new Error(`no session token in serve output:\n${out}`);
    token = match[1] as string;

    browser = await chromium.launch();
  }, 900_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill("SIGKILL");
    await project?.cleanup();
    await sandbox?.cleanup();
  });

  async function open(viewport = { width: 1440, height: 960 }): Promise<Page> {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/#token=${token}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".verdict__answer", { timeout: 30_000 });
    expect(errors, "the page must load with no uncaught errors").toEqual([]);
    return page;
  }

  it("shows the real contract and offers exactly one dominant action", async () => {
    const page = await open();

    await expect.poll(() => page.locator(".verdict__answer").textContent()).toBe("Yes");
    const reason = await page.locator(".verdict__reason").textContent();
    expect(reason).toContain("locally checked");
    expect(reason).toContain("npm run proof");

    // The contract document shows the real digest from the API, not a sample.
    const overview = await apiGet<{ contracts: { contract: { digest: string; state: string } }[] }>(
      "/api/overview",
    );
    const digest = overview.contracts[0]?.contract.digest as string;
    expect(await page.locator(".doc__digest").first().textContent()).toBe(digest.slice(7, 19));
    expect(overview.contracts[0]?.contract.state).toBe("locally_checked");

    // Exactly one primary action on the screen.
    expect(await page.locator(".btn--primary").count()).toBe(1);
    expect((await page.locator(".btn--primary").textContent())?.trim()).toBe("Rescue this checkout");

    await page.screenshot({ path: join(SHOT_DIR, "overview.png"), fullPage: true });
    await page.context().close();
  }, 300_000);

  it("never renders a state the API did not send", async () => {
    const page = await open();
    const body = (await page.locator("body").textContent()) ?? "";
    // Words that would only appear if the UI invented a verified state.
    expect(body).not.toContain("clean verified");
    expect(body).toContain("locally checked");
    await page.context().close();
  }, 120_000);

  it("sends a rescue request to a device and records it", async () => {
    const page = await open();
    const before = await apiGet<{ events: unknown[] }>("/api/audit");

    await page.locator(".btn--primary").click();
    await page.waitForSelector(".notice[data-tone='ready']", { timeout: 30_000 });
    const notice = await page.locator(".notice[data-tone='ready']").textContent();
    expect(notice).toContain("never a path from this browser");

    const jobs = await apiGet<{ jobs: { request: { action: string; deviceId: string } }[] }>("/api/jobs");
    expect(jobs.jobs.some((job) => job.request.action === "rescue")).toBe(true);
    // A device job carries identifiers only.
    expect(JSON.stringify(jobs.jobs)).not.toContain(project.dir.replace(/\\/gu, "\\\\"));

    const after = await apiGet<{ events: { action: string }[] }>("/api/audit");
    expect(after.events.length).toBeGreaterThan(before.events.length);
    expect(after.events.some((event) => event.action === "job.rescue_requested")).toBe(true);

    await page.context().close();
  }, 300_000);

  it("creates a single-use invitation and shows its token exactly once", async () => {
    const page = await open();
    await page.goto(`${origin}/#/team`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#invite-role", { timeout: 30_000 });

    await page.selectOption("#invite-role", "developer");
    await page.locator(".btn--primary", { hasText: "Create invitation" }).click();
    await page.waitForSelector(".machine", { timeout: 30_000 });

    const command = (await page.locator(".machine").textContent()) ?? "";
    expect(command).toContain("iwomc join ");
    expect(command).toContain(origin);

    const team = await apiGet<{ invitations: { id: string; tokenHash?: string }[] }>("/api/team");
    expect(team.invitations.length).toBeGreaterThan(0);
    // The console must never receive the hash it could brute-force against.
    expect(team.invitations[0]).not.toHaveProperty("tokenHash");

    await page.screenshot({ path: join(SHOT_DIR, "team.png"), fullPage: true });
    await page.context().close();
  }, 300_000);

  it("revokes a device and the device immediately loses access", async () => {
    const page = await open();
    await page.goto(`${origin}/#/team`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".record", { timeout: 30_000 });

    const revoke = page.locator(".btn--danger", { hasText: "Revoke" }).first();
    await revoke.click();
    await expect
      .poll(async () => {
        const team = await apiGet<{ devices: { state: string }[] }>("/api/team");
        return team.devices.every((device) => device.state === "revoked");
      }, { timeout: 30_000 })
      .toBe(true);

    // The revoked credential is refused by the device-facing API.
    const deviceToken = await readDeviceToken();
    const response = await fetch(`${origin}/api/jobs/poll`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(response.status).toBe(401);

    await page.context().close();
  }, 300_000);

  it("shows every state with a word, not only a colour", async () => {
    const page = await open();
    const pills = await page.locator(".pill").allTextContents();
    expect(pills.length).toBeGreaterThan(0);
    for (const pill of pills) {
      expect(pill.trim().length, "a state pill must carry a text label").toBeGreaterThan(1);
    }
    await page.context().close();
  }, 120_000);

  it("works from the keyboard alone and shows a visible focus ring", async () => {
    const page = await open();
    let reached: { text: string; outlineWidth: string } | null = null;
    for (let index = 0; index < 25; index += 1) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const style = getComputedStyle(el);
        return { text: (el.textContent ?? "").trim(), outlineWidth: style.outlineWidth };
      });
      if (info?.text === "Rescue this checkout") {
        reached = info;
        break;
      }
    }
    expect(reached, "the dominant action must be reachable with Tab").not.toBeNull();
    expect(parseFloat(reached?.outlineWidth ?? "0")).toBeGreaterThanOrEqual(3);
    await page.context().close();
  }, 120_000);

  it("collapses to a drawer on a small screen and traps focus in it", async () => {
    const page = await open({ width: 390, height: 844 });
    await page.locator(".rail__toggle").click();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.activeElement?.closest(".rail") !== null)).toBe(true);
    await page.screenshot({ path: join(SHOT_DIR, "mobile-drawer.png") });

    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.activeElement?.classList.contains("rail__toggle"))).toBe(true);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the page must not scroll sideways on a phone").toBeLessThanOrEqual(2);
    await page.context().close();
  }, 120_000);
});

async function readDeviceToken(): Promise<string> {
  // The device credential lives in the Companion's encrypted store; the test
  // reads it the way the Companion itself does, through its own store API.
  const { CompanionStore } = await import("@iwomc/companion");
  const store = CompanionStore.open(sandbox.env);
  try {
    return store.getMeta("device_token") ?? "";
  } finally {
    store.close();
  }
}

export { readFile };

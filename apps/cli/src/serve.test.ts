import { describe, expect, it } from "vitest";
import { normalizePublicOrigin } from "@iwomc/control-plane";

describe("shared control-plane origin", () => {
  it("keeps only a safe HTTP(S) origin for teammate invitations", () => {
    expect(normalizePublicOrigin("https://iwomc.example.com/")).toBe("https://iwomc.example.com");
    expect(normalizePublicOrigin("http://192.168.1.42:4319")).toBe("http://192.168.1.42:4319");
  });

  it("rejects paths and non-web schemes", () => {
    expect(() => normalizePublicOrigin("https://iwomc.example.com/path")).toThrow();
    expect(() => normalizePublicOrigin("ssh://iwomc.example.com")).toThrow();
  });
});

describe("knowing which build is serving", () => {
  it("reports the release version from /api/health, not a constant", async () => {
    // This endpoint is the only way to tell from outside whether a dashboard is
    // running the current build. It answered "0.1.0" whatever was deployed,
    // which made "is it up to date?" unanswerable without redeploying to see.
    const { createControlPlaneServer, ControlPlaneService, SqliteControlPlaneStore } = await import(
      "@iwomc/control-plane"
    );
    const { generateDeviceKeyPair } = await import("@iwomc/contracts");
    const { CLI_VERSION } = await import("./cli.js");

    const store = new SqliteControlPlaneStore(":memory:");
    const server = createControlPlaneServer({
      service: new ControlPlaneService({ store, signingKey: generateDeviceKeyPair() }),
      store,
      local: true,
      version: CLI_VERSION,
    });

    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    try {
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
      const health = (await response.json()) as { version: string };
      expect(health.version).toBe(CLI_VERSION);
      // And the version is a real release, not the placeholder it used to be.
      expect(health.version).not.toBe("0.1.0");
      expect(health.version).toMatch(/^\d+\.\d+\.\d+$/u);
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });
});

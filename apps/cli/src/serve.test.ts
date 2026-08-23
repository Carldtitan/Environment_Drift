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

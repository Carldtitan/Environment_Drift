import { describe, expect, it } from "vitest";
import { preferredDevice } from "./primitives.tsx";

/**
 * Choosing a device is invisible on a team of one and consequential on a team
 * of ten, where "the first active device" means someone else's laptop.
 */

const device = (id: string, state: string, lastSeenAt?: string) => ({ id, state, lastSeenAt });

describe("choosing which device runs requested work", () => {
  it("prefers the machine this console belongs to", () => {
    const chosen = preferredDevice(
      [
        device("someone-elses", "active", "2026-08-24T09:00:00.000Z"),
        device("this-machine", "active", "2026-08-24T08:00:00.000Z"),
      ],
      "this-machine",
    );
    // Even though the other was seen more recently: you are sitting at this one.
    expect(chosen?.id).toBe("this-machine");
  });

  it("falls back to the device seen most recently", () => {
    const chosen = preferredDevice([
      device("dormant-laptop", "active", "2026-02-01T00:00:00.000Z"),
      device("still-in-use", "active", "2026-08-24T09:00:00.000Z"),
    ]);
    // A job sent to a machine nobody has switched on since February sits
    // queued until it expires, and nobody finds out why.
    expect(chosen?.id).toBe("still-in-use");
  });

  it("never chooses a device that is not active", () => {
    expect(preferredDevice([device("revoked", "revoked"), device("unpaired", "unpaired")])).toBeNull();
    expect(preferredDevice([device("gone", "revoked")], "gone")).toBeNull();
  });

  it("has no answer when the workspace has no devices", () => {
    expect(preferredDevice([])).toBeNull();
  });

  it("copes with a device that has never reported in", () => {
    const chosen = preferredDevice([
      device("never-seen", "active"),
      device("seen", "active", "2026-08-24T09:00:00.000Z"),
    ]);
    expect(chosen?.id).toBe("seen");
  });
});

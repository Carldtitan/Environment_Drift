import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { generateDeviceKeyPair, keyIdOf, type KeyPair } from "@iwomc/contracts";
import type { DeviceState, PlatformTarget, TargetArch, TargetOs } from "@iwomc/contracts";
import type { CompanionStore } from "./store.js";

/**
 * Device identity (R1.5, design 3.1).
 *
 * The private key is generated here and sealed into the local store. It is
 * never uploaded, never printed, and never placed in a contract.
 *
 * Before a person signs in, the device uses a `local:` owner identity. That
 * identity can create local receipts, local contracts, and run a local rescue,
 * but it cannot join a workspace or publish a team baseline.
 */

export interface DeviceIdentity {
  readonly id: string;
  readonly personId: string;
  readonly displayName: string;
  readonly publicKey: string;
  readonly keyId: string;
  readonly state: DeviceState;
  readonly enrolledAt: string;
  readonly platform: PlatformTarget;
  readonly workspaceId: string | null;
  readonly keyPair: KeyPair;
}

export function currentPlatform(): PlatformTarget {
  const os: TargetOs =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch as TargetArch;
  return { os, arch };
}

export function isLocalOnlyIdentity(personId: string): boolean {
  return personId.startsWith("local:");
}

export function ensureDeviceIdentity(store: CompanionStore, now: () => string = () => new Date().toISOString()): DeviceIdentity {
  const existing = store.loadDevice();
  if (existing) {
    return {
      id: existing.id,
      personId: existing.personId,
      displayName: existing.displayName,
      publicKey: existing.publicKey,
      keyId: keyIdOf(existing.publicKey),
      state: existing.state as DeviceState,
      enrolledAt: existing.enrolledAt,
      platform: { os: existing.platformOs as TargetOs, arch: existing.platformArch as TargetArch },
      workspaceId: existing.workspaceId,
      keyPair: { publicKey: existing.publicKey, privateKeyPem: existing.privateKeyPem },
    };
  }

  const keyPair = generateDeviceKeyPair();
  const id = randomUUID();
  const platform = currentPlatform();
  const identity: DeviceIdentity = {
    id,
    personId: `local:${randomUUID()}`,
    displayName: safeHostname(),
    publicKey: keyPair.publicKey,
    keyId: keyIdOf(keyPair.publicKey),
    state: "enrolled",
    enrolledAt: now(),
    platform,
    workspaceId: null,
    keyPair,
  };
  store.saveDevice({
    id: identity.id,
    personId: identity.personId,
    displayName: identity.displayName,
    publicKey: identity.publicKey,
    privateKeyPem: keyPair.privateKeyPem,
    state: identity.state,
    enrolledAt: identity.enrolledAt,
    platformOs: platform.os,
    platformArch: platform.arch,
    workspaceId: null,
  });
  return identity;
}

/** Attach this device to a workspace after a successful invitation exchange. */
export function attachToWorkspace(
  store: CompanionStore,
  identity: DeviceIdentity,
  input: { workspaceId: string; personId: string; deviceId: string; displayName?: string },
): DeviceIdentity {
  const next: DeviceIdentity = {
    ...identity,
    id: input.deviceId,
    workspaceId: input.workspaceId,
    personId: input.personId,
    displayName: input.displayName ?? identity.displayName,
    state: "active",
  };
  store.saveDevice({
    id: next.id,
    personId: next.personId,
    displayName: next.displayName,
    publicKey: next.publicKey,
    privateKeyPem: next.keyPair.privateKeyPem,
    state: next.state,
    enrolledAt: next.enrolledAt,
    platformOs: next.platform.os,
    platformArch: next.platform.arch,
    workspaceId: next.workspaceId,
  });
  return next;
}

function safeHostname(): string {
  try {
    const name = hostname();
    return name.trim().length > 0 ? name.trim().slice(0, 64) : "this device";
  } catch {
    return "this device";
  }
}

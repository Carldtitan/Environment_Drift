import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  timingSafeEqual,
  verify as nodeVerify,
  createHash,
  hkdfSync,
} from "node:crypto";
import { canonicalize } from "./canonical.js";

export interface KeyPair {
  /** base64url raw 32-byte Ed25519 public key. */
  readonly publicKey: string;
  /** PKCS#8 PEM. Never leaves the device. */
  readonly privateKeyPem: string;
}

export interface Signature {
  readonly algorithm: "ed25519";
  /** base64url raw 32-byte public key of the signer. */
  readonly publicKey: string;
  /** base64url detached signature over the canonical JSON payload. */
  readonly value: string;
  /** Who produced this signature. */
  readonly signer: "device" | "service";
  /** Opaque id of the signing device or service key. */
  readonly keyId: string;
  readonly signedAt: string;
}

const RAW_ED25519_PUBLIC_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function generateDeviceKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const raw = Buffer.from(spki.subarray(spki.length - 32));
  return {
    publicKey: raw.toString("base64url"),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

/** Stable, non-secret identifier derived from a public key. */
export function keyIdOf(publicKeyBase64Url: string): string {
  return createHash("sha256").update(publicKeyBase64Url, "utf8").digest("hex").slice(0, 32);
}

function publicKeyObject(publicKeyBase64Url: string) {
  const raw = Buffer.from(publicKeyBase64Url, "base64url");
  if (raw.length !== 32) {
    throw new Error("ed25519 public key must be 32 bytes");
  }
  return createPublicKey({
    key: Buffer.concat([RAW_ED25519_PUBLIC_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function signPayload(
  payload: unknown,
  keyPair: KeyPair,
  signer: Signature["signer"],
  signedAt: string,
): Signature {
  const message = Buffer.from(canonicalize(payload), "utf8");
  const value = nodeSign(null, message, createPrivateKey(keyPair.privateKeyPem));
  return {
    algorithm: "ed25519",
    publicKey: keyPair.publicKey,
    value: value.toString("base64url"),
    signer,
    keyId: keyIdOf(keyPair.publicKey),
    signedAt,
  };
}

export function verifyPayload(payload: unknown, signature: Signature): boolean {
  if (signature.algorithm !== "ed25519") return false;
  let key;
  try {
    key = publicKeyObject(signature.publicKey);
  } catch {
    return false;
  }
  if (keyIdOf(signature.publicKey) !== signature.keyId) return false;
  const message = Buffer.from(canonicalize(payload), "utf8");
  let raw: Buffer;
  try {
    raw = Buffer.from(signature.value, "base64url");
  } catch {
    return false;
  }
  if (raw.length !== 64) return false;
  return nodeVerify(null, message, key, raw);
}

/** Constant-time comparison of two secrets/tokens presented as strings. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still perform a comparison so the branch cost does not leak the length of
    // the expected value for equal-length candidates.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export interface SealedBlob {
  readonly v: 1;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

/**
 * AES-256-GCM at rest for the local Companion store. The key lives only in a
 * 0600 key file on the developer's machine; it is never uploaded and never
 * placed in a contract.
 */
export function seal(plaintext: string, key: Buffer, aad?: string): SealedBlob {
  if (key.length !== 32) throw new Error("seal key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export function open(blob: SealedBlob, key: Buffer, aad?: string): string {
  if (key.length !== 32) throw new Error("open key must be 32 bytes");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function newLocalStoreKey(): Buffer {
  return randomBytes(32);
}

/** Derive a purpose-scoped subkey so one file key is not reused verbatim. */
export function deriveKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from(purpose), 32));
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

/** One-way hash for invitation tokens and device credentials at rest. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

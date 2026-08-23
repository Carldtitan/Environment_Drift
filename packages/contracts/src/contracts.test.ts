import { describe, expect, it } from "vitest";
import { canonicalize, digestOf, selfDigest } from "./canonical.js";
import {
  generateDeviceKeyPair,
  keyIdOf,
  open,
  safeEqual,
  seal,
  signPayload,
  verifyPayload,
  newLocalStoreKey,
  deriveKey,
} from "./crypto.js";
import { Redactor, assertRedacted, RedactionError, boundLog, parseEnvNamesAndValues } from "./redaction.js";
import {
  ContractIntegrityError,
  commandDigest,
  parseContract,
  parseStep,
  sealContract,
  signContract,
  transitionContract,
  verifyContractIntegrity,
  validate,
} from "./validate.js";
import {
  canTransitionContract,
  canTransitionRescueRun,
  isAutomaticallyRescuable,
  assuranceForContractState,
  roleAtLeast,
  CONTRACT_STATES,
} from "./states.js";
import { SCHEMA_STEP_KINDS, MATERIALIZATION_STEP_KINDS } from "./schemas/index.js";
import type { EnvironmentContractV1, MaterializationStep } from "./types.js";

const NOW = "2026-08-23T04:00:00.000Z";
const COMMIT = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

function baseContract(
  overrides: Partial<Omit<EnvironmentContractV1, "digest" | "signature">> = {},
): Omit<EnvironmentContractV1, "digest" | "signature"> {
  return {
    schemaVersion: 1,
    id: "contract-1",
    workspaceId: null,
    projectId: "project-1",
    source: {
      commit: COMMIT,
      canonicalRemoteDigest: DIGEST,
      subdirectory: ".",
      declaredFileDigests: [{ path: "manifest.json", digest: DIGEST, bytes: 12 }],
      worktreeDirty: false,
    },
    targets: [{ os: "linux", arch: "x64" }],
    support: "native",
    requirements: { runtimes: [], packages: [], systemTools: [], secrets: [] },
    steps: [],
    proof: {
      id: "proof-1",
      argv: ["node", "--version"],
      workDir: ".",
      timeoutMs: 60_000,
      expectedExitCodes: [0],
      envAllowlist: ["PATH"],
      description: "runtime is present",
      maxOutputBytes: 65_536,
    },
    evidence: [],
    policy: {
      allowProjectLocalState: true,
      requireRecipeReview: true,
      requireHumanApproval: false,
      allowSourceUpload: false,
    },
    state: "candidate",
    adapters: ["adapter-a"],
    issuedAt: NOW,
    authoredBy: { deviceId: "device-1", identity: "local:owner" },
    ...overrides,
  };
}

describe("canonical JSON", () => {
  it("is stable under key reordering", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(digestOf({ b: 1, a: 2 })).toBe(digestOf({ a: 2, b: 1 }));
  });

  it("drops undefined members and normalises -0", () => {
    expect(canonicalize({ a: undefined, b: -0 })).toBe('{"b":0}');
  });

  it("escapes control characters as lowercase \\u sequences", () => {
    expect(canonicalize("\u0001\n")).toBe('"\\u0001\\n"');
  });

  it("sorts by UTF-16 code unit", () => {
    expect(canonicalize({ "\u00e4": 1, z: 2 })).toBe('{"z":2,"\u00e4":1}');
  });

  it("refuses non-finite numbers", () => {
    expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it("selfDigest ignores digest and signature", () => {
    const a = { id: "x", value: 1, digest: "sha256:0", signature: { a: 1 } };
    const b = { id: "x", value: 1, digest: "sha256:1" };
    expect(selfDigest(a)).toBe(selfDigest(b));
  });
});

describe("signatures", () => {
  it("round-trips and rejects a modified payload", () => {
    const keys = generateDeviceKeyPair();
    const signature = signPayload({ a: 1 }, keys, "device", NOW);
    expect(verifyPayload({ a: 1 }, signature)).toBe(true);
    expect(verifyPayload({ a: 2 }, signature)).toBe(false);
  });

  it("rejects a signature whose keyId does not match its public key", () => {
    const keys = generateDeviceKeyPair();
    const other = generateDeviceKeyPair();
    const signature = signPayload({ a: 1 }, keys, "device", NOW);
    expect(verifyPayload({ a: 1 }, { ...signature, keyId: keyIdOf(other.publicKey) })).toBe(false);
  });

  it("rejects a signature made by a different key", () => {
    const keys = generateDeviceKeyPair();
    const other = generateDeviceKeyPair();
    const signature = signPayload({ a: 1 }, other, "device", NOW);
    expect(verifyPayload({ a: 1 }, { ...signature, publicKey: keys.publicKey, keyId: keyIdOf(keys.publicKey) })).toBe(
      false,
    );
  });

  it("compares tokens without leaking length via exceptions", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("local encryption", () => {
  it("round-trips and fails on a tampered ciphertext", () => {
    const key = deriveKey(newLocalStoreKey(), "test");
    const sealed = seal("device private key material", key, "aad");
    expect(open(sealed, key, "aad")).toBe("device private key material");
    const tampered = { ...sealed, data: Buffer.from("nope").toString("base64") };
    expect(() => open(tampered, key, "aad")).toThrow();
    expect(() => open(sealed, key, "different-aad")).toThrow();
  });
});

describe("redaction", () => {
  const SAMPLES: Array<[string, string]> = [
    ["private key", "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"],
    ["url credentials", "postgres://admin:hunter2hunter2@db.internal:5432/app"],
    ["authorization header", "Authorization: Basic YWRtaW46aHVudGVyMg=="],
    ["bearer token", "curl -H 'Bearer abcdefghijklmnop123456'"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r"],
    ["github token", "ghp_0123456789abcdefghijklmnopqrstuvwxyz"],
    ["assignment", 'API_KEY="sekret-value-here"'],
  ];

  for (const [name, sample] of SAMPLES) {
    it(`removes ${name}`, () => {
      const result = new Redactor().redactText(sample);
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.value).not.toContain("hunter2");
      expect(result.value).toContain("[redacted]");
    });
  }

  it("removes exact known secret values wherever they appear", () => {
    const redactor = new Redactor({ knownSecretValues: ["s3cr3t-project-value"] });
    const out = redactor.redactText("the deploy used s3cr3t-project-value twice: s3cr3t-project-value");
    expect(out.value).not.toContain("s3cr3t-project-value");
    expect(out.findings.filter((f) => f.category === "known_secret_value")).toHaveLength(2);
  });

  it("redacts values behind secret-looking object keys", () => {
    const { value, findings } = new Redactor().redactValue({
      name: "example",
      password: "correcthorse",
      nested: { access_token: "abcd1234efgh" },
    });
    expect(findings).toHaveLength(2);
    expect(value).toEqual({
      name: "example",
      password: "[redacted]",
      nested: { access_token: "[redacted]" },
    });
  });

  it("preserves ordinary values and git digests", () => {
    const { value, findings } = new Redactor().redactValue({
      commit: COMMIT,
      digest: DIGEST,
      version: "1.4.2",
      manager: "npm",
    });
    expect(findings).toHaveLength(0);
    expect(value).toEqual({ commit: COMMIT, digest: DIGEST, version: "1.4.2", manager: "npm" });
  });

  it("assertRedacted fails closed on a dirty payload", () => {
    expect(() => assertRedacted({ note: "token=abcdefghijkl" })).toThrow(RedactionError);
    expect(() => assertRedacted({ note: "installed a package" })).not.toThrow();
  });

  it("bounds an oversized log around its head and tail", () => {
    const bounded = boundLog("x".repeat(5000), 1000);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).toContain("omitted by IWOMC output cap");
    expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThan(1200);
  });

  it("extracts env names and values without conflating them", () => {
    const parsed = parseEnvNamesAndValues('# c\nexport A_TOKEN="abc"\nB=\nC=plain\n');
    expect(parsed.names).toEqual(["A_TOKEN", "B", "C"]);
    expect(parsed.values).toEqual(["abc", "plain"]);
  });
});

describe("state machine", () => {
  it("allows only declared contract transitions", () => {
    expect(canTransitionContract("candidate", "approved")).toBe(true);
    expect(canTransitionContract("clean_verified", "candidate")).toBe(false);
    expect(canTransitionContract("revoked", "approved")).toBe(false);
  });

  it("makes every rescue terminal state absorbing", () => {
    for (const terminal of ["working", "failed", "blocked", "unsupported", "inconclusive"] as const) {
      expect(canTransitionRescueRun(terminal, "proving")).toBe(false);
    }
  });

  it("never labels an unverified contract as verified", () => {
    for (const state of CONTRACT_STATES) {
      const assurance = assuranceForContractState(state);
      if (state === "clean_verified") expect(assurance).toBe("clean_verified");
      else if (state === "locally_checked") expect(assurance).toBe("locally_checked");
      else expect(assurance).toBe("unverified");
    }
  });

  it("only auto-rescues approved native or reviewed-recipe contracts", () => {
    expect(isAutomaticallyRescuable("clean_verified", "native", false)).toBe(true);
    expect(isAutomaticallyRescuable("candidate", "native", true)).toBe(false);
    expect(isAutomaticallyRescuable("approved", "recipe", false)).toBe(false);
    expect(isAutomaticallyRescuable("approved", "recipe", true)).toBe(true);
    expect(isAutomaticallyRescuable("clean_verified", "observe_only", true)).toBe(false);
  });

  it("orders workspace roles", () => {
    expect(roleAtLeast("owner", "maintainer")).toBe(true);
    expect(roleAtLeast("observer", "developer")).toBe(false);
  });
});

describe("schema validation", () => {
  it("keeps the step schema and the TypeScript union in lockstep", () => {
    expect([...SCHEMA_STEP_KINDS].sort()).toEqual([...MATERIALIZATION_STEP_KINDS].sort());
  });

  it("rejects an unknown step kind", () => {
    expect(() =>
      parseStep({
        id: "s1",
        kind: "run_arbitrary_shell",
        adapterId: "a",
        workDir: ".",
        idempotencyKey: "12345678",
        description: "no",
        command: "rm -rf /",
      }),
    ).toThrow(/validation failed/u);
  });

  it("rejects a recipe that has no review", () => {
    expect(() =>
      parseStep({
        id: "s1",
        kind: "run_reviewed_recipe",
        adapterId: "a",
        workDir: ".",
        idempotencyKey: "12345678",
        description: "build",
        argv: ["make"],
        commandDigest: DIGEST,
        envAllowlist: [],
        timeoutMs: 60_000,
        expectedExitCodes: [0],
      }),
    ).toThrow(/review/u);
  });

  it("rejects a step whose workDir escapes the project", () => {
    for (const workDir of ["../elsewhere", "/etc", "C:/Windows", "a\\b"]) {
      expect(() =>
        parseStep({
          id: "s1",
          kind: "ensure_system_tool",
          adapterId: "a",
          workDir,
          idempotencyKey: "12345678",
          description: "probe",
          tool: "git",
          probeArgv: ["git", "--version"],
        }),
      ).toThrow();
    }
  });

  it("rejects a secret requirement that carries a value", () => {
    const contract = baseContract();
    const violations = validate("environment-contract-v1", {
      ...contract,
      digest: DIGEST,
      requirements: {
        ...contract.requirements,
        secrets: [
          { name: "DB_URL", scope: "environment", required: true, source: "declared", value: "postgres://x" },
        ],
      },
    });
    expect(violations.some((v) => v.keyword === "additionalProperties")).toBe(true);
  });

  it("rejects an unscoped proof command", () => {
    const contract = baseContract();
    const violations = validate("environment-contract-v1", {
      ...contract,
      digest: DIGEST,
      proof: { ...contract.proof, argv: [] },
    });
    expect(violations.some((v) => v.path.includes("proof/argv"))).toBe(true);
  });
});

describe("contract integrity", () => {
  it("seals, signs, and verifies a contract", () => {
    const keys = generateDeviceKeyPair();
    const sealed = sealContract(baseContract());
    const signed = signContract(sealed, keys, "device", NOW);
    expect(() =>
      verifyContractIntegrity(signed, {
        expectedProjectId: "project-1",
        trustedDeviceKeys: [keys.publicKey],
      }),
    ).not.toThrow();
  });

  it("refuses a contract whose content was modified after signing", () => {
    const keys = generateDeviceKeyPair();
    const signed = signContract(sealContract(baseContract()), keys, "device", NOW);
    const tampered = parseContract({
      ...signed,
      proof: { ...signed.proof, argv: ["rm", "-rf", "."] },
    });
    expect(() => verifyContractIntegrity(tampered)).toThrow(ContractIntegrityError);
    try {
      verifyContractIntegrity(tampered);
    } catch (error) {
      expect((error as ContractIntegrityError).reason).toBe("digest_mismatch");
    }
  });

  it("refuses an unsigned contract", () => {
    const sealed = sealContract(baseContract());
    expect(() => verifyContractIntegrity(sealed)).toThrow(/unsigned/u);
  });

  it("refuses a contract signed by an untrusted key", () => {
    const keys = generateDeviceKeyPair();
    const other = generateDeviceKeyPair();
    const signed = signContract(sealContract(baseContract()), keys, "device", NOW);
    expect(() =>
      verifyContractIntegrity(signed, { trustedDeviceKeys: [other.publicKey] }),
    ).toThrow(/untrusted/u);
  });

  it("refuses a contract for a different project", () => {
    const keys = generateDeviceKeyPair();
    const signed = signContract(sealContract(baseContract()), keys, "device", NOW);
    expect(() => verifyContractIntegrity(signed, { expectedProjectId: "project-2" })).toThrow(
      /project-2/u,
    );
  });

  it("refuses a recipe whose argv changed after review", () => {
    const argv = ["make", "setup"];
    const step: MaterializationStep = {
      id: "s1",
      kind: "run_reviewed_recipe",
      adapterId: "generic",
      workDir: ".",
      idempotencyKey: "recipe-key-1",
      description: "project setup",
      argv,
      commandDigest: commandDigest(argv),
      envAllowlist: ["PATH"],
      timeoutMs: 60_000,
      expectedExitCodes: [0],
      review: {
        reviewedBy: "local:owner",
        reviewedAt: NOW,
        approvedCommandDigest: commandDigest(argv),
      },
    };
    expect(() => sealContract(baseContract({ steps: [step], support: "recipe" }))).not.toThrow();

    const swapped: MaterializationStep = {
      ...step,
      argv: ["curl", "http://example.invalid/install.sh"],
      commandDigest: commandDigest(["curl", "http://example.invalid/install.sh"]),
    };
    expect(() => sealContract(baseContract({ steps: [swapped], support: "recipe" }))).toThrow(
      /approved command digest/u,
    );
  });

  it("refuses to seal a contract carrying credential-shaped material", () => {
    const contract = baseContract({
      requirements: {
        runtimes: [],
        packages: [],
        systemTools: [],
        secrets: [
          {
            name: "DB_URL",
            scope: "environment",
            required: true,
            source: "declared",
            validationHint: "postgres://admin:hunter2hunter2@db/app",
          },
        ],
      },
    });
    expect(() => sealContract(contract)).toThrow(/credential-shaped/u);
  });

  it("drops the signature and re-addresses the contract on a state transition", () => {
    const keys = generateDeviceKeyPair();
    const signed = signContract(sealContract(baseContract()), keys, "device", NOW);
    const approved = transitionContract(signed, "approved");
    expect(approved.state).toBe("approved");
    expect(approved.signature).toBeUndefined();
    expect(approved.digest).not.toBe(signed.digest);
    expect(() => transitionContract(approved, "candidate")).toThrow(/cannot move/u);
  });
});

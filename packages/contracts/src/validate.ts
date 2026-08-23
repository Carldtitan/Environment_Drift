import { Validator, type SchemaViolation } from "./json-schema.js";
import { SCHEMAS, type SchemaName } from "./schemas/index.js";
import { selfDigest, digestOf } from "./canonical.js";
import { signPayload, verifyPayload, type KeyPair, type Signature } from "./crypto.js";
import { assertRedacted, Redactor, RedactionError } from "./redaction.js";
import type {
  EnvironmentContractV1,
  EnvironmentReceiptV1,
  MaterializationStep,
  ProofCommand,
  RescueEvent,
  RescueOutcomeV1,
  RescueRequestV1,
  VerificationAttestationV1,
} from "./types.js";
import { canTransitionContract, type ContractState } from "./states.js";

export { SchemaValidationError } from "./json-schema.js";
export type { SchemaViolation } from "./json-schema.js";

const validators = new Map<SchemaName, Validator>();

export function validatorFor(name: SchemaName): Validator {
  let validator = validators.get(name);
  if (!validator) {
    validator = new Validator(SCHEMAS[name]);
    validators.set(name, validator);
  }
  return validator;
}

export function validate(name: SchemaName, value: unknown): SchemaViolation[] {
  return validatorFor(name).validate(value);
}

export function parseContract(value: unknown): EnvironmentContractV1 {
  return validatorFor("environment-contract-v1").parse<EnvironmentContractV1>(value);
}

export function parseReceipt(value: unknown): EnvironmentReceiptV1 {
  return validatorFor("environment-receipt-v1").parse<EnvironmentReceiptV1>(value);
}

export function parseStep(value: unknown): MaterializationStep {
  return validatorFor("materialization-step-v1").parse<MaterializationStep>(value);
}

export function parseProofCommand(value: unknown): ProofCommand {
  return validatorFor("proof-command-v1").parse<ProofCommand>(value);
}

export function parseRescueRequest(value: unknown): RescueRequestV1 {
  return validatorFor("rescue-request-v1").parse<RescueRequestV1>(value);
}

export function parseRescueEvent(value: unknown): RescueEvent {
  return validatorFor("rescue-event-v1").parse<RescueEvent>(value);
}

export function parseRescueOutcome(value: unknown): RescueOutcomeV1 {
  return validatorFor("rescue-outcome-v1").parse<RescueOutcomeV1>(value);
}

export function parseVerificationAttestation(value: unknown): VerificationAttestationV1 {
  return validatorFor("verification-attestation-v1").parse<VerificationAttestationV1>(value);
}

// ---------------------------------------------------------------------------
// Contract integrity
// ---------------------------------------------------------------------------

export class ContractIntegrityError extends Error {
  readonly reason:
    | "digest_mismatch"
    | "signature_missing"
    | "signature_invalid"
    | "wrong_project"
    | "invalid_transition"
    | "secret_value_present"
    | "unreviewed_recipe";

  constructor(reason: ContractIntegrityError["reason"], message: string) {
    super(message);
    this.name = "ContractIntegrityError";
    this.reason = reason;
  }
}

/** Recompute and attach the content address of a contract. */
export function sealContract(
  contract: Omit<EnvironmentContractV1, "digest" | "signature">,
): EnvironmentContractV1 {
  assertNoSecretValues(contract);
  assertRecipesReviewed(contract.steps, contract.policy.requireRecipeReview);
  const digest = digestOf(contract);
  return parseContract({ ...contract, digest });
}

export function signContract(
  contract: EnvironmentContractV1,
  keyPair: KeyPair,
  signer: Signature["signer"],
  signedAt: string,
): EnvironmentContractV1 {
  const expected = selfDigest(contract as unknown as Record<string, unknown>);
  if (expected !== contract.digest) {
    throw new ContractIntegrityError(
      "digest_mismatch",
      `contract digest ${contract.digest} does not match its content (${expected})`,
    );
  }
  const signature = signPayload({ digest: contract.digest, id: contract.id }, keyPair, signer, signedAt);
  return { ...contract, signature };
}

export interface ContractVerificationOptions {
  /** The project this contract must belong to. */
  readonly expectedProjectId?: string;
  /** Public keys that are permitted to have signed a shareable contract. */
  readonly trustedServiceKeys?: readonly string[];
  /** Public key of this device, for verifying a local-only contract. */
  readonly trustedDeviceKeys?: readonly string[];
}

/**
 * Full integrity gate applied before any local mutation (R7.3).
 * Throws with a classified reason; never returns a partially trusted contract.
 */
export function verifyContractIntegrity(
  contract: EnvironmentContractV1,
  options: ContractVerificationOptions = {},
): void {
  const expectedDigest = selfDigest(contract as unknown as Record<string, unknown>);
  if (expectedDigest !== contract.digest) {
    throw new ContractIntegrityError(
      "digest_mismatch",
      "contract content does not match its recorded digest",
    );
  }
  if (options.expectedProjectId && contract.projectId !== options.expectedProjectId) {
    throw new ContractIntegrityError(
      "wrong_project",
      `contract belongs to project ${contract.projectId}, not ${options.expectedProjectId}`,
    );
  }
  assertNoSecretValues(contract);
  assertRecipesReviewed(contract.steps, contract.policy.requireRecipeReview);

  const signature = contract.signature;
  if (!signature) {
    throw new ContractIntegrityError("signature_missing", "contract is unsigned");
  }
  if (!verifyPayload({ digest: contract.digest, id: contract.id }, signature)) {
    throw new ContractIntegrityError("signature_invalid", "contract signature does not verify");
  }

  const allowed =
    signature.signer === "service" ? options.trustedServiceKeys : options.trustedDeviceKeys;
  if (allowed && !allowed.includes(signature.publicKey)) {
    throw new ContractIntegrityError(
      "signature_invalid",
      `contract was signed by an untrusted ${signature.signer} key`,
    );
  }
}

export function transitionContract(
  contract: EnvironmentContractV1,
  to: ContractState,
): EnvironmentContractV1 {
  if (!canTransitionContract(contract.state, to)) {
    throw new ContractIntegrityError(
      "invalid_transition",
      `a contract cannot move from ${contract.state} to ${to}`,
    );
  }
  const next = { ...contract, state: to };
  // The state is part of the signed content, so the previous signature no
  // longer applies. A caller must re-sign before the contract is usable again.
  const { signature: _dropped, digest: _oldDigest, ...rest } = next;
  void _dropped;
  void _oldDigest;
  return parseContract({ ...rest, digest: digestOf(rest) });
}

/**
 * Structural guarantee that no secret VALUE rides inside a contract. The
 * schema forbids extra properties; this additionally scans every string for
 * credential-shaped material (R5.4).
 */
export function assertNoSecretValues(
  contract: Pick<EnvironmentContractV1, "requirements" | "steps" | "proof">,
  redactor?: Redactor,
): void {
  try {
    assertRedacted(
      {
        requirements: contract.requirements,
        steps: contract.steps,
        proof: contract.proof,
      },
      redactor,
    );
  } catch (error) {
    if (error instanceof RedactionError) {
      throw new ContractIntegrityError(
        "secret_value_present",
        `contract contains credential-shaped material: ${error.message}`,
      );
    }
    throw error;
  }
}

function assertRecipesReviewed(
  steps: readonly MaterializationStep[],
  requireReview: boolean,
): void {
  if (!requireReview) return;
  for (const step of steps) {
    if (step.kind !== "run_reviewed_recipe") continue;
    if (step.review.approvedCommandDigest !== step.commandDigest) {
      throw new ContractIntegrityError(
        "unreviewed_recipe",
        `recipe step ${step.id} was modified after review; the approved command digest no longer matches`,
      );
    }
    if (digestOf(step.argv) !== step.commandDigest) {
      throw new ContractIntegrityError(
        "unreviewed_recipe",
        `recipe step ${step.id} argv does not match its command digest`,
      );
    }
  }
}

/** Digest a recipe's argv the same way the executor and reviewer do. */
export function commandDigest(argv: readonly string[]): string {
  return digestOf(argv);
}

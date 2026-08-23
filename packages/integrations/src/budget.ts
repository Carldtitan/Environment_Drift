import { randomUUID } from "node:crypto";
import type { CompanionStore } from "@iwomc/companion";

/**
 * The IWOMC verification budget.
 *
 * A verifier that costs money must refuse to start when the remaining
 * app-level budget cannot cover the worst case for one run. The ledger is
 * append-only and lives in the local encrypted store, so the ceiling survives
 * restarts and is auditable.
 */

export interface BudgetPolicy {
  /** Hard ceiling for this installation, in USD. */
  readonly totalUsd: number;
  /** The most one verification is allowed to cost, in USD. */
  readonly perRunCapUsd: number;
}

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly remainingUsd: number;
  readonly spentUsd: number;
  readonly reason: string;
}

/**
 * Modal's published pricing is per CPU-core-second and per GiB-second. These
 * are the rate assumptions IWOMC uses to bound a run *before* it starts; the
 * recorded cost is always labelled as an estimate derived from them, never as
 * a billed amount read back from a provider.
 */
export interface RateAssumptions {
  readonly cpuCoreSecondUsd: number;
  readonly gibSecondUsd: number;
  readonly note: string;
}

export const DEFAULT_RATES: RateAssumptions = {
  cpuCoreSecondUsd: 0.0000131,
  gibSecondUsd: 0.00000222,
  note: "Estimated from reserved CPU cores and memory multiplied by wall-clock seconds, using IWOMC's configured rate assumptions. This is a bound IWOMC enforces, not a billed amount.",
};

export class BudgetLedger {
  readonly #store: CompanionStore;
  readonly #provider: string;
  readonly #policy: BudgetPolicy;
  readonly #rates: RateAssumptions;

  constructor(input: {
    store: CompanionStore;
    provider: string;
    policy: BudgetPolicy;
    rates?: RateAssumptions;
  }) {
    this.#store = input.store;
    this.#provider = input.provider;
    this.#policy = input.policy;
    this.#rates = input.rates ?? DEFAULT_RATES;
  }

  get policy(): BudgetPolicy {
    return this.#policy;
  }

  get rates(): RateAssumptions {
    return this.#rates;
  }

  spent(): number {
    return this.#store.totalSpend(this.#provider);
  }

  remaining(): number {
    return Math.max(0, this.#policy.totalUsd - this.spent());
  }

  /** Worst-case cost of a run with these limits, using the rate assumptions. */
  estimate(input: { cpuCores: number; memoryMiB: number; seconds: number }): number {
    const cpu = input.cpuCores * input.seconds * this.#rates.cpuCoreSecondUsd;
    const memory = (input.memoryMiB / 1024) * input.seconds * this.#rates.gibSecondUsd;
    return Number((cpu + memory).toFixed(6));
  }

  /**
   * Decide before provisioning. The check uses the worst case for the run, so
   * a run can never start that could push spend past the ceiling.
   */
  authorize(worstCaseUsd: number): BudgetDecision {
    const spent = this.spent();
    const remaining = Math.max(0, this.#policy.totalUsd - spent);
    if (worstCaseUsd > this.#policy.perRunCapUsd) {
      return {
        allowed: false,
        remainingUsd: remaining,
        spentUsd: spent,
        reason: `This run's worst case (USD ${worstCaseUsd.toFixed(4)}) exceeds the per-run cap of USD ${this.#policy.perRunCapUsd.toFixed(2)}. Lower the sandbox timeout, CPU, or memory.`,
      };
    }
    if (worstCaseUsd > remaining) {
      return {
        allowed: false,
        remainingUsd: remaining,
        spentUsd: spent,
        reason: `Only USD ${remaining.toFixed(4)} of the USD ${this.#policy.totalUsd.toFixed(2)} verification budget remains, which cannot cover this run's worst case of USD ${worstCaseUsd.toFixed(4)}.`,
      };
    }
    return {
      allowed: true,
      remainingUsd: remaining,
      spentUsd: spent,
      reason: `USD ${remaining.toFixed(4)} of USD ${this.#policy.totalUsd.toFixed(2)} remains; this run is bounded at USD ${worstCaseUsd.toFixed(4)}.`,
    };
  }

  record(input: { amountUsd: number; reference: string; at: string }): void {
    this.#store.recordSpend({
      id: randomUUID(),
      provider: this.#provider,
      amountUsd: Number(input.amountUsd.toFixed(6)),
      at: input.at,
      reference: input.reference,
    });
  }

  history(limit = 50) {
    return this.#store.listSpend(this.#provider, limit);
  }
}

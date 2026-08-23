import { Companion, CompanionStore, defaultRegistryForCompanion, loadConfig } from "@iwomc/companion";
import { BudgetLedger, ClaudeMemAdapter, DisabledMemory, ModalVerifier } from "@iwomc/integrations";
import type { MemoryPort, VerifierPort } from "@iwomc/companion";

/**
 * Compose the Companion with its real integrations.
 *
 * Nothing here decides that an integration is connected. Each adapter performs
 * its own live check when asked, and reports an honest state when it fails.
 */
export async function buildCompanion(env: NodeJS.ProcessEnv = process.env): Promise<Companion> {
  const store = CompanionStore.open(env);
  const config = loadConfig(env);
  const registry = defaultRegistryForCompanion();

  const memory: MemoryPort =
    env["IWOMC_DISABLE_MEMORY"] === "1"
      ? new DisabledMemory("Durable memory is disabled for this process (IWOMC_DISABLE_MEMORY=1).")
      : new ClaudeMemAdapter({ baseUrl: config.claudeMemBaseUrl, env });

  const verifiers: VerifierPort[] = [
    new ModalVerifier({
      budget: new BudgetLedger({
        store,
        provider: "modal",
        policy: { totalUsd: config.modalBudgetUsd, perRunCapUsd: config.modalPerRunCapUsd },
      }),
      registry,
      limits: {
        cpuCores: config.modalCpuLimit,
        memoryMiB: config.modalMemoryMb,
        timeoutSeconds: config.modalTimeoutSeconds,
        maxRetries: config.modalMaxRetries,
      },
      profile: config.modalProfile,
      env,
    }),
  ];

  return new Companion({ store, registry, memory, verifiers, env });
}

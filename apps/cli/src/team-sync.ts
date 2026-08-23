import type { EnvironmentContractV1, EnvironmentReceiptV1, RescueOutcomeV1 } from "@iwomc/contracts";
import type { Companion, ProjectBinding } from "@iwomc/companion";
import { ControlPlaneClient } from "@iwomc/integrations";

interface TeamConnection {
  readonly client: ControlPlaneClient;
  readonly credentials: { deviceId: string; token: string };
}

/**
 * Team sync is deliberately outside the Companion: local capture/rescue stay
 * useful offline, while this layer copies signed records to the shared plane
 * when the device was enrolled with `iwomc join`.
 */
function connection(companion: Companion): TeamConnection | null {
  const token = companion.store.getMeta("device_token");
  if (!companion.config.controlPlaneUrl || !token || !companion.device.workspaceId) return null;
  return {
    client: new ControlPlaneClient({ baseUrl: companion.config.controlPlaneUrl }),
    credentials: { deviceId: companion.device.id, token },
  };
}

export async function syncProjectBinding(
  companion: Companion,
  binding: ProjectBinding,
): Promise<{ binding: ProjectBinding; synced: boolean }> {
  const team = connection(companion);
  if (!team) return { binding, synced: false };

  const remote = await team.client.registerProjectBinding({
    credentials: team.credentials,
    projectId: binding.projectId,
    projectName: binding.projectName,
    canonicalRemoteDigest: binding.canonicalRemoteDigest,
    subdirectory: binding.subdirectory,
  });

  if (remote.projectId === binding.projectId && binding.workspaceId === companion.device.workspaceId) {
    return { binding, synced: true };
  }

  const next: ProjectBinding = {
    ...binding,
    projectId: remote.projectId,
    workspaceId: companion.device.workspaceId,
  };
  companion.store.saveBinding(next);
  if (remote.projectId !== binding.projectId) companion.store.deleteBinding(binding.projectId);
  return { binding: next, synced: true };
}

export async function publishCapture(
  companion: Companion,
  input: { receipt: EnvironmentReceiptV1; contract: EnvironmentContractV1 | null },
): Promise<{ published: boolean; contract: EnvironmentContractV1 | null }> {
  const team = connection(companion);
  if (!team) return { published: false, contract: input.contract };

  await team.client.publishReceipt({ credentials: team.credentials, receipt: input.receipt });
  if (!input.contract) return { published: true, contract: null };

  const shared = await team.client.publishContract({ credentials: team.credentials, contract: input.contract });
  companion.store.saveContract(shared.contract, "team");
  return { published: true, contract: shared.contract };
}

export async function publishVerifiedContract(
  companion: Companion,
  contract: EnvironmentContractV1 | null,
): Promise<{ published: boolean; contract: EnvironmentContractV1 | null }> {
  const team = connection(companion);
  if (!team || !contract) return { published: false, contract };
  const shared = await team.client.publishContract({ credentials: team.credentials, contract });
  companion.store.saveContract(shared.contract, "team");
  return { published: true, contract: shared.contract };
}

/** Fetch the exact shared baseline before a local rescue looks for contracts. */
export async function hydrateContractForCheckout(companion: Companion, dir: string): Promise<boolean> {
  const team = connection(companion);
  if (!team) return false;
  const status = await companion.status(dir);
  if (!status.project) return false;

  const resolved = await team.client.fetchContract({
    credentials: team.credentials,
    projectId: status.project.projectId,
    commit: status.project.commit,
  });
  if (resolved.exact) {
    companion.store.saveContract(resolved.exact, "team");
    return true;
  }
  if (resolved.nearest) companion.store.saveContract(resolved.nearest, "team");
  return false;
}

export async function publishRescue(
  companion: Companion,
  outcome: RescueOutcomeV1 | null,
): Promise<boolean> {
  const team = connection(companion);
  if (!team || !outcome) return false;
  await team.client.publishRescueOutcome({ credentials: team.credentials, outcome });
  return true;
}

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";
import {
  Redactor,
  digestOf,
  parseEnvNamesAndValues,
  sealContract,
  signContract,
  type ContractPolicy,
  type CoverageGap,
  type DriftFinding,
  type EnvironmentContractV1,
  type EnvironmentReceiptV1,
  type EvidenceItem,
  type InventorySnapshot,
  type MaterializationStep,
  type PackageRequirement,
  type ProofCommand,
  type RuntimeFingerprint,
  type RuntimeRequirement,
  type SecretRequirement,
  type SupportLevel,
  type SystemToolRequirement,
  type PackageEventV1,
} from "@iwomc/contracts";
import {
  isUnsupported,
  type AdapterContext,
  type ContractFragment,
  type EnvironmentAdapter,
  type EvidenceBundle,
  type ObservedEffect,
  type ObservedProcess,
  type AdapterRegistry,
} from "@iwomc/adapters";
import { probe } from "./exec.js";
import { MANAGED_DIR } from "./paths.js";
import { buildSourceReference, digestDeclaredFiles, type ProjectContext } from "./project.js";
import type { DeviceIdentity } from "./identity.js";

/**
 * Capture (design 4.1).
 *
 * Everything here is deterministic and local. Capture reads declared state,
 * inventories what the adapters can actually see, derives which of it the
 * repository fails to declare, and records what it could NOT see as an explicit
 * coverage gap - absence is never treated as evidence of absence (R4.5).
 */

export interface CaptureInput {
  readonly project: ProjectContext;
  readonly device: DeviceIdentity;
  readonly registry: AdapterRegistry;
  readonly proof: ProofCommand | null;
  /** Package-manager processes observed inside a managed boundary. */
  readonly observedProcesses?: readonly ObservedProcess[];
  /**
   * Changes the package log recorded while this revision was checked out.
   *
   * This is the strongest evidence a capture can have that a package was
   * installed here rather than pulled in transitively: it is a recorded
   * before-and-after, with the exact version and the moment it changed, not an
   * inference from the shape of `node_modules`. Reachability analysis stays in
   * place for everything installed before the log existed.
   */
  readonly recordedChanges?: readonly PackageEventV1[];
  readonly agentSession?: { provider: string; sessionRef: string };
  /** Explicit project decisions baked into the contract's policy block. */
  readonly policyOverrides?: Partial<ContractPolicy>;
  readonly now?: () => string;
}

export interface CaptureResult {
  readonly receipt: EnvironmentReceiptV1;
  readonly contract: EnvironmentContractV1 | null;
  readonly support: SupportLevel;
  readonly supportReason: string;
  readonly drift: readonly DriftFinding[];
  readonly coverage: readonly CoverageGap[];
  readonly redactor: Redactor;
  /** Names only. Their values were used for redaction and then discarded. */
  readonly secretNames: readonly string[];
  readonly blockers: readonly string[];
}

/** Runtimes IWOMC will fingerprint when an adapter that needs them is present. */
const RUNTIME_PROBES: Readonly<Record<string, readonly string[]>> = {
  node: ["node", "--version"],
  npm: ["npm", "--version"],
  python: ["python", "--version"],
  uv: ["uv", "--version"],
  git: ["git", "--version"],
};

const ENV_FILE_CANDIDATES = [".env", ".env.local", ".env.development", ".env.example", ".env.sample"];

export async function captureEnvironment(input: CaptureInput): Promise<CaptureResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const capturedAt = now();
  const { project, device, registry } = input;

  const ctx: AdapterContext = {
    projectDir: project.projectDir,
    files: project.files,
    platform: project.platform,
    probe: (argv, options) =>
      probe(argv, { cwd: options?.cwd ?? project.projectDir, timeoutMs: options?.timeoutMs ?? 30_000 }),
  };

  // 1. Secrets: names from env files, values only to seed the redactor.
  const { secretNames, secretValues, secretRequirements, envFiles } = await readProjectSecrets(
    project.projectDir,
  );
  const redactor = new Redactor({ knownSecretValues: secretValues });

  // 2. Which adapters actually own this project.
  const detected = await registry.detectAll(project.files);
  const support = await registry.supportLevelFor(project.files);

  // 3. Runtime fingerprints.
  const runtimes = await fingerprintRuntimes(project.projectDir, detected);

  const evidence: EvidenceItem[] = [];
  const inventories: InventorySnapshot[] = [];
  const coverage: CoverageGap[] = [...baseCoverageGaps(support.recognized.map((r) => r.probe.manager))];
  const fragments: ContractFragment[] = [];
  const drift: DriftFinding[] = [];
  const declaredFilePaths = new Set<string>();

  for (const runtime of runtimes) {
    evidence.push({
      id: `runtime:${runtime.runtime}`,
      source: runtime.source,
      confidence: "high",
      adapterId: "companion",
      kind: "runtime_fingerprint",
      summary: `${runtime.runtime} ${runtime.version}`,
      observedAt: capturedAt,
    });
  }

  for (const adapter of detected) {
    const declared = await adapter.readDeclaredState(ctx);
    for (const file of declared.files) declaredFilePaths.add(file);
    coverage.push(...declared.gaps);

    const inventory = await adapter.inventory(ctx);
    coverage.push(...inventory.gaps);
    if (inventory.snapshot) inventories.push(inventory.snapshot);

    const observed: ObservedEffect[] = [...(await adapter.deriveObservedEffects(ctx))];
    for (const observedProcess of input.observedProcesses ?? []) {
      observed.push(...adapter.observeProcess(observedProcess));
    }

    const recorded = (input.recordedChanges ?? []).filter(
      (event) => event.adapterId === adapter.manifest.id,
    );
    for (const effect of effectsFromLog(adapter.manifest.manager, recorded)) observed.push(effect);
    for (const event of recorded) {
      evidence.push({
        id: `package-event:${event.id}`,
        source: "observed",
        confidence: "high",
        adapterId: adapter.manifest.id,
        kind: "package_change",
        summary: `${event.name} ${describeChange(event)} while ${event.commit ? event.commit.slice(0, 12) : "this revision"} was checked out`,
        observedAt: event.at,
      });
    }

    for (const [index, effect] of observed.entries()) {
      evidence.push({
        id: `${adapter.manifest.id}:effect:${index}`,
        source: "observed",
        confidence: effect.confidence,
        adapterId: adapter.manifest.id,
        kind: effect.kind,
        summary: redactor.redactText(effect.summary).value,
        detail: {
          manager: effect.manager,
          packages: effect.packages.map((pkg) => `${pkg.name}@${pkg.versionSpec}`),
        },
        observedAt: capturedAt,
      });
    }

    for (const declaredPackage of declared.packages) {
      evidence.push({
        id: `${adapter.manifest.id}:declared:${declaredPackage.name}`,
        source: "declared",
        confidence: "high",
        adapterId: adapter.manifest.id,
        kind: "declared_package",
        summary: `${declaredPackage.name} ${declaredPackage.versionSpec}`,
      });
    }

    const bundle: EvidenceBundle = {
      projectDir: project.projectDir,
      platform: project.platform,
      declared,
      // Which packages install only on some platforms. This is what decides
      // whether the contract can be applied on another operating system.
      ...(inventory.platformConstraints && Object.keys(inventory.platformConstraints).length > 0
        ? { platformConstraints: inventory.platformConstraints }
        : {}),
      ...(inventory.snapshot ? { inventoryAfter: inventory.snapshot } : {}),
      observed,
      evidence,
      managedDir: MANAGED_DIR,
    };

    const compiled = adapter.compile(bundle);
    if (isUnsupported(compiled)) {
      coverage.push(...compiled.coverage);
      continue;
    }
    fragments.push(compiled);
    coverage.push(...compiled.coverage);
    for (const finding of compiled.drift) {
      drift.push({
        ...finding,
        id: digestOf({ ...finding, commit: project.git.commit }).slice(7, 39),
        projectId: project.binding.projectId,
        commit: project.git.commit,
        detectedAt: capturedAt,
      });
    }
  }

  // 4. Receipt.
  const declaredFileDigests = await digestDeclaredFiles(
    project.projectDir,
    [...declaredFilePaths, ...envFiles.filter((file) => file.endsWith(".example") || file.endsWith(".sample"))],
    {
      commit: project.git.commit,
      dirtyPaths: new Set(project.git.dirtyPaths),
      subdirectory: project.binding.subdirectory,
    },
  );
  const source = buildSourceReference(project.git, project.binding.subdirectory, declaredFileDigests);

  const receiptBody = {
    schemaVersion: 1 as const,
    id: randomUUID(),
    workspaceId: project.binding.workspaceId,
    projectId: project.binding.projectId,
    deviceId: device.id,
    capturedAt,
    source,
    host: { os: project.platform.os, arch: project.platform.arch, osRelease: safeRelease() },
    runtimes,
    evidence,
    inventories,
    coverage: dedupeCoverage(coverage),
    redaction: {
      findingCount: 0,
      categories: [],
      knownSecretNames: secretNames,
    },
    ...(input.agentSession ? { agentSession: input.agentSession } : {}),
  };
  const receipt: EnvironmentReceiptV1 = {
    ...receiptBody,
    digest: digestOf(receiptBody),
  };

  // 5. Contract.
  const blockers: string[] = [];
  let contract: EnvironmentContractV1 | null = null;

  if (input.proof === null) {
    blockers.push(
      "No proof command is configured for this project, so a contract cannot claim the project works.",
    );
  } else if (fragments.length === 0) {
    blockers.push(
      `No adapter can materialize this project (${support.reason}). Evidence was captured; rescue is unavailable.`,
    );
  } else {
    contract = buildContract({
      fragments,
      receipt,
      project,
      device,
      proof: input.proof,
      secretRequirements,
      support: fragments.every((fragment) => fragment.support === "native") ? "native" : "recipe",
      issuedAt: capturedAt,
      adapters: fragments.map((fragment) => fragment.adapterId),
      ...(input.policyOverrides ? { policyOverrides: input.policyOverrides } : {}),
    });
    contract = signContract(contract, device.keyPair, "device", capturedAt);
  }

  if (project.git.worktreeDirty) {
    blockers.push(
      "The worktree has uncommitted changes, so this capture stays local-only and cannot become a team baseline.",
    );
  }

  return {
    receipt,
    contract,
    support: contract ? contract.support : "observe_only",
    supportReason: support.reason,
    drift,
    coverage: dedupeCoverage(coverage),
    redactor,
    secretNames,
    blockers,
  };
}

interface BuildContractInput {
  readonly fragments: readonly ContractFragment[];
  readonly receipt: EnvironmentReceiptV1;
  readonly project: ProjectContext;
  readonly device: DeviceIdentity;
  readonly proof: ProofCommand;
  readonly secretRequirements: readonly SecretRequirement[];
  readonly support: SupportLevel;
  readonly issuedAt: string;
  readonly adapters: readonly string[];
  readonly policyOverrides?: Partial<ContractPolicy>;
}

export function buildContract(input: BuildContractInput): EnvironmentContractV1 {
  const runtimes: RuntimeRequirement[] = [];
  const packages: PackageRequirement[] = [];
  const systemTools: SystemToolRequirement[] = [];
  const steps: MaterializationStep[] = [];

  for (const fragment of input.fragments) {
    runtimes.push(...fragment.runtimes);
    packages.push(...fragment.packages);
    systemTools.push(...fragment.systemTools);
    steps.push(...fragment.steps);
  }

  const policy: ContractPolicy = {
    allowProjectLocalState: true,
    requireRecipeReview: true,
    requireHumanApproval: false,
    // Source upload to a clean verifier is off until a project explicitly
    // enables it (R12.4).
    allowSourceUpload: false,
    ...input.policyOverrides,
  };

  return sealContract({
    schemaVersion: 1,
    id: randomUUID(),
    workspaceId: input.project.binding.workspaceId,
    projectId: input.project.binding.projectId,
    source: input.receipt.source,
    targets: [input.project.platform],
    support: input.support,
    requirements: {
      runtimes: dedupeBy(runtimes, (entry) => `${entry.runtime}:${entry.versionSpec}`),
      packages: dedupeBy(packages, (entry) => `${entry.manager}:${entry.name}`),
      systemTools: dedupeBy(systemTools, (entry) => entry.name),
      secrets: [...input.secretRequirements],
    },
    steps: orderSteps(steps),
    proof: input.proof,
    evidence: [{ receiptId: input.receipt.id, digest: input.receipt.digest }],
    policy,
    state: "candidate",
    adapters: [...new Set(input.adapters)],
    issuedAt: input.issuedAt,
    authoredBy: { deviceId: input.device.id, identity: input.device.personId },
  });
}

const STEP_ORDER: Readonly<Record<MaterializationStep["kind"], number>> = {
  ensure_runtime: 0,
  ensure_system_tool: 1,
  create_virtual_environment: 2,
  write_project_local_file: 3,
  install_project_dependencies: 4,
  apply_package_overlay: 5,
  run_reviewed_recipe: 6,
};

/** Deterministic order: runtimes, then environments, then installs, then overlays. */
export function orderSteps(steps: readonly MaterializationStep[]): MaterializationStep[] {
  return [...steps].sort((a, b) => {
    const order = STEP_ORDER[a.kind] - STEP_ORDER[b.kind];
    return order !== 0 ? order : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) seen.set(k, item);
  }
  return [...seen.values()];
}

function dedupeCoverage(gaps: readonly CoverageGap[]): CoverageGap[] {
  return dedupeBy(gaps, (gap) => `${gap.area}:${gap.reason}`);
}

async function fingerprintRuntimes(
  cwd: string,
  detected: readonly EnvironmentAdapter[],
): Promise<RuntimeFingerprint[]> {
  const wanted = new Set<string>(["git"]);
  for (const adapter of detected) {
    if (adapter.manifest.ecosystem === "node") {
      wanted.add("node");
      wanted.add("npm");
    }
    if (adapter.manifest.ecosystem === "python") {
      wanted.add("python");
      if (adapter.manifest.manager === "uv") wanted.add("uv");
    }
  }

  const out: RuntimeFingerprint[] = [];
  for (const runtime of [...wanted].sort()) {
    const argv = RUNTIME_PROBES[runtime];
    if (!argv) continue;
    const result = await probe(argv, { cwd, timeoutMs: 30_000 });
    if (!result.ok) {
      out.push({ runtime, version: "unavailable", source: "unavailable" });
      continue;
    }
    const version = extractVersion(`${result.stdout} ${result.stderr}`);
    out.push({ runtime, version: version ?? result.stdout.trim().slice(0, 64), source: "observed" });
  }
  return out;
}

function extractVersion(text: string): string | null {
  const match = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/u.exec(text);
  return match?.[1] ?? null;
}

function safeRelease(): string | undefined {
  try {
    return release().slice(0, 255);
  } catch {
    return undefined;
  }
}

/**
 * Read environment-file NAMES for the contract and VALUES for the redactor.
 * The values never leave this function's caller chain and never reach a
 * contract, a receipt, or an upload (R5.4, R12).
 */
export async function readProjectSecrets(projectDir: string): Promise<{
  secretNames: string[];
  secretValues: string[];
  secretRequirements: SecretRequirement[];
  envFiles: string[];
}> {
  const names = new Set<string>();
  const exampleNames = new Set<string>();
  const values: string[] = [];
  const envFiles: string[] = [];

  let entries: string[] = [];
  try {
    entries = await readdir(projectDir);
  } catch {
    entries = [];
  }

  const candidates = new Set<string>([
    ...ENV_FILE_CANDIDATES,
    ...entries.filter((entry) => entry.startsWith(".env")),
  ]);

  for (const file of [...candidates].sort()) {
    let body: string;
    try {
      body = await readFile(join(projectDir, file), "utf8");
    } catch {
      continue;
    }
    envFiles.push(file);
    const parsed = parseEnvNamesAndValues(body);
    const isTemplate = file.endsWith(".example") || file.endsWith(".sample");
    for (const name of parsed.names) {
      names.add(name);
      if (isTemplate) exampleNames.add(name);
    }
    // A template file's placeholder values are not secrets, so they are not
    // fed to the redactor; a real .env's values always are.
    if (!isTemplate) values.push(...parsed.values);
  }

  const secretRequirements: SecretRequirement[] = [...names].sort().map((name) => ({
    name,
    scope: "environment" as const,
    required: exampleNames.has(name),
    source: exampleNames.has(name) ? ("declared" as const) : ("observed" as const),
    validationHint: exampleNames.has(name)
      ? "Declared in the repository's environment template."
      : "Present in a local environment file that is not committed.",
  }));

  return { secretNames: [...names].sort(), secretValues: values, secretRequirements, envFiles };
}

/**
 * What IWOMC structurally cannot see. Recording these is what keeps capture
 * honest rather than implying an exhaustive host snapshot (R3.2.1, R4.5).
 */
function baseCoverageGaps(recognizedManagers: readonly string[]): CoverageGap[] {
  const gaps: CoverageGap[] = [
    {
      area: "host.global-packages",
      reason:
        "IWOMC inventories project-local state only. Software installed globally or by a system package manager is outside its coverage.",
      remediation: "Declare required system tools so a rescue can check for them before it starts.",
    },
    {
      area: "host.machine-configuration",
      reason:
        "Shell profiles, PATH edits, service configuration, and OS settings are not captured.",
    },
    {
      area: "secrets.values",
      reason: "Secret values are never read into a receipt or contract; only their names are recorded.",
      remediation: "Set the named secrets locally before running rescue.",
    },
    {
      area: "external.services",
      reason:
        "Databases, SaaS accounts, OAuth applications, and webhooks are not reproduced. Their requirements are recorded, not recreated.",
    },
  ];
  const observeOnly = recognizedManagers.filter((manager) =>
    ["conda", "homebrew", "apt", "chocolatey", "winget", "vcpkg", "conan", "asdf", "mise", "volta", "sdkman", "nvm"].includes(
      manager,
    ),
  );
  if (observeOnly.length > 0) {
    gaps.push({
      area: "ecosystem.observe-only",
      reason: `${observeOnly.join(", ")} were recognised in this project but change machine-wide state, so IWOMC reports them instead of applying them.`,
      remediation: "Install those requirements deliberately; rescue will report them as blockers if they are missing.",
    });
  }
  return gaps;
}

/**
 * A redactor that knows this project's own environment values.
 *
 * Shape-based rules cannot recognise an arbitrary literal, so anything that
 * leaves the machine for a project must be filtered by this, not by the default
 * redactor alone.
 */
export async function buildProjectRedactor(projectDir: string): Promise<Redactor> {
  const { secretValues } = await readProjectSecrets(projectDir);
  return new Redactor({ knownSecretValues: secretValues });
}

/** Plain-language description of one recorded change, for evidence summaries. */
function describeChange(event: PackageEventV1): string {
  switch (event.kind) {
    case "installed":
      return `was installed at ${event.toVersion ?? "an unrecorded version"}`;
    case "removed":
      return `was removed from ${event.fromVersion ?? "an unrecorded version"}`;
    case "downgraded":
      return `was downgraded from ${event.fromVersion} to ${event.toVersion}`;
    default:
      return `was upgraded from ${event.fromVersion} to ${event.toVersion}`;
  }
}

/**
 * Turn recorded changes into observed effects an adapter's compiler understands.
 *
 * A downgrade matters as much as an install here: if the working checkout had
 * to move a package *back*, a teammate who installs the latest version gets a
 * broken environment, and that is precisely the case a snapshot cannot express.
 * A package that was installed and later removed produces both events, and the
 * remove is applied last, so it does not end up in the contract.
 */
function effectsFromLog(
  manager: string,
  events: readonly PackageEventV1[],
): ObservedEffect[] {
  const latest = new Map<string, PackageEventV1>();
  for (const event of events) {
    const existing = latest.get(event.name);
    if (!existing || event.seq > existing.seq) latest.set(event.name, event);
  }

  const added: { name: string; versionSpec: string }[] = [];
  const removed: { name: string; versionSpec: string }[] = [];
  for (const event of latest.values()) {
    if (event.kind === "removed") {
      removed.push({ name: event.name, versionSpec: event.fromVersion ?? "*" });
      continue;
    }
    if (event.toVersion === null) continue;
    added.push({ name: event.name, versionSpec: event.toVersion });
  }

  const effects: ObservedEffect[] = [];
  if (added.length > 0) {
    effects.push({
      adapterId: events[0]?.adapterId ?? manager,
      kind: "package_added",
      manager,
      packages: added,
      // A recorded before-and-after, not an inference from directory shape.
      confidence: "high",
      summary: `${added.length} package(s) were installed or changed here while this revision was checked out.`,
    });
  }
  if (removed.length > 0) {
    effects.push({
      adapterId: events[0]?.adapterId ?? manager,
      kind: "package_removed",
      manager,
      packages: removed,
      confidence: "high",
      summary: `${removed.length} package(s) were removed here while this revision was checked out.`,
    });
  }
  return effects;
}

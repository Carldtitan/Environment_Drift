/**
 * Watching a Node project that npm does not own.
 *
 * pnpm, Yarn and Bun are common, and IWOMC cannot yet repair a project that
 * uses one: doing that means running their commands, and this product does not
 * run a package manager it has not been taught. That support level is honest
 * and it stays.
 *
 * But *observing* is a different question from repairing, and the answer to it
 * was accidentally the same. A pnpm project recorded nothing at all - no
 * package log, no history, no "what did this machine have at that commit" -
 * even though the packages are sitting in `node_modules` in the same shape npm
 * puts them in. That is a much bigger gap than it looks: the whole timeline is
 * useless to anyone on pnpm.
 *
 * So this adapter reads what is installed and nothing else. It declares only
 * `detect` and `inventory`, so it cannot compile a contract or materialize
 * anything, and it reports the manager the project actually uses rather than
 * pretending to be npm. A pnpm user gets a real history; they still get an
 * honest "cannot repair this yet" when they ask for a rescue.
 *
 * It stands aside when npm owns the project, so nothing is counted twice.
 */

import { digestOf } from "@iwomc/contracts";
import { readInstalledDetail } from "./npm.js";
import type {
  AdapterContext,
  AdapterManifest,
  Detection,
  DeclaredState,
  EnvironmentAdapter,
  EvidenceBundle,
  CompileResult,
  CommandPlan,
  AdapterVerification,
  InventoryResult,
  MaterializationContext,
  ObservedEffect,
  ObservedProcess,
  PreflightResult,
  ProjectFiles,
} from "./types.js";
import type { ProposedFileChange } from "@iwomc/contracts";

const ADAPTER_ID = "node.observer";
const MANIFEST = "package.json";

/** Lockfiles that mean npm owns this project and this adapter should stand aside. */
const NPM_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"] as const;

/** The manager a project uses, told from the lockfile it commits. */
const MANAGER_LOCKFILES: readonly { readonly manager: string; readonly files: readonly string[] }[] = [
  { manager: "pnpm", files: ["pnpm-lock.yaml"] },
  { manager: "yarn", files: ["yarn.lock"] },
  { manager: "bun", files: ["bun.lockb", "bun.lock"] },
];

async function managerFor(files: ProjectFiles): Promise<string | null> {
  for (const entry of MANAGER_LOCKFILES) {
    for (const file of entry.files) {
      if (await files.exists(file)) return entry.manager;
    }
  }
  return null;
}

export const nodeObserverAdapter: EnvironmentAdapter = {
  manifest: {
    id: ADAPTER_ID,
    ecosystem: "node",
    manager: "pnpm/yarn/bun",
    // Not native: this cannot install anything. It only reads what is there,
    // which is what the package log needs and all it needs.
    support: "recipe",
    declaredFiles: [MANIFEST],
    capabilities: {
      detect: true,
      readDeclaredState: false,
      inventory: true,
      compile: false,
      materialize: false,
      verify: false,
    },
    conformanceTested: true,
    supportNote:
      "Reads installed packages so the package log and timeline work for pnpm, Yarn, and Bun projects. It cannot repair one: that needs those managers' own commands, which IWOMC does not run until it has been taught them.",
  } satisfies AdapterManifest,

  async detect(files: ProjectFiles): Promise<Detection> {
    if (!(await files.exists(MANIFEST))) {
      return { detected: false, signals: [], confidence: "high" };
    }
    for (const lockfile of NPM_LOCKFILES) {
      if (await files.exists(lockfile)) {
        // npm owns this one, and inventories it properly. Counting the same
        // packages twice would put every install in the log twice.
        return {
          detected: false,
          signals: [],
          confidence: "high",
          note: `${lockfile} is present, so the npm adapter owns this project.`,
        };
      }
    }

    const manager = await managerFor(files);
    if (manager === null) {
      return {
        detected: false,
        signals: [],
        confidence: "medium",
        note: "No pnpm, Yarn, or Bun lockfile, so there is nothing here npm does not already cover.",
      };
    }
    return {
      detected: true,
      signals: [MANIFEST],
      confidence: "high",
      note: `${manager} project: IWOMC records what is installed, and cannot repair it yet.`,
    };
  },

  async readDeclaredState(): Promise<DeclaredState> {
    // Deliberately empty. Reading what a project declares is the first half of
    // deciding what to install, and this adapter installs nothing - claiming a
    // declared state would invite a compiler to act on it.
    return {
      adapterId: ADAPTER_ID,
      files: [],
      runtimes: [],
      packages: [],
      systemTools: [],
      secrets: [],
      gaps: [],
    };
  },

  async inventory(ctx: AdapterContext): Promise<InventoryResult> {
    const manager = (await managerFor(ctx.files)) ?? "node";
    const detail = await readInstalledDetail(ctx.projectDir);
    if (detail === null) {
      return {
        adapterId: ADAPTER_ID,
        available: false,
        gaps: [
          {
            area: "node.observer.inventory",
            reason: `node_modules is not present, so ${manager} packages cannot be inventoried.`,
            remediation: `Run ${manager} install, then look again.`,
          },
        ],
      };
    }

    const entries = [...detail.versions.entries()]
      .map(([name, version]) => ({ name, version }))
      .sort((left, right) => (left.name < right.name ? -1 : 1));

    return {
      adapterId: ADAPTER_ID,
      available: true,
      ...(Object.keys(detail.constraints).length > 0 ? { platformConstraints: detail.constraints } : {}),
      snapshot: {
        adapterId: ADAPTER_ID,
        manager,
        takenAt: new Date().toISOString(),
        entryCount: entries.length,
        digest: digestOf(entries),
        entries,
      },
      gaps: [
        {
          area: "node.observer.repair",
          reason: `IWOMC records what ${manager} installed here, but cannot repair a ${manager} project yet.`,
          remediation: `Use npm for a project you want IWOMC to repair, or add a ${manager} adapter.`,
        },
      ],
    };
  },

  observeProcess(_process: ObservedProcess): ObservedEffect[] {
    return [];
  },

  async deriveObservedEffects(): Promise<ObservedEffect[]> {
    return [];
  },

  compile(_bundle: EvidenceBundle): CompileResult {
    return {
      adapterId: ADAPTER_ID,
      support: "observe_only",
      reason:
        "IWOMC can record what this project has installed, but repairing it needs its own package manager's commands, which IWOMC does not run until it has been taught them.",
      coverage: [],
      packages: [],
    };
  },

  async preflight(): Promise<PreflightResult> {
    return { adapterId: ADAPTER_ID, issues: [] };
  },

  planCommand(): CommandPlan | null {
    return null;
  },

  async verifyAfterMaterialize(_ctx: MaterializationContext): Promise<AdapterVerification> {
    return {
      adapterId: ADAPTER_ID,
      satisfied: false,
      checks: [
        {
          name: "materialization",
          passed: false,
          detail: "This adapter never materializes anything, so there is nothing to verify.",
        },
      ],
    };
  },

  async proposeRepair(): Promise<readonly ProposedFileChange[]> {
    return [];
  },
};

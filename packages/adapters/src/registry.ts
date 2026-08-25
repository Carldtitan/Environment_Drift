import type { SupportLevel } from "@iwomc/contracts";
import type { EnvironmentAdapter, ProjectFiles } from "./types.js";
import { npmAdapter } from "./npm.js";
import { pipAdapter, uvAdapter } from "./python.js";
import { genericAdapter } from "./generic.js";
import { nodeAltAdapters } from "./node-alt.js";

/**
 * Ecosystem recognition table (R11.3).
 *
 * Recognition is NOT support. Every entry states what IWOMC can actually do
 * today, and every probe is a filename check - looking at a project never
 * executes a command.
 */
export interface EcosystemProbe {
  readonly id: string;
  readonly ecosystem: string;
  readonly manager: string;
  /** Files whose presence indicates this manager owns (part of) the project. */
  readonly files: readonly string[];
  readonly support: SupportLevel;
  /** Shown verbatim in the CLI, MCP tool output, and the console. */
  readonly note: string;
}

/**
 * `native`      - IWOMC compiles, materializes, and verifies this itself.
 * `recipe`      - IWOMC can propose a setup command, but a human must review it
 *                 before rescue may run it.
 * `observe_only`- IWOMC records evidence but will not change this state. Global
 *                 and system-wide managers stay here deliberately: rescue must
 *                 never silently modify a machine outside the project.
 */
export const ECOSYSTEM_PROBES: readonly EcosystemProbe[] = [
  // Node
  {
    id: "node.npm",
    ecosystem: "node",
    manager: "npm",
    files: ["package-lock.json", "npm-shrinkwrap.json", "package.json"],
    support: "native",
    note: "Full loop: declared state, inventory, project-local install, verification.",
  },
  {
    id: "node.pnpm",
    ecosystem: "node",
    manager: "pnpm",
    files: ["pnpm-lock.yaml", "pnpm-workspace.yaml"],
    support: "native",
    note: "Recognised from its lockfile. Rescue needs a reviewed `pnpm install --frozen-lockfile` recipe.",
  },
  {
    id: "node.yarn",
    ecosystem: "node",
    manager: "yarn",
    files: ["yarn.lock", ".yarnrc.yml"],
    support: "native",
    note: "Recognised from its lockfile. Rescue needs a reviewed `yarn install --immutable` recipe.",
  },
  {
    id: "node.bun",
    ecosystem: "node",
    manager: "bun",
    files: ["bun.lockb", "bun.lock", "bunfig.toml"],
    support: "native",
    note: "Recognised from its lockfile. Rescue needs a reviewed `bun install --frozen-lockfile` recipe.",
  },
  // Python
  {
    id: "python.pip",
    ecosystem: "python",
    manager: "pip",
    files: ["requirements.txt", "requirements-dev.txt", "setup.py", "setup.cfg"],
    support: "native",
    note: "Full loop: declared state, project-local .venv, install, verification.",
  },
  {
    id: "python.uv",
    ecosystem: "python",
    manager: "uv",
    files: ["uv.lock"],
    support: "native",
    note: "Full loop: locked sync into a project-local .venv, then verification.",
  },
  {
    id: "python.poetry",
    ecosystem: "python",
    manager: "poetry",
    files: ["poetry.lock"],
    support: "recipe",
    note: "Recognised from poetry.lock. Rescue needs a reviewed `poetry install` recipe.",
  },
  {
    id: "python.conda",
    ecosystem: "python",
    manager: "conda",
    files: ["environment.yml", "environment.yaml"],
    support: "observe_only",
    note: "Conda environments live outside the project directory; IWOMC records the requirement but will not create one.",
  },
  // Compiled and JVM ecosystems
  {
    id: "rust.cargo",
    ecosystem: "rust",
    manager: "cargo",
    files: ["Cargo.toml", "Cargo.lock"],
    support: "recipe",
    note: "Recognised from Cargo.toml. Rescue needs a reviewed `cargo fetch`/`cargo build` recipe.",
  },
  {
    id: "go.modules",
    ecosystem: "go",
    manager: "go",
    files: ["go.mod", "go.sum"],
    support: "recipe",
    note: "Recognised from go.mod. Rescue needs a reviewed `go mod download` recipe.",
  },
  {
    id: "jvm.maven",
    ecosystem: "jvm",
    manager: "maven",
    files: ["pom.xml"],
    support: "recipe",
    note: "Recognised from pom.xml. Rescue needs a reviewed Maven recipe.",
  },
  {
    id: "jvm.gradle",
    ecosystem: "jvm",
    manager: "gradle",
    files: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    support: "recipe",
    note: "Recognised from the Gradle build files. Rescue needs a reviewed Gradle recipe.",
  },
  {
    id: "dotnet.nuget",
    ecosystem: "dotnet",
    manager: "nuget",
    files: ["packages.config", "nuget.config", "Directory.Packages.props"],
    support: "recipe",
    note: "Recognised from NuGet configuration. Rescue needs a reviewed `dotnet restore` recipe.",
  },
  {
    id: "ruby.bundler",
    ecosystem: "ruby",
    manager: "bundler",
    files: ["Gemfile", "Gemfile.lock"],
    support: "recipe",
    note: "Recognised from the Gemfile. Rescue needs a reviewed `bundle install --deployment` recipe.",
  },
  {
    id: "php.composer",
    ecosystem: "php",
    manager: "composer",
    files: ["composer.json", "composer.lock"],
    support: "recipe",
    note: "Recognised from composer.json. Rescue needs a reviewed `composer install` recipe.",
  },
  {
    id: "dart.pub",
    ecosystem: "dart",
    manager: "pub",
    files: ["pubspec.yaml", "pubspec.lock"],
    support: "recipe",
    note: "Recognised from pubspec.yaml. Rescue needs a reviewed `dart pub get` recipe.",
  },
  {
    id: "elixir.mix",
    ecosystem: "elixir",
    manager: "mix",
    files: ["mix.exs", "mix.lock"],
    support: "recipe",
    note: "Recognised from mix.exs. Rescue needs a reviewed `mix deps.get` recipe.",
  },
  // C/C++
  {
    id: "cpp.vcpkg",
    ecosystem: "cpp",
    manager: "vcpkg",
    files: ["vcpkg.json", "vcpkg-configuration.json"],
    support: "observe_only",
    note: "Recognised from vcpkg.json. Toolchain placement is machine-wide, so IWOMC records it rather than changing it.",
  },
  {
    id: "cpp.conan",
    ecosystem: "cpp",
    manager: "conan",
    files: ["conanfile.txt", "conanfile.py"],
    support: "observe_only",
    note: "Recognised from the conanfile. Profiles are machine-wide, so IWOMC records the requirement rather than changing it.",
  },
  // System package managers - deliberately observe-only
  {
    id: "system.homebrew",
    ecosystem: "system",
    manager: "homebrew",
    files: ["Brewfile", "Brewfile.lock.json"],
    support: "observe_only",
    note: "System-wide. IWOMC reports which formulae the project needs; it will not install them for you.",
  },
  {
    id: "system.apt",
    ecosystem: "system",
    manager: "apt",
    files: ["Aptfile", "apt-packages.txt"],
    support: "observe_only",
    note: "System-wide. IWOMC reports the required packages; installing them stays a deliberate human action.",
  },
  {
    id: "system.chocolatey",
    ecosystem: "system",
    manager: "chocolatey",
    files: ["packages.config.choco", "chocolatey.config"],
    support: "observe_only",
    note: "System-wide. IWOMC reports the required packages; it will not change machine state.",
  },
  {
    id: "system.winget",
    ecosystem: "system",
    manager: "winget",
    files: ["winget.json", "configuration.dsc.yaml"],
    support: "observe_only",
    note: "System-wide. IWOMC reports the required packages; it will not change machine state.",
  },
  // Runtime version managers - recognised so a missing runtime is explainable
  {
    id: "runtime.asdf",
    ecosystem: "runtime",
    manager: "asdf",
    files: [".tool-versions"],
    support: "observe_only",
    note: "Read as a runtime pin. IWOMC checks whether the pinned runtime is present; it does not install toolchains globally.",
  },
  {
    id: "runtime.mise",
    ecosystem: "runtime",
    manager: "mise",
    files: [".mise.toml", "mise.toml", ".mise/config.toml"],
    support: "observe_only",
    note: "Read as a runtime pin. IWOMC checks whether the pinned runtime is present; it does not install toolchains globally.",
  },
  {
    id: "runtime.volta",
    ecosystem: "runtime",
    manager: "volta",
    files: ["package.json#volta"],
    support: "observe_only",
    note: "Read from package.json's volta block as a runtime pin, not as an installer.",
  },
  {
    id: "runtime.sdkman",
    ecosystem: "runtime",
    manager: "sdkman",
    files: [".sdkmanrc"],
    support: "observe_only",
    note: "Read as a JVM toolchain pin. IWOMC checks presence; it does not install SDKs globally.",
  },
  {
    id: "runtime.nvm",
    ecosystem: "runtime",
    manager: "nvm",
    files: [".nvmrc"],
    support: "observe_only",
    note: "Read as a Node version pin. IWOMC checks presence; it does not switch your shell's Node version.",
  },
];

export interface Recognition {
  readonly probe: EcosystemProbe;
  readonly signals: readonly string[];
}

/**
 * File-shaped recognition only. This never spawns a process, so it is safe to
 * run against an arbitrary directory (R11.3).
 */
export async function recognizeEcosystems(files: ProjectFiles): Promise<Recognition[]> {
  const out: Recognition[] = [];
  for (const probe of ECOSYSTEM_PROBES) {
    const signals: string[] = [];
    for (const file of probe.files) {
      const [path, fragment] = file.split("#");
      if (path === undefined) continue;
      if (!(await files.exists(path))) continue;
      if (fragment) {
        const body = await files.read(path);
        if (body === null) continue;
        try {
          const parsed: unknown = JSON.parse(body);
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            !(fragment in (parsed as Record<string, unknown>))
          ) {
            continue;
          }
        } catch {
          continue;
        }
      }
      signals.push(file);
    }
    if (signals.length > 0) out.push({ probe, signals });
  }
  return out;
}

export class AdapterRegistry {
  readonly #adapters: readonly EnvironmentAdapter[];

  constructor(adapters: readonly EnvironmentAdapter[]) {
    this.#adapters = adapters;
  }

  get all(): readonly EnvironmentAdapter[] {
    return this.#adapters;
  }

  byId(id: string): EnvironmentAdapter | undefined {
    return this.#adapters.find((adapter) => adapter.manifest.id === id);
  }

  /** Adapters whose own detection says they own this project. */
  async detectAll(files: ProjectFiles): Promise<EnvironmentAdapter[]> {
    const detected: EnvironmentAdapter[] = [];
    for (const adapter of this.#adapters) {
      const detection = await adapter.detect(files);
      if (detection.detected) detected.push(adapter);
    }
    return detected;
  }

  /**
   * The truthful support level for a project: the best level any *detected*
   * native adapter offers, otherwise what recognition alone can promise.
   */
  async supportLevelFor(files: ProjectFiles): Promise<{
    support: SupportLevel;
    reason: string;
    recognized: Recognition[];
  }> {
    const recognized = await recognizeEcosystems(files);
    const detected = await this.detectAll(files);
    const native = detected.filter((adapter) => adapter.manifest.support === "native");
    if (native.length > 0) {
      return {
        support: "native",
        reason: `Natively supported by ${native.map((a) => a.manifest.id).join(", ")}.`,
        recognized,
      };
    }
    if (recognized.some((entry) => entry.probe.support === "recipe")) {
      const names = recognized
        .filter((entry) => entry.probe.support === "recipe")
        .map((entry) => entry.probe.manager);
      return {
        support: "recipe",
        reason: `${names.join(", ")} recognised, but rescue needs a reviewed setup recipe before it may run anything.`,
        recognized,
      };
    }
    if (recognized.length > 0) {
      return {
        support: "observe_only",
        reason: `${recognized.map((entry) => entry.probe.manager).join(", ")} recognised, but IWOMC will not change state it does not own.`,
        recognized,
      };
    }
    return {
      support: "observe_only",
      reason: "No ecosystem IWOMC recognises was found in this project.",
      recognized,
    };
  }
}

export function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry([npmAdapter, uvAdapter, pipAdapter, ...nodeAltAdapters, genericAdapter]);
}

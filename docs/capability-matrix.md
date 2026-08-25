# Capability matrix

Generated from adapter metadata by `pnpm run capability-matrix`. Do not edit by hand.

Recognising a package manager is not the same as supporting it. This table states
what this build can actually do for each one.

| Ecosystem | Manager | Support | Detected from | Note |
| --- | --- | --- | --- | --- |
| node | npm | **native** - IWOMC compiles, materializes, and verifies this itself | `package-lock.json`, `npm-shrinkwrap.json`, `package.json` | Full loop: declared state, inventory, project-local install, verification. |
| node | pnpm | **native** - IWOMC compiles, materializes, and verifies this itself | `pnpm-lock.yaml`, `pnpm-workspace.yaml` | Recognised from its lockfile. Rescue needs a reviewed `pnpm install --frozen-lockfile` recipe. |
| node | yarn | **native** - IWOMC compiles, materializes, and verifies this itself | `yarn.lock`, `.yarnrc.yml` | Recognised from its lockfile. Rescue needs a reviewed `yarn install --immutable` recipe. |
| node | bun | **native** - IWOMC compiles, materializes, and verifies this itself | `bun.lockb`, `bun.lock`, `bunfig.toml` | Recognised from its lockfile. Rescue needs a reviewed `bun install --frozen-lockfile` recipe. |
| python | pip | **native** - IWOMC compiles, materializes, and verifies this itself | `requirements.txt`, `requirements-dev.txt`, `setup.py`, `setup.cfg` | Full loop: declared state, project-local .venv, install, verification. |
| python | uv | **native** - IWOMC compiles, materializes, and verifies this itself | `uv.lock` | Full loop: locked sync into a project-local .venv, then verification. |
| python | poetry | **native** - IWOMC compiles, materializes, and verifies this itself | `poetry.lock` | Recognised from poetry.lock. Rescue needs a reviewed `poetry install` recipe. |
| python | conda | **observe only** - recorded, never changed by IWOMC | `environment.yml`, `environment.yaml` | Conda environments live outside the project directory; IWOMC records the requirement but will not create one. |
| rust | cargo | **recipe** - recognised; rescue needs a reviewed setup command | `Cargo.toml`, `Cargo.lock` | Recognised from Cargo.toml. Rescue needs a reviewed `cargo fetch`/`cargo build` recipe. |
| go | go | **recipe** - recognised; rescue needs a reviewed setup command | `go.mod`, `go.sum` | Recognised from go.mod. Rescue needs a reviewed `go mod download` recipe. |
| jvm | maven | **recipe** - recognised; rescue needs a reviewed setup command | `pom.xml` | Recognised from pom.xml. Rescue needs a reviewed Maven recipe. |
| jvm | gradle | **recipe** - recognised; rescue needs a reviewed setup command | `build.gradle`, `build.gradle.kts`, `settings.gradle`, `settings.gradle.kts` | Recognised from the Gradle build files. Rescue needs a reviewed Gradle recipe. |
| dotnet | nuget | **recipe** - recognised; rescue needs a reviewed setup command | `packages.config`, `nuget.config`, `Directory.Packages.props` | Recognised from NuGet configuration. Rescue needs a reviewed `dotnet restore` recipe. |
| ruby | bundler | **recipe** - recognised; rescue needs a reviewed setup command | `Gemfile`, `Gemfile.lock` | Recognised from the Gemfile. Rescue needs a reviewed `bundle install --deployment` recipe. |
| php | composer | **recipe** - recognised; rescue needs a reviewed setup command | `composer.json`, `composer.lock` | Recognised from composer.json. Rescue needs a reviewed `composer install` recipe. |
| dart | pub | **recipe** - recognised; rescue needs a reviewed setup command | `pubspec.yaml`, `pubspec.lock` | Recognised from pubspec.yaml. Rescue needs a reviewed `dart pub get` recipe. |
| elixir | mix | **recipe** - recognised; rescue needs a reviewed setup command | `mix.exs`, `mix.lock` | Recognised from mix.exs. Rescue needs a reviewed `mix deps.get` recipe. |
| cpp | vcpkg | **observe only** - recorded, never changed by IWOMC | `vcpkg.json`, `vcpkg-configuration.json` | Recognised from vcpkg.json. Toolchain placement is machine-wide, so IWOMC records it rather than changing it. |
| cpp | conan | **observe only** - recorded, never changed by IWOMC | `conanfile.txt`, `conanfile.py` | Recognised from the conanfile. Profiles are machine-wide, so IWOMC records the requirement rather than changing it. |
| system | homebrew | **observe only** - recorded, never changed by IWOMC | `Brewfile`, `Brewfile.lock.json` | System-wide. IWOMC reports which formulae the project needs; it will not install them for you. |
| system | apt | **observe only** - recorded, never changed by IWOMC | `Aptfile`, `apt-packages.txt` | System-wide. IWOMC reports the required packages; installing them stays a deliberate human action. |
| system | chocolatey | **observe only** - recorded, never changed by IWOMC | `packages.config.choco`, `chocolatey.config` | System-wide. IWOMC reports the required packages; it will not change machine state. |
| system | winget | **observe only** - recorded, never changed by IWOMC | `winget.json`, `configuration.dsc.yaml` | System-wide. IWOMC reports the required packages; it will not change machine state. |
| runtime | asdf | **observe only** - recorded, never changed by IWOMC | `.tool-versions` | Read as a runtime pin. IWOMC checks whether the pinned runtime is present; it does not install toolchains globally. |
| runtime | mise | **observe only** - recorded, never changed by IWOMC | `.mise.toml`, `mise.toml`, `.mise/config.toml` | Read as a runtime pin. IWOMC checks whether the pinned runtime is present; it does not install toolchains globally. |
| runtime | volta | **observe only** - recorded, never changed by IWOMC | `package.json#volta` | Read from package.json's volta block as a runtime pin, not as an installer. |
| runtime | sdkman | **observe only** - recorded, never changed by IWOMC | `.sdkmanrc` | Read as a JVM toolchain pin. IWOMC checks presence; it does not install SDKs globally. |
| runtime | nvm | **observe only** - recorded, never changed by IWOMC | `.nvmrc` | Read as a Node version pin. IWOMC checks presence; it does not switch your shell's Node version. |

## What each native adapter implements

| Adapter | detect | declared state | inventory | compile | materialize | verify | conformance test |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `node.npm` | yes | yes | yes | yes | yes | yes | yes |
| `python.uv` | yes | yes | yes | yes | yes | yes | yes |
| `python.poetry` | yes | yes | yes | yes | yes | yes | yes |
| `python.pip` | yes | yes | yes | yes | yes | yes | yes |
| `node.pnpm` | yes | yes | yes | yes | yes | yes | yes |
| `node.yarn` | yes | yes | yes | yes | yes | yes | yes |
| `node.bun` | yes | yes | yes | yes | yes | yes | yes |
| `generic.recipe` | yes | no | no | yes | yes | no | yes |

## Why some managers are deliberately observe-only

A rescue must never silently change machine-wide state. System package managers,
global toolchain managers, and runtime version managers therefore stay observe-only:
IWOMC reports what a project needs from them and blocks with that name when it is
missing, rather than installing it for you.

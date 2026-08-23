# IWOMC Rescue

**A teammate pulls agent-written code and it does not run. IWOMC applies an
approved environment contract captured from a checkout where it *did* run, then
proves the result with the project's own command.**

```
iwomc capture    # on a checkout that works
iwomc rescue     # on a checkout that does not
```

Docker runs the setup a developer wrote down. IWOMC finds the setup an agent
actually used and the repository forgot to write down, and proves a repair.

---

## The 60-second version

```bash
# On the machine where the project works
cd path/to/working/checkout
iwomc init --proof "npm test"     # what "working" means for this project
iwomc capture                     # evidence + a signed contract for this revision
iwomc verify                      # apply it in a fresh directory and prove it

# On the machine where it does not
cd path/to/broken/checkout
iwomc init
iwomc rescue                      # -> working | blocked | failed | unsupported | inconclusive
```

`rescue` prints `working` only when the proof command passes. Installing is not
success.

---

## Install

Requires **Node 22.5 or newer** (for `node:sqlite`) and **Git** on `PATH`.

```bash
pnpm install
pnpm run build          # the CLI, Companion, adapters, control plane
pnpm run build:console  # the hosted Rescue Console
```

Then either run it in place:

```bash
node apps/cli/dist/bin.js status
```

or put it on your `PATH`:

```bash
pnpm --dir apps/cli link --global   # provides `iwomc`
```

Nothing else is required. There is no Docker image, no daemon to install, and no
account to create.

---

## What it actually does

### `iwomc capture` — on a checkout that works

Reads the project's declared state (manifests, lockfiles, runtime pins) and
inventories what is actually installed **project-locally**, without running a
single package-manager command. Anything installed here that the repository
does not declare, and that no declared dependency requires, is recorded as
observed evidence.

It produces:

- a **receipt** — immutable evidence bound to one Git revision, with every item
  labelled `observed`, `declared`, `derived`, or `unavailable`;
- a **contract** — a signed, content-addressed materialization plan made of
  typed steps, plus the proof command;
- a **coverage report** — what capture could *not* see, so absence is never
  mistaken for evidence of absence.

### `iwomc verify` — prove the contract from nothing

Clones the repository into a temporary directory, checks out the exact revision,
applies the contract, and runs the proof command there. A directory that has
never had a `node_modules`, a `.venv`, or a `.env`.

- Passing locally → the contract becomes **locally checked**.
- Passing in a disposable Modal sandbox → **clean verified**.
- Nothing else earns either label.

### `iwomc rescue` — on a checkout that does not work

1. Confirms this checkout is the registered project, at the contract's exact
   revision, on a target platform the contract names.
2. Verifies the contract's signature and content digest. A modified contract
   stops everything and writes a security audit event.
3. Preflights disk space, runtimes, system tools, and **secret names**.
4. Applies typed steps into project-local state only, journalling each one.
5. Runs the proof command.

It returns exactly one of `working`, `blocked`, `failed`, `unsupported`, or
`inconclusive` — with a machine-readable blocker code and one concrete next
action.

### `iwomc promote` — put it back in the repository

A rescue makes *this* checkout work. Promote turns what it needed into an
ordinary reviewable file diff, so the *next* developer does not need a rescue at
all. It writes nothing without `--apply`.

---

## Guarantees

| Guarantee | How it is enforced |
| --- | --- |
| `working` requires a passing proof command | Only `runProof` can produce it (`packages/companion/src/proof.ts`) |
| Rescue never edits a tracked file | Writes are confined to `.iwomc/`; tracked-file digests are compared before and after; `npm install --no-save` for overlays |
| No secret value ever travels | Contracts carry names and optional vault references; every outbound payload passes a fail-closed redactor |
| No shell, ever | Commands are argv arrays; the tokenizer refuses shell operators; `shell: true` appears nowhere |
| Support levels are truthful | An ecosystem is `native` only when an adapter implements the whole loop *and* has a conformance test; the capability matrix is generated from that metadata |
| An integration is `connected` only after a live check | Configuration presence never sets a status |

---

## Surfaces

### Command line

`init` · `status` · `capture` · `verify` · `rescue` · `promote` · `approve` ·
`doctor` · `login` · `join` · `serve` · `mcp` · `agent-docs`

Every command takes `--json` and returns a structured result. Exit codes are
part of the contract: `0` ok, `1` failed, `2` blocked, `3` unsupported, `4`
inconclusive, `64` usage.

### MCP server (for coding agents)

```bash
iwomc mcp        # JSON-RPC 2.0 over stdio
```

Tools: `environment_status`, `diagnose_environment`, `capture_environment`,
`verify_contract`, `rescue_environment`, `promote_repair`. Mutating tools refuse
to run without `confirm: true`. The server publishes its own versioned workflow
documentation as an MCP resource, so an agent can discover the flow without a
hand-written prompt.

### Rescue Console (hosted)

```bash
iwomc serve
```

Starts the control plane and the console, enrolls this device, and prints a link
carrying a one-time session token. The browser talks only to the HTTP API: a
console action becomes a signed, expiring job addressed to a device **by id** —
the browser never sends a filesystem path and never speaks MCP.

---

## Ecosystem support

Native today: **npm**, **pip**, **uv** — detection, declared state, inventory,
project-local materialization, and verification, each with a conformance test.

Recognised with a truthful support level: pnpm, Yarn, Bun, Poetry, Conda, Cargo,
Go modules, Maven, Gradle, NuGet, Bundler, Composer, pub, Mix, vcpkg, Conan,
Homebrew, apt, Chocolatey, winget, asdf, mise, Volta, SDKMAN, nvm.

Recognition is not support. See [docs/capability-matrix.md](docs/capability-matrix.md),
which is generated from adapter metadata and cannot claim more than the code does.

---

## Documentation

| Guide | For |
| --- | --- |
| [docs/agent-workflow.md](docs/agent-workflow.md) | Coding agents driving IWOMC |
| [docs/project-author.md](docs/project-author.md) | Setting a project up so teammates can be rescued |
| [docs/team-admin.md](docs/team-admin.md) | Workspaces, invitations, devices, revocation |
| [docs/adapters.md](docs/adapters.md) | Writing an ecosystem adapter |
| [docs/security.md](docs/security.md) | Trust boundaries, redaction, signatures, audit |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Every blocker code and what to do |
| [docs/capability-matrix.md](docs/capability-matrix.md) | Generated ecosystem support |
| [docs/traceability.md](docs/traceability.md) | Requirement → module → test |
| [DESIGN.md](DESIGN.md) | The Rescue Console design system |

---

## Verify the build

```bash
pnpm run verify
```

Builds everything, checks requirement traceability, scans the repository with
the product's own redaction classifier, confirms the capability matrix matches
the code, and runs the full test suite — including a real two-checkout
capture-to-rescue flow and a real browser driving the console.

---

## What is honestly unavailable here

No GitHub App, Postgres, or object-store credentials are provisioned in this
build. Each is implemented behind its interface with configuration validation
and an explicit unavailable state, and each has tests. None is replaced by a
mock that could read as connected. `iwomc doctor` names exactly which value is
missing for each.

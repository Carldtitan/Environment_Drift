# IWOMC Rescue

**Published on npm:** [`iwomc@0.1.3`](https://www.npmjs.com/package/iwomc)

IWOMC Rescue makes a teammate's broken checkout run from a verified environment contract.

It solves one failure:

> The code was pushed. The setup that made it work was not.

## Install

```bash
npm install -g iwomc
iwomc --help
```

Requires Node 22.5+ and Git.

## How it works

### 1. Capture a working checkout

```bash
iwomc init --proof "npm test"
iwomc capture
```

IWOMC reads the repository's declared setup and compares it with the project-local setup that actually exists.

It records:

- manifests, lockfiles, and runtime pins
- project-local installed packages
- undeclared packages and version drift
- the exact Git revision
- one proof command that defines "working"

It produces a signed environment contract for that revision.

### 2. Verify before sharing

```bash
iwomc verify
```

IWOMC creates a fresh checkout, applies the contract, and runs the proof command. A contract is not called verified until that command passes.

### 3. Rescue a teammate's checkout

```bash
iwomc rescue --approve
```

IWOMC checks the revision and contract signature, applies only approved project-local setup, and runs the same proof command.

It returns one honest result:

`working` · `blocked` · `failed` · `unsupported` · `inconclusive`

### 4. Fix the repository permanently

```bash
iwomc promote
```

`promote` creates a reviewable manifest diff. The team can add the missing dependency or pin, so the next checkout works without rescue.

## What makes it different

| Tool | Job |
| --- | --- |
| Git | Shares code |
| Docker | Runs the setup written in a Dockerfile |
| Greptile | Reviews and understands code |
| Claude-Mem | Remembers agent actions and context |
| **IWOMC** | Proves the setup needed for this revision works in a clean checkout |

Docker is useful. IWOMC does not replace it. Docker runs a complete recipe. IWOMC finds project-local setup that was used but not declared, then gives the team a verified path to fix it.

## Claude-Mem

IWOMC uses Claude-Mem as a redacted, cross-session memory layer.

It records these lifecycle events through Claude-Mem's documented local worker API:

- capture
- environment drift
- verification
- rescue outcome
- promoted repair

This helps an agent remember prior environment failures and repairs. Claude-Mem never decides whether an environment works. IWOMC proves that by running the project's own command. Secret values are never sent to Claude-Mem.

## Supported ecosystems

| Ecosystem | Capture | Rescue | Verify |
| --- | :---: | :---: | :---: |
| npm | Yes | Yes | Yes |
| pip | Yes | Yes | Yes |
| uv | Yes | Yes | Yes |

pnpm, Yarn, Bun, Poetry, Conda, Cargo, Go modules, Maven, Gradle, NuGet, Bundler, Composer, pub, Mix, and common system package managers are recognised. They are not claimed as native rescue support yet.

See the full [capability matrix](docs/capability-matrix.md).

## Safety

- Only writes project-local state such as `node_modules`, `.venv`, and `.iwomc`
- Never edits tracked files during rescue
- Never installs global packages or changes PATH
- Never copies secret values between devices
- Names missing secrets and stops before the proof command
- Binds every contract to a Git revision and verifies signatures before rescue

## Team use

Code stays in Git. IWOMC shares the signed environment contract.

1. The owner opens the [Rescue Console](https://iwomc-web-production.up.railway.app).
2. A teammate joins with an invitation.
3. The working device captures and verifies a contract.
4. The teammate's device downloads the exact contract and runs rescue.
5. The console shows drift, contracts, rescue runs, and audit events.

## Package documentation

| Need | Documentation |
| --- | --- |
| Create and verify a contract | [Project author guide](docs/project-author.md) |
| Use with Codex or another coding agent | [Agent and MCP workflow](docs/agent-workflow.md) |
| Invite and manage teammates | [Team administration](docs/team-admin.md) |
| Understand security boundaries | [Security model](docs/security.md) |
| Diagnose a failed rescue | [Troubleshooting](docs/troubleshooting.md) |

The installed package also includes command documentation:

```bash
iwomc agent-docs
```

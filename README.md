# IWOMC Rescue

## The problem

Your teammate clones the same commit you just pushed. The app fails before the demo. It worked on your computer ten minutes ago.

The code is the same. The environment is not.

This is getting worse with coding agents. An agent can install a package, use a runtime version, or create project-local setup while it works. The agent commits the code. The package, version, or setup step never enters the repository.

Git shares source code. It does not prove that a fresh checkout can run it.

The cost is not an abstract "environment issue." It is the last ten minutes of a hackathon, a blocked teammate, or a deployment that passed on the builder's machine and nowhere else.

## Why the obvious tools are not enough

**Docker is useful.** It solves this when the Dockerfile is complete and current. But Docker runs the recipe that was written down. It cannot discover that an agent used Node 22, installed a package locally, or relied on a tool that was never added to that recipe. It will faithfully reproduce an incomplete recipe.

**Greptile is useful.** It helps teams understand and review code. A code review cannot prove which packages, versions, and local setup made that code run on another computer.

**Claude-Mem is useful.** It remembers what an agent did and why. Memory can point to a likely missing step. It cannot prove that a clean checkout now works.

## The answer

**IWOMC Rescue finds the setup that made a revision work, gives the matching broken checkout an approved project-local repair, and proves the result with the project's own command.**

## Install

**Published on npm:** [`iwomc@0.1.3`](https://www.npmjs.com/package/iwomc)

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

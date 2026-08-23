# IWOMC Rescue

**Live team dashboard:** [iwomc-web-production.up.railway.app](https://iwomc-web-production.up.railway.app/)

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

## What IWOMC is

IWOMC is a package that checks whether a repository describes the packages its app actually needs.

Here is the exact failure it fixes:

1. A coding agent runs `npm install nanoid` on Alice's computer.
2. The app imports `nanoid` and works because Alice has it in `node_modules`.
3. The agent forgets to add `nanoid` to `package.json`.
4. Bob clones the code and runs `npm install`.
5. Bob's app fails because `npm install` only installs what `package.json` declares.

On Alice's working checkout, IWOMC compares `package.json`, the lockfile, runtime pins, and `node_modules`. It sees that `nanoid` is installed but not declared. It saves that fact in a signed contract for Alice's exact Git commit.

On Bob's broken checkout, Bob runs `iwomc rescue`. IWOMC checks that Bob has the same commit, installs the approved missing package inside Bob's project, then runs the project's own test, build, or smoke command.

If that command passes, IWOMC says `working`. It can then create a normal `package.json` change for review, so the missing package is fixed for everyone.

It does not copy an entire computer. It does not install global tools. Today it handles this project-level package problem natively for npm, pip, and uv.

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

1. The owner opens the Rescue Console above.
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

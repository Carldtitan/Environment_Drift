# IWOMC Rescue

[Open the live team dashboard](https://iwomc-web-production.up.railway.app/)

## The problem

Your teammate clones the same commit you just pushed. Their app fails. It worked on your computer.

This happens when a coding agent makes a local setup change that never reaches Git. It may install a package, use a different runtime version, or create project-local state. The code is shared, but the setup that made it work is not.

## What IWOMC does

IWOMC is a CLI package for this exact handoff failure.

For example, an agent installs `nanoid` on Alice's computer. Alice's app works because `nanoid` is in `node_modules`. The agent forgets to add it to `package.json`. Bob clones the repository and his app fails because `npm install` does not install `nanoid`.

On Alice's checkout, IWOMC compares the repository files with the project-local packages that actually exist. It creates a signed record for that exact Git revision.

On Bob's checkout, IWOMC verifies that record, applies the approved project-local repair, and runs the project's real test, build, or smoke command. It says `working` only when that command passes.

IWOMC can then propose a normal manifest change for review. That prevents the same failure for the next developer.

## Why existing tools do not solve this alone

Docker is useful when its Dockerfile is complete and current. Docker cannot discover a local step that an agent used but never wrote into the Dockerfile.

Greptile is useful for understanding and reviewing code. Code review does not prove which packages and versions made that code run on another computer.

Claude-Mem is useful for remembering agent activity. IWOMC uses its redacted history as context, but it never treats memory as proof. The proof is the project's own command passing in the rescued checkout.

## Install and use

`iwomc@0.1.3` is published on [npm](https://www.npmjs.com/package/iwomc).

```bash
npm install -g iwomc
```

On the checkout that works, run:

```bash
iwomc init --proof "npm test"
iwomc capture
iwomc verify
```

On the matching checkout that fails, run:

```bash
iwomc rescue --approve
iwomc promote
```

`verify` checks a fresh checkout before the contract is shared. `rescue` repairs only project-local state. `promote` creates a reviewable repository change.

## Support and safety

IWOMC natively captures, rescues, and verifies npm, pip, and uv projects. It recognises pnpm, Yarn, Bun, Poetry, Conda, Cargo, Go modules, Maven, Gradle, NuGet, Bundler, Composer, pub, Mix, and common system package managers. It does not claim native rescue support for those ecosystems yet.

IWOMC never edits tracked files during rescue. It does not install global packages or change PATH. It never copies secret values between devices. It names a missing secret and stops before the proof command.

## Claude-Mem

IWOMC records redacted capture, drift, verification, rescue, and promotion events through the Claude-Mem local worker API. This helps a future coding session understand a prior environment failure without exposing secret values.

## Documentation

Read the [project author guide](docs/project-author.md) to create a contract. Read the [agent and MCP workflow](docs/agent-workflow.md) to use IWOMC with Codex or another coding agent. Read [team administration](docs/team-admin.md), the [capability matrix](docs/capability-matrix.md), [security model](docs/security.md), and [troubleshooting guide](docs/troubleshooting.md) for the remaining details.

The installed package also contains command documentation. Run `iwomc agent-docs` to read it.

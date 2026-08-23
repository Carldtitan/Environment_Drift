# IWOMC Rescue

> A project works on one developer's computer and fails on another because the code was shared, but part of the setup was not.

**IWOMC Rescue captures a verified setup contract from a working checkout, rescues a matching broken checkout, and proves the result with the project's own command.**

## The problem

Coding agents change more than source code. They install packages, use runtime versions, and create project-local state. Some of that state is not declared in the repository.

That creates the most painful kind of handoff:

1. Developer A gets the app working.
2. Developer A pushes the code.
3. Developer B clones the same revision.
4. The app fails on B's machine.

Git shared the code. It did not prove that the environment was complete.

## What IWOMC does

```text
Working checkout                 Broken checkout
---------------                  ----------------
capture real setup     ->        rescue project-local setup
create signed contract ->        run the same proof command
record drift           ->        report working only if it passes
```

```bash
# Developer A: this checkout works.
iwomc init --proof "npm test"
iwomc capture

# Developer B: same Git revision, but it does not run.
iwomc init --proof "npm test"
iwomc rescue --approve
```

`working` means the proof command passed. A successful install alone is not a success state.

## Why existing tools do not close this gap

| Tool | Valuable for | What it does not prove |
| --- | --- | --- |
| Git | Sharing source code | The code runs in a clean checkout |
| Docker | Reproducing a complete written recipe | An agent used a setup step that was never added to the Dockerfile |
| Greptile | Understanding and reviewing code | The exact environment that ran on another developer's machine |
| Claude-Mem | Remembering agent activity and decisions | A deterministic, verified environment contract |

Docker is still good engineering. IWOMC is not a Docker replacement. Docker runs the recipe that exists. IWOMC detects project-local setup that actually worked but the repository did not declare, then gives the team a path to correct the repository.

## Claude-Mem integration

Claude-Mem is used as the memory layer, not as the source of truth.

IWOMC writes **redacted lifecycle observations** to the documented local Claude-Mem worker API for:

- capture
- declared versus observed drift
- verification
- rescue result
- promoted repository repair

This gives a future agent relevant context such as: "a prior rescue found an undeclared npm package for this revision." IWOMC still verifies the machine itself and runs the proof command. It never treats memory as proof, and it never sends secret values to Claude-Mem.

## What is supported now

| Capability | Status |
| --- | --- |
| npm projects | Native capture, rescue, and verification |
| pip projects | Native capture, rescue, and verification |
| uv projects | Native capture, rescue, and verification |
| Fresh local verification | Clones the exact revision into a new directory and runs the proof command |
| Modal verification | Optional clean remote verification after explicit source-upload approval |
| Team console | Hosted dashboard for contracts, drift, rescue runs, device invitations, and audit events |
| Other package managers | Recognised and reported honestly. They are not advertised as native rescue support. |

## Safety rules

- Rescue writes only project-local state such as `node_modules`, `.venv`, and `.iwomc`.
- Rescue does not edit tracked files.
- Rescue does not install global packages or change the machine's PATH.
- Secret values never enter a contract, receipt, dashboard upload, or Claude-Mem observation.
- If a secret is required, IWOMC reports its name and stops.
- `iwomc promote` creates a reviewable repository diff so the next developer does not need a rescue.

## Run from source

Requires Node 22.5+ and Git.

```bash
git clone https://github.com/Carldtitan/Environment_Drift.git
cd Environment_Drift
pnpm install
pnpm run build
node apps/cli/dist/bin.js --help
```

The public `iwomc` npm release is packaged, but it is **not published yet**. The current package registry authentication is unresolved, so this README does not pretend otherwise.

## Judge demo

Show one real failure and one real proof:

1. A working npm checkout has a direct package installed in `node_modules` but absent from `package.json`.
2. `iwomc capture` identifies the undeclared package and creates a signed contract.
3. A clean clone fails with the real missing-module error.
4. `iwomc rescue --approve` applies the project-local repair and runs the app's proof command.
5. The proof passes. `git status` remains clean.
6. `iwomc promote` shows the exact `package.json` diff that prevents the next failure.

This is not a scripted product response. The CLI reads the checkout, performs the package action, and uses the project's own command as the proof.

## Documentation

- [Project author guide](docs/project-author.md)
- [Team administration guide](docs/team-admin.md)
- [Agent and MCP workflow](docs/agent-workflow.md)
- [Support matrix](docs/capability-matrix.md)
- [Security model](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)

## Hosted console

[Open IWOMC Rescue Console](https://iwomc-web-production.up.railway.app)

The dashboard is useful after a device has joined a workspace and published a capture. It intentionally shows honest empty states before that happens.

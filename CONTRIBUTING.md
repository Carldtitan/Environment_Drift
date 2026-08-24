# Contributing to IWOMC

Thanks for looking. This page covers how to run the project, how it's laid out,
and the few rules it holds itself to.

## Getting set up

```bash
pnpm install
pnpm run build
pnpm run verify
```

`verify` runs everything CI runs: typecheck, the documentation checks, a secret
scan, and the full test suite. It takes a few minutes because the tests do real
work — see below.

Requirements: Node.js 22.5 or newer, pnpm, and Git. No Docker.

## How the code is laid out

```
packages/
  contracts/      the data model: contract shapes, signing, redaction, states
  adapters/       one module per ecosystem (npm, python, plus recognition)
  companion/      the local service: capture, rescue, verify, the package log
  control-plane/  the shared server: workspaces, devices, jobs, audit
  integrations/   outside services behind interfaces (Claude-Mem, Modal, GitHub)
  testkit/        builds real repositories and sandboxes for tests
apps/
  cli/            the `iwomc` command, the MCP server, and `iwomc serve`
  console/        the web dashboard
tests/            end-to-end tests that drive the built CLI and a real browser
```

The CLI, the MCP server, and the web dashboard all call the same Companion
methods. None of them re-implements the workflow, so a tool result and a command
result cannot disagree. If you're adding behaviour, add it to `companion` and
let the three surfaces render it.

## How tests work here

There are two suites:

- **`unit`** — fast, no network, no package managers.
- **`e2e`** — builds actual Git repositories, runs actual installs, starts
  actual servers, and drives Chromium.

```bash
pnpm vitest run --project unit
pnpm vitest run --project e2e
```

The end-to-end tests are deliberately real. A passing run means the workflow
works, not that the mocks agree with each other. That makes them slower, and
it's the trade this project wants.

Two tests skip themselves unless you opt in with credentials, and say so out
loud rather than substituting a stub: the live Modal sandbox tests.

## Adding support for a package manager

This is the most useful contribution and the most self-contained. Read
[docs/adapters.md](docs/adapters.md); `packages/adapters/src/npm.ts` and
`python.ts` are the two reference implementations.

The one rule that shapes an adapter: **never run a command just because a file
with a familiar name exists.** Detection, reading declared state, and taking
inventory are filesystem reads. A command runs only for a step the adapter
compiled and a person or policy approved.

An adapter also declares its own support level, and `pnpm run capability-matrix`
regenerates [docs/capability-matrix.md](docs/capability-matrix.md) from those
declarations. Claiming a capability you haven't implemented will fail the
checks, which is the point.

## The rules this project holds itself to

These are enforced by scripts in `scripts/`, not just by convention:

1. **Nothing is faked.** No sample data, no placeholder teammates, no green
   check that isn't backed by a real result. `pnpm run honesty` fails a build
   that introduces one.
2. **`working` comes from your command.** IWOMC reports success only when the
   project's own proof command exits as expected. Installing is not success.
3. **Support levels are truthful.** An ecosystem IWOMC can only observe is
   labelled `observe only`, never quietly listed as supported.
4. **Secrets are names, never values.** `pnpm run secret-scan` uses the
   product's own classifier against the repository.
5. **Rescue never edits a tracked file.** It writes to project-local folders
   only. Changing the repository is a separate, reviewed step (`promote`).
6. **Every requirement maps to code and a test.** `pnpm run trace` fails when
   [docs/traceability.md](docs/traceability.md) drifts from the tree.
7. **Nothing is chosen arbitrarily on a team.** Which contract gets applied,
   and which device runs work, are decided on stated rules — evidence and
   platform for the first, and locality then recency for the second — never on
   whichever row a query happened to return first. On a team of one those look
   identical; on a team of ten they are not.

If a change makes one of these harder to keep, that's worth discussing in an
issue before writing the code.

## Continuous integration

`.github/workflows/verify.yml` runs the same commands you run locally. It is
split in two so feedback arrives in the right order:

- **checks** — types, the documentation checks, the secret scan, and the unit
  tests. About a minute, and it catches most mistakes.
- **end-to-end** — the real tests, on Linux *and* Windows. Windows has its own
  rules for spawning `.cmd` shims and for what a filesystem watch reports, and
  both have produced real bugs in this project, so it is not optional.

## Pull requests

- Keep the diff focused; one behaviour per PR is easiest to review.
- Add a test that would fail without your change. For anything touching
  capture, rescue, or the package log, prefer an end-to-end test — those are the
  ones that catch real breakage.
- Run `pnpm run verify` before pushing.
- Match the surrounding code. Comments here explain *why* a thing is the way it
  is, not what the line does; if a decision was non-obvious, say what the
  alternative would have broken.

## Reporting a bug

Include the output of `iwomc doctor`, the command you ran, and what you
expected. If it involves a specific ecosystem, the manifest and lockfile shape
matter more than the package names.

For anything security-sensitive, see the reporting section in
[docs/security.md](docs/security.md).

# Requirement traceability

Every requirement in `specs/iwomc-rescue/requirements.md` maps to the module
that implements it and the test that proves it. `pnpm run trace` fails when a
requirement has no implementation reference, no test reference, or names a file
that does not exist.

| Req | What it demands | Implementation | Tests |
| --- | --- | --- | --- |
| R1 | Workspace, person, project, and device identity | `packages/companion/src/identity.ts`, `packages/companion/src/project.ts`, `packages/control-plane/src/service.ts` | `packages/companion/src/companion.test.ts`, `packages/control-plane/src/control-plane.test.ts` |
| R2 | Invitations and access | `packages/control-plane/src/service.ts`, `packages/control-plane/src/store.ts` | `packages/control-plane/src/control-plane.test.ts`, `tests/console-e2e.test.ts` |
| R3 | Agent and CLI experience | `apps/cli/src/cli.ts`, `apps/cli/src/mcp.ts`, `apps/cli/src/agent-docs.ts` | `tests/mcp-e2e.test.ts`, `tests/rescue-e2e.test.ts` |
| R4 | Evidence capture | `packages/companion/src/capture.ts`, `packages/adapters/src/npm.ts`, `packages/adapters/src/python.ts` | `tests/rescue-e2e.test.ts`, `packages/adapters/src/adapters.test.ts` |
| R5 | Environment contracts | `packages/contracts/src/types.ts`, `packages/contracts/src/schemas/index.ts`, `packages/contracts/src/validate.ts` | `packages/contracts/src/contracts.test.ts` |
| R6 | Drift and repair | `packages/companion/src/promote.ts`, `packages/adapters/src/diff.ts` | `tests/rescue-e2e.test.ts` |
| R7 | Rescue execution | `packages/companion/src/rescue.ts`, `packages/companion/src/materialize.ts`, `packages/companion/src/proof.ts` | `tests/rescue-e2e.test.ts`, `tests/negative-e2e.test.ts`, `packages/companion/src/companion.test.ts` |
| R8 | Clean verification with Modal | `packages/integrations/src/modal.ts`, `packages/companion/src/verify-local.ts`, `packages/integrations/src/budget.ts` | `packages/integrations/src/modal.test.ts`, `tests/modal-live.test.ts`, `tests/rescue-e2e.test.ts` |
| R9 | Claude-Mem integration | `packages/integrations/src/claude-mem.ts`, `packages/companion/src/ports.ts` | `packages/integrations/src/claude-mem.test.ts` |
| R10 | Dashboard | `apps/console/src/app.tsx`, `apps/console/src/routes/overview.tsx`, `packages/control-plane/src/server.ts` | `tests/console-e2e.test.ts` |
| R11 | Adapter coverage | `packages/adapters/src/registry.ts`, `packages/adapters/src/types.ts`, `packages/adapters/src/generic.ts` | `packages/adapters/src/adapters.test.ts` |
| R12 | Security, privacy, and audit | `packages/contracts/src/redaction.ts`, `packages/contracts/src/crypto.ts`, `packages/companion/src/store.ts`, `packages/control-plane/src/postgres.ts` | `packages/contracts/src/contracts.test.ts`, `packages/control-plane/src/control-plane.test.ts`, `packages/companion/src/companion.test.ts` |
| R13 | UX and accessibility | `apps/console/src/styles.css`, `apps/console/src/components/signal-grid.tsx`, `apps/cli/src/render.ts` | `tests/console-e2e.test.ts` |

## Beyond the specification

The package event log is not in `specs/iwomc-rescue/requirements.md`; it was
added afterwards. It is listed separately rather than as an invented `R14`, so
the table above keeps mirroring the spec exactly.

| Capability | What it demands | Implementation | Tests |
| --- | --- | --- | --- |
| Package event log | Install, upgrade, downgrade, and removal recorded against a revision and an honest observation window | `packages/companion/src/timeline.ts`, `packages/companion/src/watch.ts`, `packages/companion/src/store.ts` | `packages/companion/src/timeline.test.ts`, `packages/companion/src/watch.test.ts` |
| Point-in-time queries | What was installed at an instant or a revision, with unobserved revisions refused rather than estimated | `packages/companion/src/history.ts`, `apps/cli/src/cli.ts`, `apps/console/src/routes/timeline.tsx` | `tests/timeline-e2e.test.ts`, `tests/console-e2e.test.ts` |
| Log-informed capture | A contract that pins the versions the machine settled on, including a downgrade | `packages/companion/src/capture.ts`, `packages/companion/src/companion.ts` | `tests/timeline-e2e.test.ts` |
| Memory timeline merge | Claude-Mem narration read back beside the deterministic record, never in place of it | `packages/integrations/src/claude-mem.ts`, `packages/companion/src/ports.ts` | `packages/integrations/src/claude-mem.test.ts`, `tests/console-e2e.test.ts` |
| Version mismatch | A declared package installed at a version the lockfile would not produce, pinned so a rescue reproduces it | `packages/adapters/src/npm.ts`, `packages/adapters/src/python.ts` | `packages/adapters/src/adapters.test.ts`, `tests/rescue-e2e.test.ts` |
| One recorder per project | A change recorded once, whichever process notices it, with a lease released promptly when a recorder dies | `packages/companion/src/store.ts`, `packages/companion/src/watch.ts` | `packages/companion/src/watch.test.ts` |
| Contract selection on a team | The applied contract is the one with the most evidence that can run here, never merely the newest | `packages/companion/src/choose-contract.ts`, `packages/companion/src/companion.ts` | `packages/companion/src/choose-contract.test.ts` |
| Machine agreement | Where several teammates' captures of one revision differ, compared only within a platform | `packages/companion/src/agreement.ts`, `apps/console/src/components/team-agreement.tsx` | `packages/companion/src/agreement.test.ts`, `tests/console-e2e.test.ts` |
| Repository identity without a remote | Two local-only repositories are two projects, and a binding survives gaining a remote | `packages/companion/src/git.ts`, `packages/companion/src/project.ts` | `packages/companion/src/companion.test.ts` |

## Deliberate deferrals

These are named in `specs/iwomc-rescue/tasks.md` as future work and are not
implemented here. None of them is faked:

- automatic merging of contract changes across branches;
- a native materializer for every recognised ecosystem;
- a secrets vault or automatic sharing of secret values;
- replication of production databases and SaaS configuration;
- remote desktop or visual GUI testing in Modal;
- running arbitrary agent-generated shell commands outside typed or reviewed
  steps.

## Blocked only by missing credentials

Implemented behind an interface with configuration validation, an honest
unavailable state, and tests; not exercisable in this build:

| Capability | Interface | What is missing |
| --- | --- | --- |
| GitHub sign-in and private source access | `packages/integrations/src/github.ts` | A GitHub App: `IWOMC_GITHUB_APP_ID`, `IWOMC_GITHUB_APP_CLIENT_ID`, `IWOMC_GITHUB_APP_PRIVATE_KEY` |
| Durable Postgres for the control plane | `packages/control-plane/src/postgres.ts` | `IWOMC_DATABASE_URL` and a provisioned database |
| Off-device artifact storage | `packages/companion/src/config.ts` | `IWOMC_OBJECT_STORE_*` |
| Claude-Mem worker | `packages/integrations/src/claude-mem.ts` | A running local Claude-Mem worker |

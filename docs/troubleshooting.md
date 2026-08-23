# Troubleshooting

Every stop IWOMC makes carries a machine-readable code and one concrete next
action. This is the full list. Nothing here is a mystery state.

Run `iwomc doctor` first: it reports local checks, verifier availability,
durable-memory status, and every integration's exact missing configuration
value.

---

## Terminal states

| State | What it means | Exit code |
| --- | --- | --- |
| `working` | The proof command passed on this checkout. | 0 |
| `failed` | Work was done, but the project still does not pass its own check. | 1 |
| `blocked` | A precondition was not met. Nothing was changed. | 2 |
| `unsupported` | IWOMC has no approved way to materialize this project. | 3 |
| `inconclusive` | The run could not determine whether the project works. | 4 |

`working` comes only from a passing proof command. A successful install with a
failing proof is `failed`, always.

---

## Blocker codes

### Binding and revision

**`no_project_binding`** — this checkout is not registered.
Run `iwomc init` in the directory. IWOMC binds a project to a Git remote
fingerprint and a subdirectory, not to a path.

**`remote_mismatch`** / **`subdirectory_mismatch`** — the checkout points at a
different repository or a different subdirectory than the binding.
Re-run `iwomc init` from the correct directory.

**`no_contract_for_revision`** — no contract exists for this exact commit, or a
declared file differs from the captured source.
Either check out the revision the contract names, or apply a nearest contract
deliberately: `iwomc rescue --contract <id>`. IWOMC will not choose for you.

If the message names specific files, they differ from the captured source.
`git status` and `git diff` will show why. IWOMC compares Git's canonical blob
content, so line-ending settings are not the cause.

### Trust

**`signature_missing`** / **`signature_invalid`** — the contract is unsigned, was
modified after signing, or was signed by a key this device does not trust.
Nothing is applied and a `security.contract_rejected` audit event is written.
Fetch the contract again, or capture a new one on a working checkout.

**`device_revoked`** — an owner or maintainer revoked this device.
Ask them to re-invite it, then `iwomc join <invitation>`.

**`workspace_forbidden`** — the record belongs to another workspace.

### Environment

**`missing_runtime`** — a runtime the contract requires is absent, or its version
does not satisfy the range. The message names both.

**`missing_system_tool`** — a required tool is not on `PATH`. IWOMC does not
install system tools; that is a deliberate human action.

**`missing_secret`** — a required secret is not set in your environment. The
message names it. IWOMC never copies secret values between machines: get the
value from your team's secret store and set it yourself, then rescue again.

**`insufficient_disk_space`** — less than the required free space on the
checkout's volume.

### Support and approval

**`unsupported_ecosystem`** — no adapter in this build can materialize the
project, or the contract names an adapter this build does not have.
See [capability-matrix.md](capability-matrix.md). Options: add a reviewed setup
recipe, or contribute a native adapter.

**`recipe_not_reviewed`** — the contract contains a setup command that has not
been reviewed, or whose text changed after review.
A maintainer must review the current command before it may run.

**`contract_not_approved`** — the contract is still a candidate.
Run `iwomc verify` to check it in a fresh directory, or `iwomc approve <id>` to
accept it as it is.

**`approval_required`** — the contract's policy requires explicit confirmation.
Re-run with `iwomc rescue --approve`, or approve it in the console. Through MCP,
pass `confirm: true`.

**`policy_denied`** — a step tried to do something the policy forbids, such as
writing outside `.iwomc/` or over a Git-tracked path. Reject the contract; this
is a defect in whatever produced it.

### Execution

**`step_failed`** — a materialization step exited unexpectedly. The step output
is in the run events above the blocker.

**`proof_failed`** — the environment was prepared and the project's own check
still did not pass. This is usually a code or configuration problem, not an
environment one.

**`proof_timeout`** — the proof did not finish in time. Raise the timeout with
`iwomc proof "<command>" --proof-timeout <ms>`, or fix what is hanging.

**`proof_not_configured`** — no proof command is set, so IWOMC cannot report
that anything works. Set one: `iwomc proof "npm test"`.

**`interrupted`** — a run stopped partway. Run it again: journalled steps are
skipped and the run resumes.

### Integrations

**`integration_unavailable`** — a required service is not reachable or not
configured. `iwomc doctor` names the missing value.

**`budget_exhausted`** — clean verification would exceed the configured USD
ceiling, or a single run would exceed the per-run cap. Raise
`IWOMC_MODAL_BUDGET_USD`, or lower the sandbox timeout, CPU, or memory.

**`request_expired`** — a console job expired before the device picked it up.
Request it again; the device must be running `iwomc serve` or polling.

**`worktree_dirty`** — a capture from a dirty worktree stays local-only and
cannot become a team baseline. Commit or stash, then capture again.

---

## Situations that are not blockers

**"Memory disconnected"** — the Claude-Mem worker is not running. IWOMC keeps
working; only the explanatory history is missing. Nothing about capture,
verification, or rescue depends on it.

**"Modal clean verifier was skipped"** — Modal is available but not applicable
to this contract, usually because the project has not approved sending source to
a remote verifier. Capture with `--allow-source-upload` if you want that, or
stay with local verification, which is a real check and is labelled
`locally checked`.

**"GitHub sign-in is not configured"** — expected without a GitHub App. Local
mode works fully; you just cannot invite people to a shared workspace with a
GitHub identity.

**`ExperimentalWarning: SQLite is an experimental feature`** — Node's own notice
about `node:sqlite`. It is harmless.

---

## When rescue says `working` but you disagree

Read the proof command: `iwomc status --json | ...` shows it. `working` means
exactly "that command exited as expected in that directory". If that command is
not a good test of your project, change it — that is the one number IWOMC's
honesty depends on.

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
Run `iwomc init` in the directory. IWOMC identifies a project by its repository
and subdirectory, not by its path, so you can move or re-clone a checkout and
it stays the same project. With a Git remote, the remote is the fingerprint.
Without one, the repository's first commit is used instead — two local-only
repositories are two different projects, not one.

**`remote_mismatch`** / **`subdirectory_mismatch`** — the checkout points at a
different repository or a different subdirectory than the binding.
Re-run `iwomc init` from the correct directory.

You will also see `remote_mismatch` when a contract exists for your exact
commit but was captured against a different remote — usually because one side
was cloned from a local folder rather than the shared remote. Point both at the
same remote, or apply it deliberately with `iwomc rescue --contract <id>`.

**`invalid_input`** — something you passed cannot be read as what it should be,
such as `--at yesterday` where a date and time is expected.
The message names the flag and shows the shape it wants. IWOMC refuses rather
than answering from a value it had to guess at.

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

**"This revision was never observed here"** — the package log has no record of
that Git revision on this device. Either it was never checked out here, or
`iwomc watch` was not running while it was. IWOMC will not answer from a nearby
revision, because a confident wrong answer about someone's machine is the
failure it exists to prevent. Ask the person whose checkout worked to capture a
contract at that revision.

**"The watcher was not running for N of this period"** — a normal, honest
report. Changes made while the watcher was down are still found by the next
sweep, but their timing is only as precise as the gap, and a change that was
made and then undone inside it is invisible. Keep `iwomc watch` running, or
start it from your shell profile.

**"Already being watched"** — a resident `iwomc watch` already holds this
project on this device, so a second recorder stopped rather than starting.
Nothing is missing: the running one is keeping the log. Only one recorder per
project may write, because two would each notice the same install from their
own last reading and record it twice, at two slightly different moments. The
same reason is why `iwomc sweep` reports "not recorded here" while a watcher is
running — the reading it shows you is still current.

If the recorder was killed rather than stopped, the next command takes over at
once: IWOMC checks whether the process is still alive rather than waiting out
its heartbeat.

**"This revision is covered for macos/x64, but not for windows/x64"** — your
teammates captured this commit on a different kind of machine. A contract
records the platform it was captured on, and IWOMC will not apply one to a
platform it was never observed on. Someone on your platform needs to run
`iwomc capture` at this revision.

**"Every contract for this revision has been rejected or revoked"** — the
contracts exist, and someone withdrew them. That is a decision, not an
absence: ask why before capturing a replacement.

**"N captures of this revision disagree"** — two or more teammates captured the
same commit and their machines differ. Nothing is broken yet; this is the
warning that arrives first. Look at which package differs and who holds the
minority answer. IWOMC will not decide who is right, and applies the contract
with the most evidence behind it in the meantime.

**"already applied, skipped" during a rescue** — IWOMC records each step it
completes so an interrupted rescue resumes instead of repeating work. It only
reuses work done in *that same directory*: a second checkout of the same
project starts from nothing, because nothing has been applied to it.

**A timeline with no changes** — the log records changes, not the initial
state. The first observation of a project establishes a baseline and emits no
events, because claiming every already-installed package arrived the instant
IWOMC started would date the whole tree wrongly.

---

## When rescue says `working` but you disagree

Read the proof command: `iwomc status --json | ...` shows it. `working` means
exactly "that command exited as expected in that directory". If that command is
not a good test of your project, change it — that is the one number IWOMC's
honesty depends on.

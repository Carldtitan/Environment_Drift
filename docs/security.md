# Security model

## Trust boundaries

| Boundary | May hold | Never holds |
| --- | --- | --- |
| Local Companion | raw local process data, the device private key, short-lived secret handles | an uploaded private key, unredacted secrets in any outbound payload |
| Control plane | workspace metadata, signed contracts, redacted artifacts, audit | plaintext secret values, local filesystem paths |
| Clean verifier | the exact approved source and contract | your home directory, permanent credentials |
| Durable memory | redacted narrative facts and IWOMC record references | secret values, host inventories, any authority to mutate |
| Browser | rendered workspace data and user intent | filesystem access, device credentials, MCP transport |

## Secrets

IWOMC reads environment-file **names**. Values are read once, in memory, for a
single purpose: to seed the local redactor so they can be recognised and removed
if they ever appear in captured output.

A contract carries `{ name, scope, required, reference?, validationHint? }`. The
JSON Schema sets `additionalProperties: false`, so a `value` field cannot exist,
and `assertNoSecretValues` additionally scans every string in a contract for
credential-shaped material before it can be sealed.

When a rescue needs a secret, it stops **before** the proof and names it. The
teammate gets the value from their own secret store. There is no path by which
one machine's secret value reaches another.

## Redaction

One classifier (`packages/contracts/src/redaction.ts`) guards every outbound
payload. It removes private-key blocks, credentials in URLs, authorization
headers, bearer tokens, JWTs, known vendor token shapes, values behind
secret-looking keys, high-entropy blobs, and any literal value the local
redactor was told about.

It **fails closed**: `assertRedacted` refuses to send a payload that still
contains anything it recognises, rather than sending a partially cleaned one.
The Claude-Mem writer uses it on every observation, with the project-aware
redactor when the caller has one.

`pnpm run secret-scan` turns the same classifier inward on the repository.

## Signatures

Every device generates an Ed25519 keypair locally. The private key is sealed
with AES-256-GCM into the device's SQLite store, under a key held in a `0600`
file next to it. It is never uploaded, printed, or placed in a contract.

- A **local-only** contract is signed by the device that authored it.
- A **shareable** contract is re-signed by the service after policy validation.

Contracts are content-addressed over RFC 8785 canonical JSON, so field order and
number formatting cannot change a digest. Before any local mutation, rescue
checks the digest, the project scope, the absence of secret values, recipe
review integrity, and the signature — and records a `security.contract_rejected`
audit event when any of that fails.

## Command execution

No `shell: true` anywhere. Commands are argv arrays passed to a resolved
executable. The tokenizer that turns a human's typed command into argv refuses
shell operators outright, so a value in a contract can never become syntax.

On Windows, Node refuses to spawn `.cmd` and `.bat` files directly because
`cmd.exe` re-parses arguments. IWOMC parses the shim, resolves the Node script
it delegates to, and runs that instead. Where no such script exists it builds a
`cmd.exe` command line with C-runtime quoting, and refuses any argument
containing `%`, for which no reliable escape exists.

## The background recorder

`iwomc watch` is the only part of IWOMC that runs unattended, so its limits are
narrower than everything else's.

- It reads only inside bound project directories: `node_modules` and the
  project-local virtual environment. Not the home directory, not the global
  package cache, not another project.
- It executes nothing. The probe runner handed to adapters during a sweep
  refuses to spawn, so no adapter - present or future - can turn a resident
  daemon into a command runner.
- It writes only to the encrypted local store. It never touches a repository
  file, and the log is never uploaded to the control plane.
- Event payloads are sealed with the same AES-256-GCM key as receipts and
  contracts, because a list of a developer's dependencies over time is
  machine-identifying material.
- It does not inspect the process table. A change is attributed to a command
  only when a coding agent reports that command; otherwise the event records
  what changed and when, and says nothing about why.

Only one recorder per project may write to the log, so a change is never
recorded twice. The claim is held by the running session and released when it
stops; if the process was killed instead, the next command checks whether that
process still exists and takes over immediately rather than waiting.

Every answer derived from the log reports the periods the watcher was not
running. An open watch session is treated as covering time only up to its last
heartbeat, so a watcher that was killed stops vouching for the hours after it
died.

## Rescue's blast radius

- Writes are confined to `.iwomc/` and project-local environment directories.
- Any step targeting a Git-tracked path is refused.
- Declared-file digests are compared before and after materialization; if a
  tracked file changed, the run fails and names it.
- Steps are journalled, so an interrupted rescue resumes rather than repeating.
  The journal is scoped to the directory the work was done in, so a second
  checkout of the same project is never treated as already prepared.
- An install that would create a lockfile where the repository keeps none is
  told not to, so a rescue leaves no file the project did not have.

## Audit

Every meaningful action writes an immutable, hash-chained event on the device
and, in team mode, in the control plane. Each event carries the digest of the
one before it, so a deletion or rewrite is detectable. `iwomc doctor` verifies
the local chain; the console's Settings screen shows the shared one.

## Bounds

Process output is capped and redacted before storage. Every step and the proof
command carry timeouts. Clean verification is bounded by CPU, memory,
wall-clock timeout, retries, and a USD ceiling enforced against an append-only
ledger *before* a sandbox is created — a run whose worst case exceeds the
remaining budget never starts.

## What IWOMC does not defend against

- A malicious contract from a workspace you chose to trust. Signatures prove
  origin, not intent; that is what recipe review is for.
- A compromised package registry. IWOMC installs what a lockfile names.
- Someone with write access to your device's `~/.iwomc` directory.

## Reporting

The fastest useful report includes the blocker code, `iwomc doctor --json`
output, and the contract digest. None of those contains a secret value.

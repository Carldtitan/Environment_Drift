# Setting a project up

The work is small: bind the project once, and choose the command that decides
whether it works.

## 1. Bind the project

```bash
cd path/to/checkout
iwomc init --proof "npm test"
```

`init` records a **project binding**: your Git remote's canonical fingerprint
plus the repository-relative subdirectory. It stores no path anywhere that
leaves your machine, and it changes nothing in the repository.

## 2. Choose a proof command

This is the one decision that matters. `working` means exactly "this command
exited as expected", so choose something that would actually fail on a broken
environment.

Good choices: your test command, your build, a smoke script, a health check.

```bash
iwomc proof "npm test"
iwomc proof "pytest -q"
iwomc proof "node ./scripts/smoke.mjs" --proof-timeout 120000
```

The command is tokenized, never handed to a shell. Pipes, redirection, `&&`,
command substitution, and backticks are refused — write a script and call the
script.

If the proof needs an environment variable, name it:

```bash
iwomc proof "npm test" --env DATABASE_URL,REDIS_URL
```

Only the names you list are passed through, plus what any process needs to run
at all. IWOMC never stores their values.

## 3. Capture from a checkout that works

```bash
iwomc capture
```

Capture reads declared state and inventories project-local installs. It runs no
package-manager command and modifies nothing.

A capture from a **clean worktree** can become a team baseline. A capture from a
dirty worktree stays local-only, and says so.

## 4. Prove the contract

```bash
iwomc verify
```

This clones your repository into a temporary directory, checks out the exact
revision, applies the contract, runs the proof there, and deletes the directory.
A directory that has never had a `node_modules`, a `.venv`, or a `.env`.

Passing makes the contract **locally checked**. That is the state a teammate's
`iwomc rescue` will accept.

To allow clean verification in a disposable remote sandbox, the project has to
approve sending its source there:

```bash
iwomc capture --allow-source-upload
```

Without that, IWOMC skips the remote verifier and says why. It does not upload
source on its own initiative.

## 5. Keep the repository honest

If capture found something installed that the repository does not declare:

```bash
iwomc promote          # show the diff
iwomc promote --apply  # write exactly those files
```

Review it, commit it, then capture and verify again. A rescue makes one checkout
work; a promotion means the next developer never needs one.

## Secrets

IWOMC reads environment-file **names** and records them as requirements. It
never reads a value into a contract, a receipt, or an upload.

Commit a `.env.example` naming what the project needs. Names that appear there
are marked required, so a rescue stops with the exact missing name instead of
failing halfway through a test run.

## Monorepos

A binding is a remote fingerprint plus a subdirectory, so each package in a
monorepo is its own project. Run `iwomc init` in each directory you want to be
able to rescue.

## What IWOMC will not do for you

- Install system packages, Homebrew formulae, or global toolchains.
- Change your shell profile, your `PATH`, or any machine-wide setting.
- Recreate a database, a SaaS account, or an OAuth application.
- Edit a tracked file during a rescue.

Each of these is reported as a named requirement, so a teammate knows exactly
what to do — which is more useful than a silent partial success.

# Driving IWOMC as a coding agent

You are the second reader of this product. Everything a person can do from the
terminal, you can do with a typed tool, and both go through the same Companion
service, so a tool result and a command result cannot disagree.

## Connect

Register the local MCP server as a stdio server running:

```
iwomc mcp
```

On `initialize` it returns the full workflow as `instructions`. It also
publishes two resources:

- `iwomc://agent-guide` — the versioned workflow description
- `iwomc://commands` — every CLI command with effects, approval rules, flags,
  and exit codes

Both are generated from the same metadata the CLI uses. Read one instead of
guessing.

## The loop

1. **`environment_status`** — read-only. Answers whether this checkout can be
   rescued now, which contract applies to the exact revision, the truthful
   ecosystem support level, and which integrations are actually connected.
2. **`rescue_environment`** with `confirm: true` — applies the contract and runs
   the proof command.
3. If the result is not `working`, read `blocker.nextAction` and do exactly
   that. Do not improvise an install command; that is the failure mode this
   product exists to prevent.
4. **`promote_repair`** — when a rescue worked but the repository still does not
   declare what it needed. Without `confirm` it returns a diff and writes
   nothing.

On a checkout that already works, **`capture_environment`** records the evidence
and **`verify_contract`** checks it in a fresh directory.

## Rules you can rely on

- `working` is produced only by a passing proof command. Installing is not
  success, and IWOMC will not say otherwise.
- Rescue creates project-local state only. It never edits a tracked file.
- Contracts carry secret **names**. There is no mechanism by which a secret
  value could reach you.
- A contract binds to one exact Git revision. A nearest-revision contract is a
  suggestion that needs an explicit `contractId`.
- Every mutating tool refuses without `confirm: true`. That refusal is a
  `blocker` with code `approval_required`, not an error to route around.

## Reading a result

Every tool returns `structuredContent`. A blocked or failed call sets
`isError: true` and returns:

```json
{
  "blocker": {
    "code": "missing_secret",
    "message": "Required secret(s) are not set in this environment: DATABASE_URL.",
    "nextAction": "Set DATABASE_URL from your team's secret store, then run rescue again. IWOMC never copies secret values between machines."
  }
}
```

`code` is stable and enumerable; branch on it. `message` states what happened.
`nextAction` is what to tell the person you are helping — repeat it, do not
paraphrase it into something more optimistic.

## What to tell the human

- On `working`: name the proof command that passed and the number of steps
  applied. That is the whole claim.
- On `failed`: the environment was prepared; their project's own check did not
  pass. Show the proof output.
- On `blocked`: repeat `nextAction` verbatim. Most blockers need a human
  decision or a credential you must not invent.
- On `unsupported`: IWOMC recognised the ecosystem but has no approved way to
  materialize it. Do not offer to "just run the install command" — an unreviewed
  command is exactly what a contract exists to replace.

## From the shell instead

Every command takes `--json`:

```bash
iwomc status --json
iwomc rescue --json --approve
iwomc promote --json          # preview
iwomc promote --json --apply  # write the reviewed diff
```

Exit codes: `0` working/ok, `1` failed, `2` blocked, `3` unsupported,
`4` inconclusive, `64` usage error.

# IWOMC Rescue — product truth

> Authored from the written brief and `specs/iwomc-rescue/*`. The person who
> commissioned this was unavailable while it was built, so no interview round
> was run; every statement below is traceable to the brief or the specification,
> and nothing here is inferred taste.

## What it is

A teammate pulls agent-written code and it does not run on their machine.
IWOMC applies an approved, project-local **environment contract** captured from
a checkout where it *did* run, then proves the result by running the project's
own proof command.

Two commands carry the product:

```
iwomc capture    # on a checkout that works
iwomc rescue     # on a checkout that does not
```

## The mechanism, in one sentence

Docker runs the setup a developer wrote down; IWOMC finds the setup an agent
actually used and the repository forgot to write down, and proves a repair.

## Who uses it

Small teams — hackathon teams and early-stage teams using coding agents — where
one person's checkout works, another's does not, and the difference is not in
the repository. Both a human at a terminal and a coding agent through MCP are
first-class users; they see the same states and the same words.

## What it must never do

1. Claim `working` without a passing proof command.
2. Edit a tracked file during rescue.
3. Copy a secret value between machines. Contracts carry secret **names** and
   optional vault references only.
4. Show a connected integration because an environment variable exists.
5. Claim native support for an ecosystem it has not implemented.
6. Require Docker.

## The states the product speaks in

Rescue: `working` · `blocked` · `failed` · `unsupported` · `inconclusive`
Assurance: `clean verified` (Modal) · `locally checked` (fresh directory here) ·
`unverified`
Support: `native` · `recipe` · `observe only`

Every stop has a machine-readable blocker code and exactly one next action.

## Surfaces

| Surface | Mode | Job |
| --- | --- | --- |
| `iwomc` CLI | Operate | A person drives capture, verify, rescue, promote from a terminal. |
| Local MCP server | Operate | A coding agent drives the same services with typed tools. |
| Rescue Console (hosted) | Operate | A team sees which contract is current, whether a checkout can be rescued now, and asks a device to do it. |

## Brand commitments

- The console's visual world is pinned by the brief: warm oat and ivory canvas,
  espresso navigation, terracotta as the single action colour, sage for ready,
  restrained evidence surfaces, strong typography, calm density.
- IWOMC's own motif is a **signal grid**: four squares standing for declared,
  observed, locally checked, and clean verified. It is the product mark, the
  contract state indicator, and the assurance chip.
- TraceCase is visual reference only. Its screens, wording, brand mark, and
  case/investigation vocabulary are not reused.

## What is real today

- Native adapters: npm, pip, uv — detection, declared state, inventory,
  project-local materialization, verification.
- Recognition (not support) for 25 further managers, each with a stated,
  truthful support level.
- Local fresh-directory verification, producing a real `locally checked`
  attestation.
- A Modal clean verifier behind a budget ceiling and a source-upload policy.
- Claude-Mem lifecycle observations through the documented local worker API.

## What is honestly unavailable

GitHub App sign-in, Postgres, and the object store have no credentials in this
build. Each is implemented behind its interface with configuration validation
and an explicit unavailable state; none is replaced by a mock that could read as
connected.

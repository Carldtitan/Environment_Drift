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

A contract describes one revision. Underneath it, a background recorder keeps
an append-only log of what was installed, upgraded, downgraded, or removed, and
when - so IWOMC can also answer a question a snapshot cannot:

```
iwomc watch                       # record changes as they happen
iwomc timeline <commit>           # what was installed while that revision was checked out
iwomc diff <theirs> <yours>       # what separates the two
```

The log feeds capture, so a contract pins the versions the machine actually
settled on - including a downgrade, which a snapshot has no way to express.

## The mechanism, in one sentence

Docker runs the setup a developer wrote down; IWOMC finds the setup an agent
actually used and the repository forgot to write down, and proves a repair.

## Who uses it

Any team where one person's checkout works, another's does not, and the
difference is not in the repository. Small teams using coding agents feel it
most, because an agent installs to unblock itself far more often than a person
does. Both a human at a terminal and a coding agent through MCP are first-class
users; they see the same states and the same words.

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
| `iwomc watch` | Record | A background loop keeps the package log current for the checkouts on this device. |

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
- Claude-Mem lifecycle observations through the documented local worker API,
  and its timeline read back beside the package log as narration.
- A device-local package event log: install, upgrade, downgrade, and removal,
  each bound to the revision that was checked out and to an honest observation
  window, with point-in-time and by-revision queries.

## Across operating systems

A contract records the platform it was captured on, and IWOMC applies it
elsewhere when nothing in it is restricted to that platform — saying so rather
than implying it was proven where it is being used. When something *is*
restricted, usually a build tool's per-platform binary, it refuses and names
the package.

## What is honestly unavailable

The package log is device-local and is not uploaded. A teammate's history
reaches you through a contract they captured and shared, not by IWOMC serving
another machine's log; a revision this device never observed is reported as
unobserved rather than estimated from a nearby one.

Attribution of a change to the command that caused it is only recorded when a
coding agent reports the command. IWOMC does not scrape the process table, so
an unattributed change carries no cause rather than a guessed one.

GitHub App sign-in, Postgres, and the object store have no credentials in this
build. Each is implemented behind its interface with configuration validation
and an explicit unavailable state; none is replaced by a mock that could read as
connected.

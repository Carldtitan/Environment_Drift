# IWOMC

**It Works On My Computer.** IWOMC finds out why, and fixes it.

[![npm](https://img.shields.io/npm/v/iwomc)](https://www.npmjs.com/package/iwomc)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

```bash
npm install -g iwomc
```

---

## The problem

Your teammate clones the same commit you just pushed. Your app runs. Theirs
doesn't.

Usually the difference isn't in the code — it's on your disk. A package that got
installed but never added to `package.json`. A version that had to be rolled
back to make something work. A Python virtual environment set up by hand three
weeks ago.

Coding agents make this much more common. An agent runs an install to unblock
itself, the app starts working, and it moves on without writing that change into
the repository. The code gets committed. The setup doesn't.

## What IWOMC does

On the machine where the project works, IWOMC compares what the repository
*says* it needs against what is actually installed, and records the difference
as a signed **environment contract** tied to that exact Git commit.

On the machine where it's broken, IWOMC applies that contract — installing only
into project-local folders, never editing a tracked file — and then runs your
project's own test or build command.

It reports `working` only when that command passes. Installing something is not
success, and IWOMC will not say otherwise.

## Quick start

Two people, one commit, one command each.

**On the checkout that works:**

```bash
iwomc init --proof "npm test"   # bind the project; name the command that proves it works
iwomc capture                   # record what this machine actually has
iwomc verify                    # re-check that record in a clean directory
```

**On the checkout that's broken:**

```bash
iwomc rescue --approve
```

That's the whole loop. `rescue` prepares the project and runs `npm test`. If the
test passes you get `working`. If something is missing that IWOMC cannot provide
— a database, an API key — it stops and tells you exactly what and why, instead
of failing halfway through a test run.

Then, so nobody hits it again:

```bash
iwomc promote           # show an ordinary diff that fixes the repository
iwomc promote --apply   # write exactly that diff
```

## Keeping a history

A contract describes one commit. It cannot tell you what was installed at 2pm
last Tuesday, and it cannot express a *downgrade* — which is often the thing
that made a project work.

So IWOMC can also record changes as they happen:

```bash
iwomc watch          # this project
iwomc watch --all    # every project registered on this machine
```

It notices the moment `node_modules` or your virtual environment changes, and
re-checks on a timer so nothing slips past. Then you can ask:

```bash
iwomc timeline                            # what's installed now, and when it arrived
iwomc timeline <commit>                   # what was installed at that commit
iwomc diff <their-commit> <your-commit>   # what's different between the two
```

The recorder reads your project's package folders and nothing else. It never
runs a package manager, never looks outside the projects you've registered,
never touches a file in your repository, and never uploads the history
anywhere.

## Two things it won't do

**It won't guess.** Ask about a commit this machine never had checked out and it
says so, rather than answering from a nearby one. Every answer also tells you
which periods it wasn't watching, because a change made and undone inside a gap
is one it genuinely cannot see.

**It won't move your secrets.** Contracts record the *names* of environment
variables a project needs, never their values. If one is missing on the broken
machine, IWOMC names it and stops before running anything.

## What it supports

Fully supported today — detects, records, repairs, and verifies:

| Ecosystem | Managers |
| --- | --- |
| Node.js | npm |
| Python | pip, uv |

IWOMC recognises 25 more: pnpm, Yarn, Bun, Poetry, Conda, Cargo, Go modules,
Maven, Gradle, NuGet, Bundler, Composer, pub, Mix, vcpkg, Conan, Homebrew, apt,
Chocolatey, winget, and the version managers asdf, mise, Volta, SDKMAN, and nvm.
For those it records what it can see and says plainly that it cannot repair them
yet — it does not claim support it doesn't have. Adding one means writing an
adapter; see [docs/adapters.md](docs/adapters.md).

## For coding agents

IWOMC ships an MCP server, so an agent can drive the same workflow with typed
tools instead of parsing terminal output:

```bash
iwomc mcp
```

Every tool states what it changes and what it needs, and anything that modifies
your machine refuses to run without explicit confirmation. Start with
[docs/agent-workflow.md](docs/agent-workflow.md), or run `iwomc agent-docs` for
the full reference offline.

## Team dashboard

`iwomc serve` runs a local web console showing which contracts exist, whether a
checkout can be rescued right now, and what changed over time. There is also a
[hosted one](https://iwomc-web-production.up.railway.app/).

Working alone needs no account and no server. Everything above runs entirely on
your machine.

## How it compares

**Docker** runs the setup someone wrote down. It cannot discover a step that
happened outside the Dockerfile. IWOMC finds the undocumented step; the two
solve different halves of the problem and work fine together.

**Lockfiles** pin what the repository declares. They cannot help with a package
installed using `--no-save`, or one rolled back by hand. IWOMC compares what is
on disk against what the lockfile would install and flags the difference.

**Committing `node_modules`** technically works and is miserable. IWOMC records
a few kilobytes of facts instead of a few hundred megabytes of files.

## Requirements

Node.js 22.5 or newer. No Docker. No account. macOS, Linux, and Windows.

## Documentation

| Guide | For |
| --- | --- |
| [Setting a project up](docs/project-author.md) | Creating and sharing a contract |
| [Agent and MCP workflow](docs/agent-workflow.md) | Driving IWOMC from a coding agent |
| [Troubleshooting](docs/troubleshooting.md) | What a message means and what to do |
| [Security model](docs/security.md) | What runs, what's stored, what's sent |
| [Adapters](docs/adapters.md) | Adding support for another ecosystem |
| [Team administration](docs/team-admin.md) | Workspaces, invitations, devices |
| [Capability matrix](docs/capability-matrix.md) | Exactly what each adapter can do |

## Contributing

Issues and pull requests are welcome.

```bash
pnpm install
pnpm run build
pnpm run verify   # typecheck, doc checks, secret scan, and the full test suite
```

The test suite builds real Git repositories, runs real installs, and drives a
real browser, so a passing run means the workflow genuinely works rather than
that the mocks agree with each other.

[CONTRIBUTING.md](CONTRIBUTING.md) covers the layout, how the tests are
organised, and the rules the project holds itself to.

## Licence

MIT — see [LICENSE](LICENSE).

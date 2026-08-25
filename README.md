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

So IWOMC records changes as they happen, without being asked. The first time
you use it in a project it starts a background recorder, tells you it has done
so, and keeps the log current from then on — because nobody starts a recorder
*before* the install that breaks their teammate. Nobody knows which install
that is until afterwards.

```bash
iwomc daemon status    # is it running, and where is its log
iwomc daemon enable    # also start it again after a reboot
iwomc daemon disable   # stop, and stop starting
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
anywhere. `iwomc daemon disable` stops it for good.

## Two things it won't do

**It won't guess.** Ask about a commit this machine never had checked out and it
says so, rather than answering from a nearby one. Every answer also tells you
which periods it wasn't watching, because a change made and undone inside a gap
is one it genuinely cannot see.

**It won't move your secrets.** Contracts record the *names* of environment
variables a project needs, never their values. If one is missing on the broken
machine, IWOMC names it and stops before running anything.

## What it supports

There are three levels, and IWOMC tells you which one applies to your project
rather than letting you find out later.

**Repaired and verified** — the full loop: detect, record, repair a broken
checkout, and prove it with your own test command.

| Ecosystem | Managers |
| --- | --- |
| Node.js | npm, pnpm, Yarn, Bun |
| Python | pip, uv, Poetry |
| Rust | Cargo |
| Go | Go modules |

Every one of these installs **inside your project folder only**. Each keeps a
machine-wide cache by default — `~/.cargo`, `~/.npm`, Go's module cache, and so
on — and IWOMC redirects every one of them into the project's own `.iwomc`
directory. A rescue never changes anything outside the checkout it was pointed
at. The cost, stated rather than hidden: a project-local cache is not shared
between projects, so the first rescue downloads what it needs again.

Two honest limits.

pnpm and Yarn cannot install a package without editing `package.json`, and a
rescue never edits a tracked file. So a package that is installed but
undeclared is reported as drift for `iwomc promote` to turn into a reviewed
change — which puts the fix in the repository rather than on one more machine.

Cargo and Go do not keep dependencies in a readable project folder the way
`node_modules` does, so IWOMC cannot list what is actually installed for them.
It repairs and verifies those projects, but it says plainly that it could not
take an inventory rather than reporting a clean check it never ran.

**Recognised** — detected and reported, so a contract never silently omits
them: Maven, Gradle, NuGet, Bundler, Composer, pub, Mix, Conda, vcpkg, Conan,
Homebrew, apt, Chocolatey, winget, and the version managers asdf, mise, Volta,
SDKMAN and nvm.

`iwomc status` names the level for the project you are in, and
[docs/capability-matrix.md](docs/capability-matrix.md) is generated from what
each adapter actually declares — not from this list. Adding a manager means
writing an adapter; see [docs/adapters.md](docs/adapters.md).

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

## Across operating systems

The lead whose machine works is often not on your operating system. IWOMC
applies their contract anyway, when it can do so honestly.

Installing the declared dependency tree is already platform-aware — `npm ci`
and `pip install` resolve the right build for the machine they run on. What is
*not* portable is a pinned package that exists for one platform only: build
tools ship their binaries that way (`@esbuild/darwin-arm64`,
`@rollup/rollup-linux-x64-gnu`), each declaring the platforms it installs on,
and Python does the same with an environment marker.

So IWOMC records that restriction when it finds one, and asks the right
question — not "was this captured here" but "does anything in it only work
there":

- Nothing restricted: the contract applies, and says it was proven on another
  platform rather than pretending otherwise.
- Something restricted: it refuses and **names the package**, instead of a
  generic platform mismatch you would have to go and diagnose.

## Requirements

Node.js 22.5 or newer. No Docker. No account. macOS, Linux, and Windows —
each of which runs the full test suite on every change.

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
